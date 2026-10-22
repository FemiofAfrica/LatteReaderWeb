import type { SpeechEngine, SpeechRequest } from './SpeechEngine'
import { localParts, type LocalPart } from './localPlan'
import { recordEvent } from '../diagnostics/diagnostics'
import type { LoadableProducer } from './chunkProducer'
import { DEFAULT_LOOKAHEAD_SECONDS, MAX_BUFFERED_SECONDS, PACK_TARGET_SECONDS, UNDERRUN_GUARD_SECONDS } from './chunkProducer'
import { KittenProducer } from './kittenProducer'
import { encodeWav, wavDuration } from './wav'
import { AudioCache, sharedAudioCache } from './audioCache'
import { cacheId, encodedKey, type EncodedChunk } from './encodedChunk'
import { packChunks, takePack } from './audioPack'
import { createPlaybackAudio, HtmlAudioQueue } from './htmlAudioQueue'
import { bindMediaSession, updateMediaPosition } from './mediaSession'
import { audioReadyProgress, emptyAudioReady, type AudioReadyProgress } from './audioReady'
import type { SpeechChunk } from '../domain/speechPlan'

export type LocalStatus = 'off' | 'preparing' | 'ready' | 'buffering' | 'playing' | 'paused' | 'error'

/**
 * How many parts in a row may fail before the run stops. One unreadable part is
 * normal and must never end a read; a voice that cannot say twenty consecutive
 * parts is broken, and reporting that as a finished document would be worse than
 * saying the voice failed.
 */
const MAX_CONSECUTIVE_SKIPS = 20

export interface LocalEngineOptions {
  lookaheadSeconds?: number
  maxBufferedSeconds?: number
  packTargetSeconds?: number
  createAudio?: () => HTMLAudioElement
  producer?: LoadableProducer
  cache?: AudioCache
}

export interface PrepareDocumentRequest {
  chunks: SpeechChunk[]
  rate: number
  documentId: string
  onProgress?: (progress: AudioReadyProgress) => void
}

/**
 * On-device speech with a pluggable PCM producer and HTMLAudioElement playback.
 * Kitten is the only producer today. Audio is encoded to WAV ahead of the playhead
 * so a hidden or locked tab can keep speaking from already-ready files.
 */
