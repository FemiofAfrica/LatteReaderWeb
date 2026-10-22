import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalNarratorEngine } from './LocalNarratorEngine'
import { planSpeechChunks } from '../domain/speechPlan'
import { AudioCache } from './audioCache'
import { cacheId, encodedKey } from './encodedChunk'
import { localParts } from './localPlan'
import type { LoadableProducer, ProducedAudio } from './chunkProducer'

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
  loop = false
  muted = false
  playCalls = 0
  pauseCalls = 0
  private _src = ''
  get src() { return this._src }
  set src(value: string) {
    const previous = this._src
    const wasPlaying = !this.paused && previous !== '' && previous !== value
    this._src = value
    if (wasPlaying) {
      this.dispatchEvent(new Event('pause'))
      super.dispatchEvent(new Event('ended'))
    }
    queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')))
  }
  play() { this.paused = false; this.playCalls += 1; return Promise.resolve() }
  pause() {
    this.paused = true
    this.pauseCalls += 1
    this.dispatchEvent(new Event('pause'))
  }
  load() {}
  dispatchEvent(event: Event): boolean {
    if (event.type === 'ended' && this.currentTime < 0.05) this.currentTime = 99
    return super.dispatchEvent(event)
  }
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
    const { engine, audio } = await ready(); engine.speak(request()); await tick()
    for (let i = 1; i < workers[0].requests.length; i++) {
      const data = workers[0].requests[i] as { answered?: boolean }
      if (data.answered) continue
      data.answered = true
      workers[0].reply(i, pcm()); await tick()
    }
    expect(audio.src).toMatch(/^blob:/)
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

class ScriptedProducer implements LoadableProducer {
  readonly id = 'test-voice'
  readonly label = 'Test'
  downloadedFiles = 0
  prepared = true
  texts: string[] = []
  failOn: ((text: string) => string | null) | null = null
  async prepare() { return 'ready' as const }
  dispose() {}
  async generate(text: string): Promise<ProducedAudio> {
    this.texts.push(text)
    const fail = this.failOn?.(text)
    if (fail) throw new Error(fail)
    return { pcm: new Float32Array(24000), sampleRate: 24000 }
  }
}

