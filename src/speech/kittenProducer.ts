import type { LoadableProducer, PrepareResult, ProducedAudio } from './chunkProducer'

const builtWorker = () => new Worker(new URL('../workers/narrator.worker.ts', import.meta.url), { type: 'module' })

/**
 * Kitten Micro on-device producer. YarnGPT can later implement LoadableProducer
 * and feed the same WAV queue without changing playback.
 */
export class KittenProducer implements LoadableProducer {
  readonly id = 'kitten-micro-jasper'
  readonly label = 'Natural voice'
  downloadedFiles = 0
  private worker: Worker | null = null
  private serial = 0
  private pending = new Map<number, { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  private ready = false
  constructor(private failed?: () => void) {}

  get prepared(): boolean { return this.ready }

  private rpc(op: string, fields: Record<string, unknown> = {}) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++this.serial
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ op, id, ...fields })
    })
  }

  async prepare({ allowNetwork = true }: { allowNetwork?: boolean } = {}): Promise<PrepareResult> {
    this.disposeWorker()
    this.downloadedFiles = 0
    const worker = builtWorker()
    this.worker = worker
    worker.onmessage = ({ data }) => {
      if (worker !== this.worker) return
      const pending = this.pending.get(data.id)
      if (!pending) return
      this.pending.delete(data.id)
      if (data.ok) pending.resolve(data); else pending.reject(new Error(data.error))
    }
    worker.onerror = () => {
      if (worker !== this.worker) return
      window.dispatchEvent(new CustomEvent('latte-local-failed', { detail: { code: 'WORKER_FAILED' } }))
      this.failed?.()
      this.disposeWorker('WORKER_FAILED')
    }
    try {
      const init = await this.rpc('init', { allowNetwork })
      if (worker !== this.worker) return 'cancelled'
      this.downloadedFiles = Number(init.downloadedFiles) || 0
      this.ready = true
      window.dispatchEvent(new CustomEvent('latte-local-ready', { detail: init }))
      return 'ready'
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      if (message === 'CANCELLED') return 'cancelled'
      if (message === 'NOT_CACHED') {
        this.disposeWorker()
        return 'not-cached'
      }
      if (worker === this.worker) {
        window.dispatchEvent(new CustomEvent('latte-local-failed', { detail: { code: message } }))
        this.disposeWorker()
      }
      return 'error'
    }
  }

  async generate(text: string, speed: number): Promise<ProducedAudio> {
    if (!this.worker || !this.ready) throw new Error('INVALID_REQUEST')
    const result = await this.rpc('generate', { text, speed })
    const pcm = new Float32Array(result.pcm as ArrayBuffer)
    return { pcm, sampleRate: 24000, metrics: result.metrics as ProducedAudio['metrics'] }
  }

  dispose(): void { this.disposeWorker() }

  private disposeWorker(reason = 'CANCELLED'): void {
    this.ready = false
    this.worker?.terminate()
    this.worker = null
    for (const pending of this.pending.values()) pending.reject(new Error(reason))
    this.pending.clear()
  }
}