export class LocalNarratorEngine implements SpeechEngine {
  readonly id = 'kitten-micro-jasper'
  readonly label = 'Natural voice'
  private producer: LoadableProducer
  private cache: AudioCache
  private queue: HtmlAudioQueue
  private unbindMedia: (() => void) | null = null
  private visibilityBound = false
  private run = 0
  private ended = () => {}
  private request: SpeechRequest | null = null
  private playParts: LocalPart[] = []
  private extraParts: LocalPart[] = []
  private sourceChunks: SpeechChunk[] = []
  private lastPart: LocalPart | null = null
  private unpacked: EncodedChunk[] = []
  private catalog: { key: string; duration: number; pageEnd: number }[] = []
  private totalParts = 0
  private completedSeconds = 0
  private listenedSeconds = 0
  private lastSliceKey = ''
  private paused = false
  private busy = false
  private pumping = false
  private preparingAll = false
  private prepareToken = 0
  private prepareSink: ((progress: AudioReadyProgress) => void) | null = null
  status: LocalStatus = 'off'
  readonly stats = { generated: 0, skipped: 0, dropped: 0, underruns: 0, maxBufferedSeconds: 0, resumedOffset: 0 }
  private consecutiveSkips = 0
  private runNotice = { parts: 0, dropped: 0 }
  private lookaheadSeconds: number
  private maxBufferedSeconds: number
  private packTargetSeconds: number
  constructor(private changed: (status: LocalStatus) => void, options: LocalEngineOptions = {}) {
    this.producer = options.producer ?? new KittenProducer(() => { if (this.request) this.fail() })
    this.cache = options.cache ?? sharedAudioCache
    this.lookaheadSeconds = options.lookaheadSeconds ?? DEFAULT_LOOKAHEAD_SECONDS
    this.maxBufferedSeconds = options.maxBufferedSeconds ?? MAX_BUFFERED_SECONDS
    this.packTargetSeconds = options.packTargetSeconds ?? PACK_TARGET_SECONDS
    this.queue = new HtmlAudioQueue(options.createAudio?.() ?? createPlaybackAudio(), {
      onSlice: slice => this.enterSlice(slice.part),
      onSegmentEnd: segment => {
        const last = segment.slices.at(-1)
        if (last) this.leaveSlice(last.part)
        this.completedSeconds += segment.duration
        this.lastSliceKey = ''
        this.packIfNeeded()
        void this.pump(this.run)
      },
      onIdle: () => this.drainIdle(),
      onError: () => this.fail(),
      onTime: (position, slice) => {
        this.listenedSeconds = this.completedSeconds + position
        if (slice) this.enterSlice(slice.part)
        this.emitProgress()
        updateMediaPosition({
          duration: Math.max(this.queue.currentSegment?.duration ?? 0, position),
          position,
          paused: this.paused,
        })
      },
    })
  }
  get available() { return this.producer.prepared }
  get downloadedFiles() { return this.producer.downloadedFiles }
  onEnd(callback: () => void) { this.ended = callback }
  private state(status: LocalStatus) {
    this.status = status; this.changed(status)
    window.dispatchEvent(new CustomEvent('latte-local-state', { detail: { status, ...this.stats, bufferedSeconds: this.playableSeconds(), readyBuffers: this.unpacked.length, currentBuffer: !this.queue.isEmpty, inFlight: this.busy } }))
  }
  async prepare({ allowNetwork = true }: { allowNetwork?: boolean } = {}): Promise<'ready' | 'not-cached' | 'error' | 'cancelled'> {
    this.stop()
    this.state('preparing')
    const result = await this.producer.prepare({ allowNetwork })
    if (result === 'ready') this.state('ready')
    else if (result === 'not-cached') this.state('off')
    else if (result === 'error') this.state('error')
    else this.state('off')
    return result
  }
  dispose() {
    this.cancelPrepare()
    this.resetAudio()
    this.producer.dispose()
    this.unbindVisibility()
    this.state('off')
  }
  speak(request: SpeechRequest) {
    this.stopPlayback()
    if (!this.producer.prepared) { request.onError?.(); return }
    const run = ++this.run
    this.request = request
    this.sourceChunks = request.chunks ?? []
    this.playParts = localParts(this.sourceChunks)
    this.totalParts = Math.max(this.totalParts, this.playParts.length)
    this.unpacked = []
    this.completedSeconds = 0
    this.listenedSeconds = 0
    this.lastSliceKey = ''
    this.paused = false
    this.consecutiveSkips = 0
    this.dropExtraDuplicates()
    this.bindVisibility()
    this.unbindMedia = bindMediaSession({
      title: request.title || 'LatteReader',
      onPlay: () => { this.resume(); request.onTransport?.('resume') },
      onPause: () => { this.pause(); request.onTransport?.('pause') },
      onStop: () => { this.stopPlayback(); request.onTransport?.('stop') },
      onNext: () => request.onMediaSkip?.(1),
      onPrevious: () => request.onMediaSkip?.(-1),
      onSeek: time => this.queue.seekInCurrent(time),
      onSeekBy: delta => this.queue.seekBy(delta),
    })
    void this.queue.unlock().then(() => {
      if (run !== this.run) return
      this.state('buffering')
      void this.pump(run)
    }).catch(() => { if (run === this.run) this.fail() })
  }
  async prepareDocument(request: PrepareDocumentRequest): Promise<void> {
    if (!this.producer.prepared) return
    const token = ++this.prepareToken
    this.preparingAll = true
    this.prepareSink = request.onProgress ?? this.prepareSink
    this.sourceChunks = request.chunks
    const parts = localParts(request.chunks)
    this.totalParts = Math.max(this.totalParts, parts.length)
    const known = new Set([...this.playParts, ...this.extraParts].map(encodedKey))
    for (const part of this.catalog) known.add(part.key)
    for (const part of parts) {
      const key = encodedKey(part)
      if (known.has(key)) continue
      this.extraParts.push(part)
      known.add(key)
    }
    this.documentId = request.documentId
    this.prepareRate = request.rate
    this.emitProgress()
    await this.pump(this.run)
    if (token !== this.prepareToken) return
    if (!this.playParts.length && !this.extraParts.length) this.preparingAll = false
    this.emitProgress()
  }
  cancelPrepare() {
    this.prepareToken += 1
    this.preparingAll = false
    this.extraParts = []
    this.emitProgress()
  }
  private documentId: string | undefined
  private prepareRate = 1
  private playableSeconds() {
    return this.unpacked.reduce((total, chunk) => total + chunk.duration, 0) + this.queue.remaining
  }
  private split(part: LocalPart) {
    const source = this.sourceChunks[part.chunk] ?? null
    if (!source) return false
    const midpoint = Math.floor(part.text.length / 2)
    const boundaries = [...part.text.matchAll(/\s+/g)].map(match => match.index! + match[0].length).filter(offset => offset > 0 && offset < part.text.length)
    const mid = boundaries.sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint))[0]
    if (!mid) return false
    const make = (start: number, end: number): LocalPart => {
      const spans = source.spans.filter(span => span.end > start && span.start < end)
      return { ...part, text: source.text.slice(start, end), start, end, page: spans[0]?.pageNumber ?? part.page, pageEnd: spans.at(-1)?.pageNumber ?? part.pageEnd }
    }
    this.playParts.unshift(make(part.start, part.start + mid), make(part.start + mid, part.end))
    return true
  }
  /**
   * A refused or failed part is skipped, never fatal: the run keeps its position and
   * goes on with the next part, which is a product rule. Only a voice that cannot say
   * anything at all ends a run, and MAX_CONSECUTIVE_SKIPS detects that so a dead
   * engine cannot skim a whole document in silence and report it as finished.
   */
  private skip(part: LocalPart, reason: string, dropped = 0) {
    this.stats.skipped++; this.stats.dropped += dropped; this.consecutiveSkips++
    this.notice(reason, dropped)
    if (this.consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) { this.fail(); return }
    this.request?.onPosition?.(part.chunk, part.start, 'audio-chunk', part.end)
    this.request?.onPosition?.(part.chunk, Math.max(part.start, part.end - 1), 'utterance')
    this.request?.onPage?.(part.pageEnd)
  }
  private notice(reason: string, dropped: number) {
    this.runNotice.parts += 1; this.runNotice.dropped += dropped
    window.dispatchEvent(new CustomEvent('latte-local-notice', { detail: { reason, dropped, parts: this.runNotice.parts } }))
  }
  private noticeRun() {
    if (this.runNotice.parts) recordEvent('speech.contained', { count: this.runNotice.parts })
    this.runNotice = { parts: 0, dropped: 0 }
  }
  private dropExtraDuplicates() {
    const known = new Set(this.playParts.map(encodedKey))
    this.extraParts = this.extraParts.filter(part => !known.has(encodedKey(part)))
  }
  private shouldGenerate(): boolean {
    if (this.busy) return false
    if (this.playParts.length) {
      const ready = this.playableSeconds()
      if (this.preparingAll) return true
      return ready < this.lookaheadSeconds && ready < this.maxBufferedSeconds
    }
    return this.preparingAll && this.extraParts.length > 0
  }
  private nextPart(): { part: LocalPart; playback: boolean } | undefined {
    if (this.playParts.length && (this.preparingAll || this.playableSeconds() < this.lookaheadSeconds)) {
      return { part: this.playParts.shift()!, playback: !!this.request }
    }
    if (this.preparingAll && this.extraParts.length) return { part: this.extraParts.shift()!, playback: false }
    return undefined
  }
  private async pump(run: number) {
    if (this.pumping) return
    this.pumping = true
    try {
      while ((run === this.run || this.preparingAll) && this.shouldGenerate()) {
        const next = this.nextPart()
        if (!next) break
        const { part, playback } = next
        if (!part.text.trim()) continue
        this.busy = true
        try {
          const encoded = await this.encodePart(part, this.request?.rate ?? this.prepareRate)
          if ((run !== this.run && !this.preparingAll) || !this.preparingAll && !this.request) return
          if (!encoded) continue
          this.noteReady(encoded)
          if (playback && this.request && run === this.run) {
            this.unpacked.push(encoded)
            this.stats.maxBufferedSeconds = Math.max(this.stats.maxBufferedSeconds, this.playableSeconds())
            this.packIfNeeded()
            if (!this.paused) void this.queue.play()
          }
          this.emitProgress()
        } finally { this.busy = false }
        if (run !== this.run && !this.preparingAll) return
      }
      this.packIfNeeded()
      if (this.request && run === this.run && !this.paused && !this.queue.isEmpty) void this.queue.play()
    } catch { if (run === this.run) this.fail() }
    finally {
      this.pumping = false
      if (this.preparingAll && !this.extraParts.length && !this.playParts.length) this.preparingAll = false
      if (run !== this.run && this.request && !this.busy) void this.pump(this.run)
      else if (this.preparingAll && !this.busy) void this.pump(this.run)
      this.emitProgress()
    }
  }
  private async encodePart(part: LocalPart, rate: number): Promise<EncodedChunk | null> {
    const documentId = this.request?.documentId ?? this.documentId
    const id = documentId ? cacheId(documentId, this.producer.id, rate, part) : ''
    if (id) {
      const cached = this.cache.peek(id) ?? await this.cache.get(id)
      if (cached) { this.consecutiveSkips = 0; return cached }
      if (!this.preparingAll && !this.request) return null
    }
    let result: Awaited<ReturnType<LoadableProducer['generate']>>
    try { result = await this.producer.generate(part.text, rate) }
    catch (error) {
      const code = (error as Error).message
      if (code === 'CANCELLED') return null
      if (code === 'TOKEN_LIMIT' || code === 'UNSUPPORTED_TEXT' || code === 'INFERENCE_FAILED' || code === 'INVALID_PCM') {
        if (!this.split(part)) this.skip(part, code)
        return null
      }
      throw error
    }
    const pcm = result.pcm
    if (!pcm.length || !pcm.every(Number.isFinite)) { if (!this.split(part)) this.skip(part, 'INVALID_PCM'); return null }
    if (pcm.length / result.sampleRate > 15) { if (!this.split(part)) this.skip(part, 'TOKEN_LIMIT'); return null }
    this.stats.generated++
    const metrics = result.metrics ?? {}
    if (Number(metrics.dropped) > 0 || Number(metrics.readByOtherMeans) > 0) this.notice('contained', Number(metrics.dropped) || 0)
    this.consecutiveSkips = 0
    window.dispatchEvent(new CustomEvent('latte-local-metric', { detail: result.metrics }))
    const encoded: EncodedChunk = { part, wav: encodeWav(pcm, result.sampleRate), duration: wavDuration(pcm.length, result.sampleRate), sampleRate: result.sampleRate }
    if (id) await this.cache.put({ ...encoded, id, documentId: documentId!, producerId: this.producer.id, speed: rate })
    return encoded
  }
  private noteReady(chunk: EncodedChunk) {
    const key = encodedKey(chunk.part)
    if (this.catalog.some(item => item.key === key)) return
    this.catalog.push({ key, duration: chunk.duration, pageEnd: chunk.part.pageEnd })
  }
  private packIfNeeded() {
    if (!this.request) return
    if (this.queue.isEmpty && this.unpacked.length) {
      this.queue.enqueue(packChunks(takePack(this.unpacked, this.packTargetSeconds)))
      return
    }
    if (this.queue.hasNext || !this.unpacked.length) return
    const unpacked = this.unpacked.reduce((total, chunk) => total + chunk.duration, 0)
    const done = !this.playParts.length && !this.busy
    const underrun = this.queue.remaining < UNDERRUN_GUARD_SECONDS
    if (unpacked >= this.packTargetSeconds || unpacked >= this.lookaheadSeconds || done || underrun) {
      this.queue.enqueue(packChunks(takePack(this.unpacked, Math.max(this.packTargetSeconds, this.lookaheadSeconds))))
    }
  }
  private enterSlice(part: LocalPart) {
    const key = encodedKey(part)
    if (this.lastPart && encodedKey(this.lastPart) !== key) this.leaveSlice(this.lastPart)
    if (this.lastSliceKey === key) return
    this.lastSliceKey = key
    this.lastPart = part
    this.request?.onPosition?.(part.chunk, part.start, 'audio-chunk', part.end)
    this.request?.onPage?.(part.page)
    if (!this.paused) this.state('playing')
  }
  private leaveSlice(part: LocalPart) {
    this.request?.onPosition?.(part.chunk, Math.max(part.start, part.end - 1), 'utterance')
    this.request?.onPage?.(part.pageEnd)
  }
  private drainIdle() {
    if (!this.request) return
    if (!this.playParts.length && !this.busy && !this.pumping && !this.unpacked.length) {
      const request = this.request
      this.request = null
      this.noticeRun()
      this.state('ready')
      this.ended()
      request.onAudioProgress?.(this.snapshot())
      return
    }
    this.stats.underruns++
    this.state('buffering')
    void this.pump(this.run)
  }
  pause() {
    this.paused = true
    this.stats.resumedOffset = this.queue.position
    this.queue.pause()
    this.state('paused')
    updateMediaPosition({ duration: this.queue.currentSegment?.duration ?? 0, position: this.queue.position, paused: true })
  }
  resume() {
    const run = this.run
    this.paused = false
    void this.queue.resume().then(() => {
      if (run !== this.run) return
      this.playIfReady(run)
      void this.pump(run)
    }).catch(() => { if (run === this.run) this.fail() })
  }
  stop() { this.stopPlayback() }
  resetAudio() {
    this.cancelPrepare()
    this.stopPlayback()
    this.catalog = []
    this.totalParts = 0
    this.documentId = undefined
    this.emitProgress()
  }
  private stopPlayback() {
    this.run += 1
    this.paused = false
    this.request = null
    this.playParts = []
    this.unpacked = []
    this.completedSeconds = 0
    this.listenedSeconds = 0
    this.lastSliceKey = ''
    this.consecutiveSkips = 0
    this.noticeRun()
    this.unbindMedia?.(); this.unbindMedia = null
    this.lastPart = null
    this.queue.stop()
    if (this.producer.prepared) this.state('ready')
    this.emitProgress()
  }
  private playIfReady(run: number) {
    if (run !== this.run || this.paused) return
    this.packIfNeeded()
    if (!this.queue.isEmpty) {
      void this.queue.play()
      this.state('playing')
    } else this.state('buffering')
  }
  private bindVisibility() {
    if (this.visibilityBound) return
    this.visibilityBound = true
    const refill = () => {
      if (document.visibilityState === 'hidden') return
      if (this.request && !this.paused) void this.pump(this.run)
      else if (this.preparingAll) void this.pump(this.run)
    }
    document.addEventListener('visibilitychange', refill)
    window.addEventListener('pageshow', refill)
    window.addEventListener('focus', refill)
    this.unbindVisibility = () => {
      document.removeEventListener('visibilitychange', refill)
      window.removeEventListener('pageshow', refill)
      window.removeEventListener('focus', refill)
      this.visibilityBound = false
    }
  }
  private unbindVisibility = () => {}
  private fail() { const request = this.request; this.stopPlayback(); this.state('error'); request?.onError?.() }
  private snapshot(): AudioReadyProgress {
    const playable = [
      ...this.unpacked.map(chunk => ({ duration: chunk.duration, pageEnd: chunk.part.pageEnd })),
      ...(this.queue.currentSegment?.slices.map(slice => ({ duration: slice.duration, pageEnd: slice.part.pageEnd })) ?? []),
    ]
    const lastPlayablePage = playable.at(-1)?.pageEnd ?? this.catalog.at(-1)?.pageEnd ?? null
    const generated = this.catalog.length ? this.catalog : playable
    const progress = audioReadyProgress({
      parts: generated.map(item => ({ duration: item.duration, pageEnd: 'pageEnd' in item ? item.pageEnd : lastPlayablePage ?? 1 })),
      totalParts: this.totalParts,
      listenedSeconds: this.listenedSeconds,
      preparing: this.preparingAll,
    })
    if (playable.length) progress.lastReadyPage = lastPlayablePage
    progress.remainingReadySeconds = this.playableSeconds()
    return this.catalog.length || this.preparingAll || this.request ? progress : emptyAudioReady(this.preparingAll)
  }
  private emitProgress() {
    const progress = this.snapshot()
    this.request?.onAudioProgress?.(progress)
    this.prepareSink?.(progress)
  }
  clearCachedDocument(documentId: string) { void this.cache.clearDocument(documentId) }
}
