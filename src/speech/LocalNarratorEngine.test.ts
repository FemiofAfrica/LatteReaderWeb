import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalNarratorEngine } from './LocalNarratorEngine'
import { planSpeechChunks } from '../domain/speechPlan'
import { AudioCache } from './audioCache'

vi.mock('../diagnostics/diagnostics', () => ({ recordEvent: vi.fn() }))

let workers: FakeWorker[] = []
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  requests: Record<string, unknown>[] = []
  terminated = false
  constructor() { workers.push(this) }
  postMessage(data: Record<string, unknown>) { this.requests.push(data) }
  terminate() { this.terminated = true }
  reply(index: number, extra: Record<string, unknown> = {}) {
    const data = this.requests[index]
    this.onmessage?.({ data: { id: data.id, ok: true, ...extra } })
  }
}
class FakeAudio extends EventTarget {
  currentTime = 0
  paused = true
  private _src = ''
  get src() { return this._src }
  set src(value: string) {
    this._src = value
    queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')))
  }
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
  load() {}
  removeAttribute(name: string) { if (name === 'src') this._src = '' }
  remove() {}
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const notices: unknown[] = []
let urls = 0
beforeEach(() => {
  workers = []; notices.length = 0; urls = 0
  vi.stubGlobal('Worker', FakeWorker)
  URL.createObjectURL = vi.fn(() => `blob:test:${++urls}`) as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn()
  window.addEventListener('latte-local-notice', e => notices.push((e as CustomEvent).detail))
})
async function ready() {
  const audio = new FakeAudio()
  const engine = new LocalNarratorEngine(vi.fn(), {
    createAudio: () => audio as unknown as HTMLAudioElement,
    lookaheadSeconds: 2.5,
    maxBufferedSeconds: 4,
    packTargetSeconds: 1,
    cache: new AudioCache(),
  })
  const pending = engine.prepare()
  workers[0].reply(0)
  await pending
  return { engine, audio }
}
const request = (text = 'A short sentence. Another sentence. Third sentence. Fourth sentence.') => ({
  text: '', rate: 1, chunks: planSpeechChunks([text], 1, 'document'), onPosition: vi.fn(), onPage: vi.fn(), onError: vi.fn(),
})
const pcm = (dropped = 0) => ({ pcm: new Float32Array(24000).buffer, metrics: { rtf: 0.2, dropped, contained: dropped > 0 } })

describe('private PCM lifecycle (control mocks, not audible evidence)', () => {
  it('does not prepare until explicit consent and cancels preparation', async () => {
    const engine = new LocalNarratorEngine(vi.fn(), { createAudio: () => new FakeAudio() as unknown as HTMLAudioElement })
    expect(workers).toHaveLength(0)
    const preparing = engine.prepare(); engine.dispose(); await preparing
    expect(workers[0].terminated).toBe(true); expect(engine.available).toBe(false)
  })
  it('pauses at the element offset and resumes without synthesis', async () => {
    const { engine, audio } = await ready(); engine.speak(request()); await tick(); workers[0].reply(1, pcm()); await tick()
    audio.currentTime = .4; engine.pause(); const count = workers[0].requests.length
    engine.resume(); await tick(); expect(audio.paused).toBe(false); expect(audio.currentTime).toBe(.4)
    expect(workers[0].requests).toHaveLength(count)
    engine.dispose()
  })
  it('ignores late inference after Stop and does not start playback', async () => {
    const { engine, audio } = await ready(); const r = request(); engine.speak(r); await tick(); expect(r.onPosition).not.toHaveBeenCalled()
    engine.stop(); workers[0].reply(1, pcm()); await tick()
    expect(r.onPosition).not.toHaveBeenCalled()
    expect(audio.paused).toBe(true)
    engine.dispose()
  })
  it('holds a bounded lookahead and emits one end after drain', async () => {
    const { engine, audio } = await ready(); const end = vi.fn(); engine.onEnd(end); engine.speak(request()); await tick()
    for (let round = 0; round < 12 && end.mock.calls.length === 0; round++) {
      for (let i = 1; i < workers[0].requests.length; i++) {
        const data = workers[0].requests[i] as { answered?: boolean }
        if (data.answered) continue
        data.answered = true
        workers[0].reply(i, pcm()); await tick()
      }
      expect(engine.stats.maxBufferedSeconds).toBeLessThanOrEqual(4)
      audio.dispatchEvent(new Event('ended')); await tick()
    }
    expect(engine.stats.maxBufferedSeconds).toBeGreaterThan(0)
    expect(end).toHaveBeenCalledTimes(1); expect(engine.status).toBe('ready'); engine.dispose()
  })
  it('splits overbudget text only at word boundaries with exact coverage', async () => {
    const { engine } = await ready(); const text = 'longword '.repeat(24); engine.speak(request(text)); await tick()
    workers[0].onmessage?.({ data: { id: workers[0].requests[1].id, ok: false, error: 'TOKEN_LIMIT' } }); await tick()
    const first = String(workers[0].requests[2].text); workers[0].reply(2, pcm()); await tick()
    expect(first + workers[0].requests[3].text).toBe(text.trim()); expect(first.endsWith(' ')).toBe(true); engine.dispose()
  })
  it('skips an indivisible refused word, advances the position, and keeps reading the next sentence', async () => {
    const { engine, audio } = await ready(); const end = vi.fn(); engine.onEnd(end)
    const r = request('x'.repeat(200) + '. Next sentence.'); engine.speak(r); await tick()
    for (let round = 0; round < 6; round++) {
      for (let i = 1; i < workers[0].requests.length; i++) {
        const data = workers[0].requests[i] as { id: number; text?: string; answered?: boolean }
        if (data.answered) continue
        data.answered = true
        if (/^x+$/.test(String(data.text).trim()) || String(data.text).includes('x'.repeat(20))) {
          workers[0].onmessage?.({ data: { id: data.id, ok: false, error: 'TOKEN_LIMIT' } })
        } else {
          workers[0].reply(i, pcm())
        }
        await tick()
      }
      audio.dispatchEvent(new Event('ended')); await tick()
    }
    expect(r.onError).not.toHaveBeenCalled()
    expect(engine.status).toBe('ready')
    expect(engine.stats.skipped).toBeGreaterThan(0)
    expect(r.onPosition).toHaveBeenCalled()
    expect(notices.length).toBeGreaterThan(0)
    expect(end).toHaveBeenCalledTimes(1)
    engine.dispose()
  })
  it('a refused passage never halts the run (stall regression)', async () => {
    const { engine, audio } = await ready(); const end = vi.fn(); engine.onEnd(end)
    const r = request('One. Two has 12% growth. Three.'); engine.speak(r); await tick()
    const worker = workers[0]
    for (let round = 0; round < 12; round++) {
      const answered = (worker as unknown as { _answered?: Set<number> })
      answered._answered ??= new Set<number>()
      for (let i = 1; i < worker.requests.length; i++) {
        if (answered._answered.has(i)) continue
        const text = String(worker.requests[i].text)
        if (text.includes('%')) worker.onmessage?.({ data: { id: worker.requests[i].id, ok: false, error: 'UNSUPPORTED_TEXT' } })
        else worker.reply(i, pcm())
        answered._answered.add(i)
        await tick()
      }
      audio.dispatchEvent(new Event('ended')); await tick()
    }
    expect(r.onError).not.toHaveBeenCalled()
    expect(engine.status).toBe('ready')
    expect(end).toHaveBeenCalledTimes(1)
    expect(engine.stats.skipped + engine.stats.generated).toBeGreaterThan(1)
    engine.dispose()
  })
  it('a mid-run generation failure does not halt playback of the remaining document', async () => {
    const { engine, audio } = await ready(); const end = vi.fn(); engine.onEnd(end)
    const r = request('First sentence. Second sentence. Third sentence.'); engine.speak(r); await tick()
    workers[0].reply(1, pcm()); await tick()
    const failId = workers[0].requests[2]?.id
    workers[0].onmessage?.({ data: { id: failId, ok: false, error: 'INFERENCE_FAILED' } }); await tick()
    for (let i = 3; i < workers[0].requests.length; i++) { workers[0].reply(i, pcm()); await tick() }
    audio.dispatchEvent(new Event('ended')); await tick()
    for (let i = 0; i < 8; i++) {
      for (let j = 1; j < workers[0].requests.length; j++) {
        const data = workers[0].requests[j]
        if (!(data as { answered?: boolean }).answered) {
          (data as { answered?: boolean }).answered = true; workers[0].reply(j, pcm()); await tick()
        }
      }
      audio.dispatchEvent(new Event('ended')); await tick()
    }
    expect(r.onError).not.toHaveBeenCalled()
    expect(end).toHaveBeenCalledTimes(1)
    expect(engine.status).toBe('ready')
    expect(engine.stats.generated).toBeGreaterThan(0)
    engine.dispose()
  })
  it('a contained part with a dropped unit raises the plain notice without stopping', async () => {
    const { engine, audio } = await ready(); const end = vi.fn(); engine.onEnd(end)
    const r = request('One short sentence.'); engine.speak(r); await tick()
    workers[0].reply(1, pcm(1)); await tick()
    audio.dispatchEvent(new Event('ended')); await tick()
    expect(notices.some(notice => (notice as { dropped?: number }).dropped === 1)).toBe(true)
    expect(r.onError).not.toHaveBeenCalled()
    expect(end).toHaveBeenCalledTimes(1)
    engine.dispose()
  })
  it('prepare whole document is cancellable and later play reuses cached audio', async () => {
    const { engine, audio } = await ready()
    const chunks = planSpeechChunks(['First sentence. Second sentence.'], 1, 'document')
    const preparing = engine.prepareDocument({ chunks, rate: 1, documentId: 'doc-1' })
    for (let i = 0; i < 40 && workers[0].requests.length < 2; i++) {
      await tick()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(workers[0].requests.length).toBeGreaterThan(1)
    workers[0].reply(1, pcm()); await tick()
    engine.cancelPrepare()
    await preparing
    const afterCancel = workers[0].requests.length
    await tick()
    expect(workers[0].requests.length).toBe(afterCancel)
    const r = request('First sentence. Second sentence.')
    engine.speak({ ...r, documentId: 'doc-1' }); await tick()
    for (let i = 1; i < workers[0].requests.length; i++) {
      const data = workers[0].requests[i] as { answered?: boolean }
      if (data.answered) continue
      data.answered = true
      workers[0].reply(i, pcm()); await tick()
    }
    audio.dispatchEvent(new Event('ended')); await tick()
    expect(r.onError).not.toHaveBeenCalled()
    engine.dispose()
  })
})
