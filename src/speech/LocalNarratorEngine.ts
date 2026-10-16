import type { SpeechEngine, SpeechRequest } from './SpeechEngine'
import { localParts, type LocalPart } from './localPlan'
import { recordEvent } from '../diagnostics/diagnostics'

type AudioPart = { part: LocalPart; buffer: AudioBuffer }
export type LocalStatus = 'off' | 'preparing' | 'ready' | 'buffering' | 'playing' | 'paused' | 'error'

/**
 * How many parts in a row may fail before the run stops. One unreadable part is
 * normal and must never end a read; a voice that cannot say twenty consecutive
 * parts is broken, and reporting that as a finished document would be worse than
 * saying the voice failed.
 */
const MAX_CONSECUTIVE_SKIPS = 20


/** One built worker for normal and private previews. The private marker never
 * selects a historical comparator. All voice files come from this origin only,
 * after explicit download consent; browser speech remains the default.
 */
const builtWorker = () => new Worker(new URL('../workers/narrator.worker.ts', import.meta.url), { type: 'module' })


/**
 * One inference in flight, current plus two ready buffers, <=30s of ready PCM.
 * Cancellation invalidates results; pause preserves the rendered sample offset.
 */
export class LocalNarratorEngine implements SpeechEngine {
  readonly id = 'kitten-micro-jasper'
  readonly label = 'Natural voice'
  private worker: Worker | null = null
  private context: AudioContext | null = null
  private serial = 0
  private run = 0
  private pending = new Map<number, { resolve: (d: Record<string, unknown>) => void; reject: (e: Error) => void }>()
  private ended = () => {}
  private request: SpeechRequest | null = null
  private parts: LocalPart[] = []
  private queue: AudioPart[] = []
  private current: AudioPart | null = null
  private source: AudioBufferSourceNode | null = null
  private startedAt = 0
  private offset = 0
  private paused = false
  private busy = false
  private prepared = false
  private pumping = false
  status: LocalStatus = 'off'
  readonly stats = { generated: 0, skipped: 0, dropped: 0, underruns: 0, maxBufferedSeconds: 0, resumedOffset: 0 }
  private consecutiveSkips = 0
  private runNotice = { parts: 0, dropped: 0 }
  constructor(private changed: (status: LocalStatus) => void) {}
  get available() { return this.prepared }
  onEnd(callback: () => void) { this.ended = callback }
  private state(s: LocalStatus) {
    this.status = s; this.changed(s)
    window.dispatchEvent(new CustomEvent('latte-local-state', { detail: { status: s, ...this.stats, bufferedSeconds: this.seconds(), readyBuffers: this.queue.length, currentBuffer: !!this.current, inFlight: this.busy } }))
  }
  private rpc(op: string, fields: Record<string, unknown> = {}) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++this.serial
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ op, id, ...fields })
    })
  }
  /** Files fetched from the network by the last successful prepare; 0 when it loaded from the device cache. */
  downloadedFiles = 0
  /**
   * Load the voice. With allowNetwork false (a reload with Natural voice selected) it
   * only uses files already stored on this device and resolves 'not-cached', back in
   * the 'off' state, when any are missing, so nothing downloads without a Download press.
   */
  async prepare({ allowNetwork = true }: { allowNetwork?: boolean } = {}): Promise<'ready' | 'not-cached' | 'error' | 'cancelled'> {
    this.dispose(); this.state('preparing'); this.downloadedFiles = 0
    const worker = builtWorker()
    this.worker = worker
    worker.onmessage = ({ data }) => {
      if (worker !== this.worker) return
      const p = this.pending.get(data.id)
      if (!p) return
      this.pending.delete(data.id)
      if (data.ok) p.resolve(data); else p.reject(new Error(data.error))
    }
    worker.onerror = () => {
      if (worker === this.worker) {
        window.dispatchEvent(new CustomEvent('latte-local-failed', { detail: { code: 'WORKER_FAILED' } }))
        const request = this.request; this.dispose(); this.state('error'); request?.onError?.()
      }
    }
    try {
      const init = await this.rpc('init', { allowNetwork })
      if (worker !== this.worker) return 'cancelled'
      this.downloadedFiles = Number(init.downloadedFiles) || 0
      this.prepared = true
      // Content-free: which pinned bytes the worker verified before it started,
      // and nothing about the document.
      window.dispatchEvent(new CustomEvent('latte-local-ready', { detail: init }))
      this.state('ready')
      return 'ready'
    } catch (error) {
      if (worker === this.worker && String((error as Error)?.message) === 'NOT_CACHED') { this.dispose(); return 'not-cached' }
      if (worker === this.worker) {
        // A fixed reason code and nothing else: no document text, no filename.
        window.dispatchEvent(new CustomEvent('latte-local-failed', { detail: { code: String((error as Error)?.message ?? error) } }))
        this.dispose()
        this.state('error')
        return 'error'
      }
      return 'cancelled'
    }
  }
  dispose() {
    this.stop(); this.prepared = false; this.worker?.terminate(); this.worker = null
    for (const p of this.pending.values()) p.reject(new Error('CANCELLED'))
    this.pending.clear(); this.busy = false
    if (this.context) { void this.context.close(); this.context = null }
    this.state('off')
  }
  speak(request: SpeechRequest) {
    this.stop()
    if (!this.prepared) { request.onError?.(); return }
    this.context ??= new AudioContext()
    const run = this.run
    this.request = request; this.parts = localParts(request.chunks ?? [])
    // Resume in the actual Play gesture, not after model preparation.
    void this.context.resume().then(() => {
      if (run !== this.run) return
      if (this.context?.state !== 'running') throw Error('AUDIO_SUSPENDED')
      this.state('buffering'); void this.pump(run)
    }).catch(() => { if (run === this.run) this.fail() })
  }
  private seconds() { return this.queue.reduce((n,p)=>n+p.buffer.duration,0) + (this.current ? this.current.buffer.duration-this.offset : 0) }
  private split(part: LocalPart) {
    const midpoint = Math.floor(part.text.length/2)
    const boundaries = [...part.text.matchAll(/\s+/g)].map(m=>m.index!+m[0].length).filter(n=>n>0&&n<part.text.length)
    const mid = boundaries.sort((a,b)=>Math.abs(a-midpoint)-Math.abs(b-midpoint))[0]
    if (!mid) return false
    const chunk = this.request!.chunks![part.chunk]
    const make = (start:number,end:number):LocalPart => {
      const spans=chunk.spans.filter(s=>s.end>start&&s.start<end)
      return {...part,text:chunk.text.slice(start,end),start,end,page:spans[0]?.pageNumber??part.page,pageEnd:spans.at(-1)?.pageNumber??part.pageEnd}
    }
    this.parts.unshift(make(part.start,part.start+mid),make(part.start+mid,part.end))
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
    // Report the span as read, so the reader's place and the followed page advance past
    // it exactly as if it had been spoken: the reader must never lose a position, and a
    // later Play must not start again on the text this voice cannot say.
    this.request?.onPosition?.(part.chunk, part.start, 'audio-chunk', part.end)
    this.request?.onPosition?.(part.chunk, Math.max(part.start, part.end - 1), 'utterance')
    this.request?.onPage?.(part.pageEnd)
  }
  /** Content-free: a fixed reason code and a count, never any text from the document. */
  private notice(reason: string, dropped: number) {
    this.runNotice.parts += 1; this.runNotice.dropped += dropped
    window.dispatchEvent(new CustomEvent('latte-local-notice', { detail: { reason, dropped, parts: this.runNotice.parts } }))
  }
  private noticeRun() {
    if (this.runNotice.parts) recordEvent('speech.contained', { count: this.runNotice.parts })
    this.runNotice = { parts: 0, dropped: 0 }
  }
  private async pump(run: number) {
    if (!this.request || this.pumping || this.busy || run !== this.run) return
    this.pumping = true
    try {
      while (run === this.run && this.parts.length && this.queue.length < 2 && this.seconds() <= 15) {
        const part = this.parts.shift()!
        if (!part.text.trim()) continue
        this.busy = true
        let result: Record<string, unknown>
        try { result = await this.rpc('generate',{text:part.text,speed:this.request!.rate}) }
        catch (e) {
          if (run !== this.run) return
          const code = (e as Error).message
          if (code === 'CANCELLED') return
          // TOKEN_LIMIT / UNSUPPORTED_TEXT / INFERENCE_FAILED on one part: halve it, else skip it.
          if (code === 'TOKEN_LIMIT' || code === 'UNSUPPORTED_TEXT' || code === 'INFERENCE_FAILED' || code === 'INVALID_PCM') { if (!this.split(part)) this.skip(part, code); continue }
          throw e
        } finally { this.busy = false }
        if (run !== this.run) return
        const pcm = new Float32Array(result.pcm as ArrayBuffer)
        if (!pcm.length || !pcm.every(Number.isFinite)) { if (!this.split(part)) this.skip(part, 'INVALID_PCM'); continue }
        if (pcm.length/24000 > 15) { if (!this.split(part)) this.skip(part, 'TOKEN_LIMIT'); continue }
        const buffer = this.context!.createBuffer(1,pcm.length,24000)
        buffer.copyToChannel(pcm,0)
        this.queue.push({part,buffer}); this.stats.generated++
        // A contained part was still read. Silent punctuation (brackets, quotes) needs no
        // notice; a dropped unit or a spoken-form/spelling substitution does.
        const metrics = (result.metrics ?? {}) as { dropped?: number; readByOtherMeans?: number }
        if (Number(metrics.dropped) > 0 || Number(metrics.readByOtherMeans) > 0) {
          this.notice('contained', Number(metrics.dropped) || 0)
        }
        this.consecutiveSkips = 0
        this.stats.maxBufferedSeconds = Math.max(this.stats.maxBufferedSeconds,this.seconds())
        window.dispatchEvent(new CustomEvent('latte-local-metric',{detail:result.metrics}))
        this.playNext(run)
      }
      this.playNext(run)
    } catch { if (run === this.run) this.fail() }
    finally {
      this.pumping = false
      if (run === this.run) this.playNext(run)
      // A seek can arrive while old inference is uninterruptible. Restart only the new run.
      if (run !== this.run && this.request && !this.busy) void this.pump(this.run)
    }
  }
  private playNext(run: number) {
    if (!this.request || run !== this.run || this.paused || this.source) return
    if (!this.current) { this.current = this.queue.shift() ?? null; this.offset = 0 }
    if (!this.current) {
      if (!this.parts.length && !this.busy && !this.pumping) { this.request = null; this.noticeRun(); this.state('ready'); this.ended() }
      else this.state('buffering')
      return
    }
    if (this.context!.state !== 'running') { this.fail(); return }
    const {part,buffer}=this.current
    const source=this.context!.createBufferSource(); source.buffer=buffer; source.connect(this.context!.destination)
    this.source=source; this.startedAt=this.context!.currentTime
    this.request!.onPosition?.(part.chunk,part.start,'audio-chunk',part.end)
    this.request!.onPage?.(part.page)
    this.state('playing')
    source.onended=()=>{
      if (run!==this.run || this.source!==source) return
      this.source=null; source.disconnect()
      this.request?.onPosition?.(part.chunk,Math.max(part.start,part.end-1),'utterance')
      this.request?.onPage?.(part.pageEnd)
      this.current=null; this.offset=0
      if (!this.queue.length && (this.parts.length || this.busy)) this.stats.underruns++
      this.playNext(run); void this.pump(run)
    }
    source.start(0,this.offset)
    void this.pump(run)
  }
  pause() {
    this.paused=true
    if (this.source && this.context && this.current) {
      this.offset=Math.min(this.current.buffer.duration,this.offset+this.context.currentTime-this.startedAt)
      this.source.onended=null; this.source.stop(); this.source.disconnect(); this.source=null
    }
    this.state('paused')
  }
  resume() {
    if (!this.context) return
    const run=this.run; this.stats.resumedOffset=this.offset
    void this.context.resume().then(()=>{if(run!==this.run)return;this.paused=false;this.playNext(run);void this.pump(run)}).catch(()=>{if(run===this.run)this.fail()})
  }
  stop() {
    this.run++; this.paused=false; this.request=null; this.parts=[]; this.queue=[]; this.current=null; this.offset=0
    this.consecutiveSkips = 0; this.noticeRun()
    if (this.source) { this.source.onended=null; this.source.stop(); this.source.disconnect(); this.source=null }
    if (!this.prepared && this.worker && this.status === 'preparing') {
      this.worker.terminate(); this.worker = null
      for (const p of this.pending.values()) p.reject(new Error('CANCELLED'))
      this.pending.clear(); this.state('off')
    }
    if (this.prepared) this.state('ready')
  }
  private fail() { const request=this.request; this.stop(); this.state('error'); request?.onError?.() }
}
