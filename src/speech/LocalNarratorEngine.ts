import type { SpeechEngine, SpeechRequest } from './SpeechEngine'
import { localParts, type LocalPart } from './localPlan'
import { recordEvent } from '../diagnostics/diagnostics'
import type { LoadableProducer } from './chunkProducer'
import { DEFAULT_LOOKAHEAD_SECONDS, MAX_BUFFERED_SECONDS, MEDIA_NOTIFICATION_SECONDS } from './chunkProducer'
import { decideSynthesisJob, PREPARE_PAUSE_SECONDS, PREPARE_RESUME_SECONDS, yieldToPlayback } from './prepareSchedule'
import { KittenProducer } from './kittenProducer'
import { encodeWav, wavDuration } from './wav'
import { AudioCache, sharedAudioCache } from './audioCache'
import { cacheId, encodedKey, type EncodedChunk } from './encodedChunk'
import { contentSeconds, packChunks, takeOne } from './audioPack'
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
  preparePauseSeconds?: number
  prepareResumeSeconds?: number
  yieldPrepare?: () => Promise<void>
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
  private currentEncoded: EncodedChunk[] = []
  private backgroundEncoded: EncodedChunk[] = []
  private catalog: { id: string; duration: number; pageEnd: number; speed: number }[] = []
  private attemptedIds = new Set<string>()
  private totalParts = 0
  private completedSeconds = 0
  private listenedSeconds = 0
  private lastSliceKey = ''
  private paused = false
  private busy = false
  private pumping = false
  private pumpEpoch = 0
  private preparingAll = false
  private prepareToken = 0
  private prepareSink: ((progress: AudioReadyProgress) => void) | null = null
  status: LocalStatus = 'off'
  readonly stats = { generated: 0, skipped: 0, dropped: 0, underruns: 0, maxBufferedSeconds: 0, resumedOffset: 0 }
  private consecutiveSkips = 0
  private runNotice = { parts: 0, dropped: 0 }
  private lookaheadSeconds: number
  private maxBufferedSeconds: number
  private preparePauseSeconds: number
  private prepareResumeSeconds: number
  private yieldPrepare: () => Promise<void>
  private prepareStarved = false
  constructor(private changed: (status: LocalStatus) => void, options: LocalEngineOptions = {}) {
    this.producer = options.producer ?? new KittenProducer(() => { if (this.request) this.fail() })
    this.cache = options.cache ?? sharedAudioCache
    this.lookaheadSeconds = options.lookaheadSeconds ?? DEFAULT_LOOKAHEAD_SECONDS
    this.maxBufferedSeconds = options.maxBufferedSeconds ?? MAX_BUFFERED_SECONDS
    this.preparePauseSeconds = options.preparePauseSeconds ?? PREPARE_PAUSE_SECONDS
    this.prepareResumeSeconds = options.prepareResumeSeconds ?? PREPARE_RESUME_SECONDS
    this.yieldPrepare = options.yieldPrepare ?? yieldToPlayback
    this.queue = new HtmlAudioQueue(options.createAudio?.() ?? createPlaybackAudio(), {
      onSlice: slice => this.enterSlice(slice.part),
      onSegmentEnd: segment => {
        const last = segment.slices.at(-1)
        if (last) this.leaveSlice(last.part)
        this.completedSeconds += segment.contentDuration
        this.currentEncoded = this.backgroundEncoded
        this.backgroundEncoded = []
        this.lastSliceKey = ''
        this.packIfNeeded()
        void this.pump(this.run)
      },
      onIdle: () => this.drainIdle(),
      onError: () => this.fail(),
      onTime: (position, slice) => {
        this.listenedSeconds = this.completedSeconds + Math.min(position, this.queue.currentSegment?.contentDuration ?? position)
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
    this.documentId = request.documentId ?? this.documentId
    this.prepareRate = request.rate
    this.sourceChunks = request.chunks ?? []
    this.playParts = localParts(this.sourceChunks)
    this.totalParts = Math.max(this.totalParts, this.playParts.length)
    this.unpacked = []
    this.currentEncoded = []
    this.backgroundEncoded = []
    this.completedSeconds = 0
    this.listenedSeconds = 0
    this.lastSliceKey = ''
    this.paused = false
    this.consecutiveSkips = 0
    this.keepPendingPrepare()
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
    this.state('buffering')
    void this.queue.unlock().catch(() => { /* real src play() retries after the first clip */ })
    void this.pump(run)
  }
  async prepareDocument(request: PrepareDocumentRequest): Promise<void> {
    if (!this.producer.prepared) return
    const token = ++this.prepareToken
    this.preparingAll = true
    this.prepareSink = request.onProgress ?? this.prepareSink
    this.documentId = request.documentId
    this.prepareRate = request.rate
    this.sourceChunks = request.chunks
    const parts = localParts(request.chunks)
    this.totalParts = Math.max(this.totalParts, parts.length)
    const known = new Set(this.extraParts.map(part => this.partId(part, request.rate)))
    for (const part of parts) {
      const id = this.partId(part, request.rate)
      if (known.has(id) || this.catalogHas(part, request.rate) || this.attemptedIds.has(id)) continue
      this.extraParts.push(part)
      known.add(id)
    }
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
    return contentSeconds(this.unpacked) + this.queue.remaining
  }
  private pageHidden() {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }
  private currentRate() { return this.request?.rate ?? this.prepareRate }
  private partId(part: LocalPart, rate = this.currentRate()) {
    return cacheId(this.request?.documentId ?? this.documentId ?? '', this.producer.id, rate, part)
  }
  private catalogHas(part: LocalPart, rate = this.currentRate()) {
    const id = this.partId(part, rate)
    return this.catalog.some(item => item.id === id)
  }
  private bufferHasRoom() {
    const ready = this.playableSeconds()
    return ready < this.lookaheadSeconds && ready < this.maxBufferedSeconds
  }
  private keepPendingPrepare() {
    const rate = this.currentRate()
    this.extraParts = this.extraParts.filter(part => !this.catalogHas(part, rate) && !this.attemptedIds.has(this.partId(part, rate)))
  }
  private hasPrepareWork() {
    const rate = this.currentRate()
    if (this.extraParts.some(part => !this.catalogHas(part, rate) && !this.attemptedIds.has(this.partId(part, rate)))) return true
    return this.playParts.some(part => !this.catalogHas(part, rate) && !this.attemptedIds.has(this.partId(part, rate)))
  }
  private split(part: LocalPart, playback: boolean) {
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
    const children = [make(part.start, part.start + mid), make(part.start + mid, part.end)]
    if (playback) this.playParts.unshift(...children)
    else this.extraParts.unshift(...children)
    return true
  }
  /**
   * A refused or failed part is skipped, never fatal: the run keeps its position and
   * goes on with the next part, which is a product rule. Only a voice that cannot say
   * anything at all ends a run, and MAX_CONSECUTIVE_SKIPS detects that so a dead
   * engine cannot skim a whole document in silence and report it as finished.
   */
  private skip(part: LocalPart, reason: string, dropped = 0, playback = true) {
    this.stats.skipped++; this.stats.dropped += dropped
    this.notice(reason, dropped)
    if (!playback) return
    this.consecutiveSkips++
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
  private schedule() {
    const decision = decideSynthesisJob({
      hasPlaybackWork: this.playParts.length > 0,
      bufferHasRoom: this.bufferHasRoom(),
      hasPrepareWork: this.preparingAll && this.hasPrepareWork(),
      playableSeconds: this.playableSeconds(),
      playing: !!this.request,
      prepareStarved: this.prepareStarved,
      pauseSeconds: this.preparePauseSeconds,
      resumeSeconds: this.prepareResumeSeconds,
    })
    this.prepareStarved = decision.prepareStarved
    return decision.job
  }
  private shouldGenerate(): boolean {
    if (this.busy) return false
    return decideSynthesisJob({
      hasPlaybackWork: this.playParts.length > 0,
      bufferHasRoom: this.bufferHasRoom(),
      hasPrepareWork: this.preparingAll && this.hasPrepareWork(),
      playableSeconds: this.playableSeconds(),
      playing: !!this.request,
      prepareStarved: this.prepareStarved,
      pauseSeconds: this.preparePauseSeconds,
      resumeSeconds: this.prepareResumeSeconds,
    }).job !== null
  }
  private nextPart(run: number): { part: LocalPart; playback: boolean } | undefined {
    const job = this.schedule()
    if (job === 'playback' && this.playParts.length) {
      if (run !== this.run) {
        if (!this.preparingAll) return undefined
      } else {
        return { part: this.playParts.shift()!, playback: !!this.request }
      }
    }
    if (job !== 'prepare') return undefined
    const rate = this.currentRate()
    while (this.extraParts.length) {
      const part = this.extraParts.shift()!
      const id = this.partId(part, rate)
      if (!this.catalogHas(part, rate) && !this.attemptedIds.has(id)) return { part, playback: false }
    }
    const pending = this.playParts.find(part => !this.catalogHas(part, rate) && !this.attemptedIds.has(this.partId(part, rate)))
    if (pending) return { part: pending, playback: false }
    return undefined
  }
  private playQueue(run: number) {
    if (this.paused || run !== this.run || this.queue.isEmpty) return
    void this.queue.play().catch(() => { if (run === this.run && !this.paused) this.fail() })
  }
  private async pump(run: number) {
    if (this.pumping) return
    const epoch = ++this.pumpEpoch
    this.pumping = true
    try {
      while ((run === this.run || this.preparingAll) && this.shouldGenerate()) {
        const next = this.nextPart(run)
        if (!next) break
        const { part, playback } = next
        if (!part.text.trim()) continue
        this.busy = true
        try {
          const encoded = await this.encodePart(part, this.currentRate(), playback)
          if ((run !== this.run && !this.preparingAll) || !this.preparingAll && !this.request) return
          if (!encoded) continue
          this.noteReady(encoded)
          if (playback && this.request && run === this.run) {
            this.unpacked.push(encoded)
            this.stats.maxBufferedSeconds = Math.max(this.stats.maxBufferedSeconds, this.playableSeconds())
            this.packIfNeeded()
            this.playQueue(run)
          }
          this.emitProgress()
          if (!playback) {
            this.pumping = false
            await this.yieldPrepare()
            if (epoch !== this.pumpEpoch) return
            this.pumping = true
          }
        } finally { this.busy = false }
        if (run !== this.run && !this.preparingAll) return
      }
      this.packIfNeeded()
      this.playQueue(run)
    } catch { if (run === this.run) this.fail() }
    finally {
      if (epoch === this.pumpEpoch) this.pumping = false
      if (this.preparingAll && !this.hasPrepareWork()) this.preparingAll = false
      this.emitProgress()
      if (epoch !== this.pumpEpoch || this.busy) return
      if (run !== this.run && this.request) void this.pump(this.run)
      else if (this.preparingAll && this.shouldGenerate()) {
        void this.yieldPrepare().then(() => { if (!this.pumping) void this.pump(this.run) })
      }
    }
  }
  private recoverPart(part: LocalPart, reason: string, playback: boolean) {
    if (!this.split(part, playback)) this.skip(part, reason, 0, playback)
  }
  private async encodePart(part: LocalPart, rate: number, playback: boolean): Promise<EncodedChunk | null> {
    const documentId = this.request?.documentId ?? this.documentId
    const id = documentId ? this.partId(part, rate) : ''
    if (id) this.attemptedIds.add(id)
    const lead = playback && this.queue.isEmpty && !this.unpacked.length && !this.currentEncoded.length
    if (id) {
      const cached = this.cache.peek(id) ?? ((this.catalogHas(part, rate) || !lead) ? await this.cache.get(id, playback) : undefined)
      if (cached) {
        this.consecutiveSkips = 0
        if (!playback) this.cache.release(id)
        return { ...cached, part }
      }
      if (!this.preparingAll && !this.request) return null
    }
    let result: Awaited<ReturnType<LoadableProducer['generate']>>
    try { result = await this.producer.generate(part.text, rate) }
    catch (error) {
      const code = (error as Error).message
      if (code === 'CANCELLED') return null
      if (code === 'TOKEN_LIMIT' || code === 'UNSUPPORTED_TEXT' || code === 'INFERENCE_FAILED' || code === 'INVALID_PCM') {
        this.recoverPart(part, code, playback)
        return null
      }
      throw error
    }
    const pcm = result.pcm
    if (!pcm.length || !pcm.every(Number.isFinite)) { this.recoverPart(part, 'INVALID_PCM', playback); return null }
    if (pcm.length / result.sampleRate > 15) { this.recoverPart(part, 'TOKEN_LIMIT', playback); return null }
    this.stats.generated++
    const metrics = result.metrics ?? {}
    if (Number(metrics.dropped) > 0 || Number(metrics.readByOtherMeans) > 0) this.notice('contained', Number(metrics.dropped) || 0)
    this.consecutiveSkips = 0
    window.dispatchEvent(new CustomEvent('latte-local-metric', { detail: result.metrics }))
    const encoded: EncodedChunk = { part, wav: encodeWav(pcm, result.sampleRate), duration: wavDuration(pcm.length, result.sampleRate), sampleRate: result.sampleRate }
    if (id) void this.cache.put({ ...encoded, id, documentId: documentId!, producerId: this.producer.id, speed: rate }, playback)
    return encoded
  }
  private noteReady(chunk: EncodedChunk) {
    const rate = this.currentRate()
    const id = this.partId(chunk.part, rate)
    if (this.catalog.some(item => item.id === id)) return
    this.catalog.push({ id, duration: chunk.duration, pageEnd: chunk.part.pageEnd, speed: rate })
  }
  private enqueuePacked(chunks: EncodedChunk[], minDuration = 0) {
    if (!chunks.length) return
    this.queue.enqueue(packChunks(chunks, minDuration))
    for (const chunk of chunks) this.cache.release(this.partId(chunk.part))
  }
  private packIfNeeded() {
    if (!this.request) return
    if (this.queue.isEmpty && this.unpacked.length) {
      this.currentEncoded = takeOne(this.unpacked)
      this.enqueuePacked(this.currentEncoded, MEDIA_NOTIFICATION_SECONDS)
      this.packBackground()
      return
    }
    if (!this.pageHidden() && this.currentEncoded.length && contentSeconds(this.currentEncoded) < MEDIA_NOTIFICATION_SECONDS && this.unpacked.length) {
      this.currentEncoded.push(...this.unpacked.splice(0))
      void this.queue.replaceCurrent(packChunks(this.currentEncoded, MEDIA_NOTIFICATION_SECONDS))
    }
    this.packBackground()
  }
  private packBackground() {
    if (!this.request || !this.unpacked.length || this.queue.isEmpty) return
    this.backgroundEncoded.push(...this.unpacked.splice(0))
    this.queue.replaceUpcoming(packChunks(this.backgroundEncoded, MEDIA_NOTIFICATION_SECONDS))
    for (const chunk of this.backgroundEncoded) this.cache.release(this.partId(chunk.part))
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
    if (!this.playParts.length && !this.busy && !this.pumping && !this.unpacked.length && !this.backgroundEncoded.length) {
      const request = this.request
      this.stopPlayback()
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
    this.attemptedIds.clear()
    this.totalParts = 0
    this.documentId = undefined
    this.emitProgress()
  }
  private stopPlayback() {
    this.run += 1
    this.paused = false
    this.request = null
    if (this.preparingAll && this.playParts.length) {
      const known = new Set(this.extraParts.map(part => this.partId(part)))
      for (const part of this.playParts) {
        const id = this.partId(part)
        if (!known.has(id) && !this.catalogHas(part) && !this.attemptedIds.has(id)) {
          this.extraParts.push(part)
          known.add(id)
        }
      }
    }
    this.playParts = []
    this.unpacked = []
    this.currentEncoded = []
    this.backgroundEncoded = []
    this.completedSeconds = 0
    this.listenedSeconds = 0
    this.lastSliceKey = ''
    this.consecutiveSkips = 0
    this.prepareStarved = false
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
      this.playQueue(run)
      this.state('playing')
    } else this.state('buffering')
  }
  private bindVisibility() {
    if (this.visibilityBound) return
    this.visibilityBound = true
    const onVisible = () => {
      if (this.request && !this.paused) {
        this.queue.ensurePlaying()
        void this.pump(this.run)
      } else if (this.preparingAll) void this.pump(this.run)
    }
    const onChange = () => {
      if (document.visibilityState === 'hidden') {
        this.packBackground()
        if (this.request && !this.paused) {
          this.queue.ensurePlaying()
          updateMediaPosition({
            duration: this.queue.currentSegment?.duration ?? 0,
            position: this.queue.position,
            paused: false,
          })
        }
        return
      }
      onVisible()
    }
    document.addEventListener('visibilitychange', onChange)
    window.addEventListener('pageshow', onVisible)
    window.addEventListener('focus', onVisible)
    this.unbindVisibility = () => {
      document.removeEventListener('visibilitychange', onChange)
      window.removeEventListener('pageshow', onVisible)
      window.removeEventListener('focus', onVisible)
      this.visibilityBound = false
    }
  }
  private unbindVisibility = () => {}
  private fail() { const request = this.request; this.stopPlayback(); this.state('error'); request?.onError?.() }
  private playbackTail() {
    const tail: { duration: number; pageEnd: number }[] = []
    const push = (pageEnd: number, duration: number) => tail.push({ duration, pageEnd })
    for (const slice of this.queue.currentSegment?.slices ?? []) push(slice.part.pageEnd, slice.duration)
    for (const segment of this.queue.upcomingSegments) {
      for (const slice of segment.slices) push(slice.part.pageEnd, slice.duration)
    }
    for (const chunk of this.unpacked) push(chunk.part.pageEnd, chunk.duration)
    return tail
  }
  private snapshot(): AudioReadyProgress {
    const playable = this.playbackTail()
    const rate = this.currentRate()
    const catalog = this.catalog.filter(item => item.speed === rate)
    const lastPlayablePage = playable.at(-1)?.pageEnd ?? catalog.at(-1)?.pageEnd ?? null
    const generated = catalog.length ? catalog : playable
    const progress = audioReadyProgress({
      parts: generated.map(item => ({ duration: item.duration, pageEnd: item.pageEnd })),
      totalParts: this.totalParts,
      listenedSeconds: this.listenedSeconds,
      preparing: this.preparingAll,
    })
    if (playable.length) progress.lastReadyPage = lastPlayablePage
    progress.remainingReadySeconds = this.playableSeconds()
    return catalog.length || this.preparingAll || this.request ? progress : emptyAudioReady(this.preparingAll)
  }
  private emitProgress() {
    const progress = this.snapshot()
    this.request?.onAudioProgress?.(progress)
    this.prepareSink?.(progress)
  }
  clearCachedDocument(documentId: string) { void this.cache.clearDocument(documentId) }
}