const flush = async (times = 24) => {
  for (let i = 0; i < times; i++) {
    await tick()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

describe('prepared audio identity, bounds and progress', () => {
  const page = (letter: string) => Array.from({ length: 12 }, () => `${letter.repeat(18)}. `).join('')

  it('does not play an earlier passage when starting from a later page after prepare', async () => {
    const producer = new ScriptedProducer()
    const cache = new AudioCache()
    const audio = new FakeAudio()
    const engine = new LocalNarratorEngine(vi.fn(), {
      producer, cache, createAudio: () => audio as unknown as HTMLAudioElement,
      lookaheadSeconds: 8, maxBufferedSeconds: 8, packTargetSeconds: 1,
    })
    const pages = [page('A'), page('B')]
    await engine.prepareDocument({ chunks: planSpeechChunks(pages, 1, 'document'), rate: 1, documentId: 'doc-pages' })
    await flush()
    const first = localParts(planSpeechChunks(pages, 1, 'document'))[0]!
    const later = localParts(planSpeechChunks(pages, 2, 'document'))[0]!
    expect(encodedKey(first)).toBe(encodedKey(later))
    expect(cacheId('doc-pages', producer.id, 1, first)).not.toBe(cacheId('doc-pages', producer.id, 1, later))
    expect((await cache.get(cacheId('doc-pages', producer.id, 1, first), false))?.part.text).toMatch(/A{8,}/)
    const onPage = vi.fn()
    const generated = producer.texts.length
    engine.speak({
      text: '', rate: 1, documentId: 'doc-pages', chunks: planSpeechChunks(pages, 2, 'document'),
      onPosition: vi.fn(), onPage, onError: vi.fn(),
    })
    await flush()
    expect(producer.texts.slice(generated).join('')).toMatch(/B{8,}/)
    expect(producer.texts.slice(generated).join('')).not.toMatch(/A{8,}/)
    expect(onPage).toHaveBeenCalledWith(2)
    expect(onPage).not.toHaveBeenCalledWith(1)
    engine.dispose()
  })

  it('keeps only a bounded playback window in memory while preparing the rest', async () => {
    const producer = new ScriptedProducer()
    const cache = new AudioCache()
    const audio = new FakeAudio()
    const engine = new LocalNarratorEngine(vi.fn(), {
      producer, cache, createAudio: () => audio as unknown as HTMLAudioElement,
      lookaheadSeconds: 2.5, maxBufferedSeconds: 4, packTargetSeconds: 1,
      preparePauseSeconds: 2, prepareResumeSeconds: 3,
    })
    const pages = Array.from({ length: 12 }, (_, index) => `Sentence ${index} keeps the reader moving along.`)
    const chunks = planSpeechChunks(pages, 1, 'document')
    engine.speak({ text: '', rate: 1, documentId: 'doc-long', chunks, onPosition: vi.fn(), onPage: vi.fn(), onError: vi.fn() })
    const preparing = engine.prepareDocument({ chunks, rate: 1, documentId: 'doc-long' })
    await flush(40)
    await preparing
    expect(engine.stats.maxBufferedSeconds).toBeLessThanOrEqual(5)
    expect(producer.texts.length).toBeGreaterThan(6)
    expect(cache.retained).toBeLessThan(producer.texts.length)
    engine.dispose()
  })

  it('reports ready-through as the last upcoming page, not only the current clip', async () => {
    const producer = new ScriptedProducer()
    const audio = new FakeAudio()
    const onAudioProgress = vi.fn()
    const engine = new LocalNarratorEngine(vi.fn(), {
      producer, cache: new AudioCache(), createAudio: () => audio as unknown as HTMLAudioElement,
      lookaheadSeconds: 25, maxBufferedSeconds: 30, packTargetSeconds: 0.5,
    })
    engine.speak({
      text: '', rate: 1, documentId: 'doc-ready',
      chunks: planSpeechChunks([
        Array.from({ length: 20 }, (_, index) => `One sentence ${index} on the opening page. `).join(''),
        Array.from({ length: 20 }, (_, index) => `Two sentence ${index} on the later page. `).join(''),
      ], 1, 'document'),
      onPosition: vi.fn(), onPage: vi.fn(), onError: vi.fn(), onAudioProgress,
    })
    await flush(40)
    const pages = onAudioProgress.mock.calls.map(call => call[0].lastReadyPage)
    expect(pages.at(-1)).toBe(2)
    expect(pages[0]).toBe(1)
    engine.dispose()
  })

  it('does not speak or highlight a failed prepare-only passage', async () => {
    const producer = new ScriptedProducer()
    producer.failOn = text => /^x+$/.test(text.trim()) ? 'TOKEN_LIMIT' : null
    const audio = new FakeAudio()
    const engine = new LocalNarratorEngine(vi.fn(), {
      producer, cache: new AudioCache(), createAudio: () => audio as unknown as HTMLAudioElement,
      lookaheadSeconds: 8, maxBufferedSeconds: 8, packTargetSeconds: 1,
    })
    const onPage = vi.fn()
    const onPosition = vi.fn()
    engine.speak({
      text: '', rate: 1, documentId: 'doc-skip',
      chunks: planSpeechChunks(['Hello there friend.'], 1, 'page'),
      onPosition, onPage, onError: vi.fn(),
    })
    await engine.prepareDocument({
      chunks: planSpeechChunks(['Hello there friend.', `${'x'.repeat(200)}.`], 1, 'document'),
      rate: 1, documentId: 'doc-skip',
    })
    await flush()
    expect(onPage).not.toHaveBeenCalledWith(2)
    expect(onPosition.mock.calls.some(call => String(call[0]) === '1')).toBe(false)
    engine.dispose()
  })

  it('clears lock-screen controls when reading finishes', async () => {
    const handlers = new Map<string, MediaSessionActionHandler | null>()
    const session = {
      metadata: null as MediaMetadata | null,
      playbackState: 'none',
      setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => { handlers.set(action, handler) },
      setPositionState: vi.fn(),
    }
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
    vi.stubGlobal('MediaMetadata', class {
      title = ''
      artist = ''
      constructor(init: MediaMetadataInit) { this.title = init.title ?? ''; this.artist = init.artist ?? '' }
    })
    const producer = new ScriptedProducer()
    const audio = new FakeAudio()
    const engine = new LocalNarratorEngine(vi.fn(), {
      producer, cache: new AudioCache(), createAudio: () => audio as unknown as HTMLAudioElement,
      lookaheadSeconds: 8, maxBufferedSeconds: 8, packTargetSeconds: 1,
    })
    const end = vi.fn()
    engine.onEnd(end)
    engine.speak({
      text: '', rate: 1, documentId: 'doc-end',
      chunks: planSpeechChunks(['Only one sentence.'], 1, 'document'),
      onPosition: vi.fn(), onPage: vi.fn(), onError: vi.fn(), title: 'A PDF',
    })
    await flush()
    expect(handlers.get('play')).toEqual(expect.any(Function))
    audio.dispatchEvent(new Event('ended'))
    await flush()
    expect(end).toHaveBeenCalled()
    expect(session.playbackState).toBe('none')
    expect(handlers.get('play')).toBeNull()
    engine.dispose()
  })

  it('fills playhead audio before background prepare and yields between prepare clips', async () => {
    const producer = new ScriptedProducer()
    const yields: number[] = []
    const engine = new LocalNarratorEngine(vi.fn(), {
      producer, cache: new AudioCache(), createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
      lookaheadSeconds: 2.5, maxBufferedSeconds: 4, packTargetSeconds: 1,
      preparePauseSeconds: 2, prepareResumeSeconds: 3,
      yieldPrepare: async () => { yields.push(producer.texts.length) },
    })
    const pages = Array.from({ length: 12 }, (_, index) => `Sentence ${index} keeps the reader moving along.`)
    const chunks = planSpeechChunks(pages, 1, 'document')
    engine.speak({ text: '', rate: 1, documentId: 'doc-priority', chunks, onPosition: vi.fn(), onPage: vi.fn(), onError: vi.fn() })
    void engine.prepareDocument({ chunks, rate: 1, documentId: 'doc-priority' })
    await flush(40)
    expect(producer.texts[0]).toMatch(/Sentence 0/)
    expect(producer.texts[1]).toMatch(/Sentence 1/)
    expect(yields.length).toBeGreaterThan(0)
    expect(yields[0]!).toBeGreaterThan(1)
    engine.dispose()
  })

  it('does not spend the voice on prepare while lookahead is thin', async () => {
    const producer = new ScriptedProducer()
    const engine = new LocalNarratorEngine(vi.fn(), {
      producer, cache: new AudioCache(), createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
      lookaheadSeconds: 2.5, maxBufferedSeconds: 4, packTargetSeconds: 1,
    })
    const pages = Array.from({ length: 12 }, (_, index) => `Sentence ${index} keeps the reader moving along.`)
    const chunks = planSpeechChunks(pages, 1, 'document')
    engine.speak({ text: '', rate: 1, documentId: 'doc-thin', chunks, onPosition: vi.fn(), onPage: vi.fn(), onError: vi.fn() })
    void engine.prepareDocument({ chunks, rate: 1, documentId: 'doc-thin' })
    await flush(40)
    expect(producer.texts.length).toBeGreaterThan(0)
    expect(producer.texts.length).toBeLessThanOrEqual(5)
    engine.dispose()
  })

  it('starts the HTMLAudioElement on real speech, never looping, without WebAudio', async () => {
    const producer = new ScriptedProducer()
    const audio = new FakeAudio()
    const created = vi.fn()
    vi.stubGlobal('AudioContext', class {
      constructor() { created() }
    })
    const engine = new LocalNarratorEngine(vi.fn(), {
      producer, cache: new AudioCache(), createAudio: () => audio as unknown as HTMLAudioElement,
      lookaheadSeconds: 8, maxBufferedSeconds: 12, packTargetSeconds: 1,
    })
    engine.speak({
      text: '', rate: 1, documentId: 'doc-first',
      chunks: planSpeechChunks(['First sentence starts now. Second keeps going.', 'Later page.'], 1, 'document'),
      onPosition: vi.fn(), onPage: vi.fn(), onError: vi.fn(),
    })
    await flush()
    expect(audio.src).toMatch(/^blob:/)
    expect(audio.paused).toBe(false)
    expect(audio.muted).toBe(false)
    expect(audio.loop).toBe(false)
    expect(created).not.toHaveBeenCalled()
    engine.dispose()
  })

  it('does not pause the element on visibilitychange, and concatenates later clips into one upcoming file', async () => {
    const producer = new ScriptedProducer()
    const audio = new FakeAudio()
    const handlers = new Map<string, MediaSessionActionHandler | null>()
    const session = {
      metadata: null as MediaMetadata | null,
      playbackState: 'none',
      setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => { handlers.set(action, handler) },
      setPositionState: vi.fn(),
    }
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
    vi.stubGlobal('MediaMetadata', class {
      title = ''
      artist = ''
      artwork: MediaImage[] = []
      constructor(init: MediaMetadataInit) {
        this.title = init.title ?? ''
        this.artist = init.artist ?? ''
        this.artwork = init.artwork ? [...init.artwork] : []
      }
    })
    const engine = new LocalNarratorEngine(vi.fn(), {
      producer, cache: new AudioCache(), createAudio: () => audio as unknown as HTMLAudioElement,
      lookaheadSeconds: 20, maxBufferedSeconds: 30, packTargetSeconds: 1,
    })
    engine.speak({
      text: '', rate: 1, documentId: 'doc-hide', title: 'A PDF',
      chunks: planSpeechChunks([
        Array.from({ length: 8 }, (_, index) => `Sentence ${index} on this page. `).join(''),
      ], 1, 'document'),
      onPosition: vi.fn(), onPage: vi.fn(), onError: vi.fn(),
    })
    await flush(40)
    expect(session.playbackState).toBe('playing')
    expect(handlers.get('play')).toEqual(expect.any(Function))
    expect(audio.src).toMatch(/^blob:/)
    const pauses = audio.pauseCalls
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(audio.pauseCalls).toBe(pauses)
    expect(audio.paused).toBe(false)
    expect(audio.loop).toBe(false)
    expect(session.playbackState).toBe('playing')
    audio.currentTime = 1
    audio.pause()
    await flush()
    expect(audio.paused).toBe(false)
    engine.dispose()
  })

  it('plays each passage once and in order across packs, hide, and duplicate ended', async () => {
    const producer = new ScriptedProducer()
    const audio = new FakeAudio()
    const onPosition = vi.fn()
    const engine = new LocalNarratorEngine(vi.fn(), {
      producer, cache: new AudioCache(), createAudio: () => audio as unknown as HTMLAudioElement,
      lookaheadSeconds: 30, maxBufferedSeconds: 40, packTargetSeconds: 1,
    })
    const text = Array.from({ length: 6 }, (_, index) => `Sentence ${index} is unique.`).join(' ')
    engine.speak({
      text: '', rate: 1, documentId: 'doc-order',
      chunks: planSpeechChunks([text], 1, 'document'),
      onPosition, onPage: vi.fn(), onError: vi.fn(),
    })
    await flush(40)
    for (let time = 0.05; time < 5; time += 1) {
      audio.currentTime = time
      audio.dispatchEvent(new Event('timeupdate'))
      await tick()
    }
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    audio.pause()
    await flush()
    audio.currentTime = 0
    audio.dispatchEvent(new Event('ended'))
    await flush()
    audio.currentTime = 0.05
    audio.dispatchEvent(new Event('timeupdate'))
    await tick()
    audio.currentTime = 0
    audio.dispatchEvent(new Event('ended'))
    audio.dispatchEvent(new Event('ended'))
    await flush()
    const heard = onPosition.mock.calls
      .filter(call => call[2] === 'audio-chunk')
      .map(call => `${call[0]}:${call[1]}`)
    expect(heard.length).toBeGreaterThan(1)
    expect(new Set(heard).size).toBe(heard.length)
    const starts = onPosition.mock.calls.filter(call => call[2] === 'audio-chunk').map(call => Number(call[1]))
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    engine.dispose()
  })
})
