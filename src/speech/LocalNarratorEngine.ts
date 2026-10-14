import type { SpeechEngine, SpeechRequest } from './SpeechEngine'
import { localParts, type LocalPart } from './localPlan'

type AudioPart = { part: LocalPart; buffer: AudioBuffer }
export type LocalStatus = 'off' | 'preparing' | 'ready' | 'buffering' | 'playing' | 'paused' | 'error'

/** True only under the private loopback preview, which injects this flag itself. */
const privateTrial = () => (globalThis as { __LATTE_PRIVATE_NARRATOR__?: boolean }).__LATTE_PRIVATE_NARRATOR__ === true

/**
 * The public runtime is the worker this app builds and serves itself. It loads
 * the pinned assets from `/voice/narrator/`, our own origin only.
 *
 * The private trial keeps its own worker, served exclusively by
 * `scripts/private-narrator-preview.mjs` from assets that stay outside the
 * repository, so the user's own device testing is unaffected by publication.
 */
const builtWorker = () => new Worker(new URL('../workers/narrator.worker.ts', import.meta.url), { type: 'module' })
const trialWorker = () => new Worker('/__narrator/worker.mjs', { type: 'module' })

/**
 * One inference in flight, current plus two ready buffers, <=30s of ready PCM.
 * Cancellation invalidates results; pause preserves the rendered sample offset.
 */
export class LocalNarratorEngine implements SpeechEngine {
  readonly id = 'kitten-micro-jasper'
  readonly label = 'Local narrator (Jasper)'
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
  readonly stats = { generated: 0, underruns: 0, maxBufferedSeconds: 0, resumedOffset: 0 }
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
  async prepare() {
    this.dispose(); this.state('preparing')
    const worker = privateTrial() ? trialWorker() : builtWorker()
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
      const init = await this.rpc('init')
      if (worker !== this.worker) return
      this.prepared = true
      // Content-free: which pinned bytes the worker verified before it started,
      // and nothing about the document.
      window.dispatchEvent(new CustomEvent('latte-local-ready', { detail: init }))
      this.state('ready')
    } catch (error) {
      if (worker === this.worker) {
        // A fixed reason code and nothing else: no document text, no filename.
        window.dispatchEvent(new CustomEvent('latte-local-failed', { detail: { code: String((error as Error)?.message ?? error) } }))
        this.dispose()
        this.state('error')
      }
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
    let mid = Math.floor(part.text.length/2)
    if (/[\uD800-\uDBFF]/.test(part.text[mid-1])) mid--
    if (mid < 1) throw Error('UNSPLITTABLE')
    const chunk = this.request!.chunks![part.chunk]
    const make = (start:number,end:number):LocalPart => {
      const spans=chunk.spans.filter(s=>s.end>start&&s.start<end)
      return {...part,text:chunk.text.slice(start,end),start,end,page:spans[0]?.pageNumber??part.page,pageEnd:spans.at(-1)?.pageNumber??part.pageEnd}
    }
    this.parts.unshift(make(part.start,part.start+mid),make(part.start+mid,part.end))
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
          if ((e as Error).message === 'TOKEN_LIMIT') { this.split(part); continue }
          throw e
        } finally { this.busy = false }
        if (run !== this.run) return
        const pcm = new Float32Array(result.pcm as ArrayBuffer)
        if (!pcm.length || !pcm.every(Number.isFinite)) throw Error('INVALID_PCM')
        if (pcm.length/24000 > 15) { this.split(part); continue }
        const buffer = this.context!.createBuffer(1,pcm.length,24000)
        buffer.copyToChannel(pcm,0)
        this.queue.push({part,buffer}); this.stats.generated++
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
      if (!this.parts.length && !this.busy && !this.pumping) { this.request = null; this.state('ready'); this.ended() }
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
