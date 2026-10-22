import { describe, expect, it, vi } from 'vitest'
import { HtmlAudioQueue } from './htmlAudioQueue'
import type { PackedSegment } from './audioPack'
import type { LocalPart } from './localPlan'

class FakeAudio extends EventTarget {
  currentTime = 0
  paused = true
  loop = false
  muted = false
  autoReady = true
  playCalls = 0
  pauseCalls = 0
  private _src = ''
  get src() { return this._src }
  set src(value: string) {
    this._src = value
    if (this.autoReady) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')))
  }
  completeLoad() { this.dispatchEvent(new Event('loadedmetadata')) }
  play() { this.paused = false; this.playCalls += 1; return Promise.resolve() }
  pause() {
    this.paused = true
    this.pauseCalls += 1
    this.dispatchEvent(new Event('pause'))
  }
  load() {}
  removeAttribute(name: string) { if (name === 'src') this._src = '' }
  remove() {}
}

const part = (page: number, start: number): LocalPart => ({ text: `p${page}`, chunk: 0, start, end: start + 2, page, pageEnd: page })
const segment = (url: string, page: number, duration = 1): PackedSegment => ({
  url,
  duration,
  contentDuration: duration,
  slices: [{ part: part(page, page), start: 0, duration }],
})

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('HTML audio queue', () => {
  it('plays the next packed file when the current one ends', async () => {
    const audio = new FakeAudio()
    const slices: number[] = []
    const idle = vi.fn()
    const queue = new HtmlAudioQueue(audio as unknown as HTMLAudioElement, {
      onSlice: slice => slices.push(slice.part.page),
      onIdle: idle,
      onError: vi.fn(),
    })
    queue.enqueue(segment('blob:one', 1))
    queue.enqueue(segment('blob:two', 2))
    await queue.play()
    expect(audio.src).toBe('blob:one')
    expect(slices).toEqual([1])
    audio.dispatchEvent(new Event('ended'))
    await flush()
    expect(audio.src).toBe('blob:two')
    audio.dispatchEvent(new Event('ended'))
    await flush()
    expect(idle).toHaveBeenCalledOnce()
  })

  it('does not carry the previous clip time into the next file', async () => {
    const audio = new FakeAudio()
    const queue = new HtmlAudioQueue(audio as unknown as HTMLAudioElement, { onSlice: vi.fn(), onIdle: vi.fn(), onError: vi.fn() })
    queue.enqueue(segment('blob:one', 1, 4))
    queue.enqueue(segment('blob:two', 2, 4))
    await queue.play()
    audio.currentTime = 3.8
    audio.dispatchEvent(new Event('ended'))
    void queue.play()
    await flush()
    expect(audio.src).toBe('blob:two')
    expect(audio.currentTime).toBe(0)
  })

  it('keeps a single upcoming blob when later packs replace it', async () => {
    const audio = new FakeAudio()
    const queue = new HtmlAudioQueue(audio as unknown as HTMLAudioElement, { onSlice: vi.fn(), onIdle: vi.fn(), onError: vi.fn() })
    queue.enqueue(segment('blob:one', 1, 5))
    queue.replaceUpcoming(segment('blob:long', 2, 40))
    queue.replaceUpcoming(segment('blob:longer', 2, 80))
    await queue.play()
    expect(queue.upcomingSegments).toHaveLength(1)
    expect(queue.upcomingSegments[0]?.url).toBe('blob:longer')
  })

  it('does not pause when the page is hidden, and resumes if the element is paused without a user pause', async () => {
    const audio = new FakeAudio()
    const queue = new HtmlAudioQueue(audio as unknown as HTMLAudioElement, { onSlice: vi.fn(), onIdle: vi.fn(), onError: vi.fn() })
    queue.enqueue(segment('blob:one', 1, 8))
    await queue.play()
    const pauses = audio.pauseCalls
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    queue.ensurePlaying()
    expect(audio.pauseCalls).toBe(pauses)
    expect(audio.paused).toBe(false)
    audio.pause()
    await flush()
    expect(audio.paused).toBe(false)
    expect(audio.playCalls).toBeGreaterThan(1)
  })

  it('pauses and resumes the same element without changing the source', async () => {
    const audio = new FakeAudio()
    const queue = new HtmlAudioQueue(audio as unknown as HTMLAudioElement, { onSlice: vi.fn(), onIdle: vi.fn(), onError: vi.fn() })
    queue.enqueue(segment('blob:one', 1, 4))
    await queue.play()
    audio.currentTime = 1.2
    queue.pause()
    expect(audio.paused).toBe(true)
    await queue.resume()
    expect(audio.paused).toBe(false)
    expect(audio.src).toBe('blob:one')
    expect(audio.currentTime).toBe(1.2)
  })

  it('does not start a clip that finished loading after pause', async () => {
    const audio = new FakeAudio()
    audio.autoReady = false
    const queue = new HtmlAudioQueue(audio as unknown as HTMLAudioElement, { onSlice: vi.fn(), onIdle: vi.fn(), onError: vi.fn() })
    queue.enqueue(segment('blob:one', 1, 4))
    const playing = queue.play()
    queue.pause()
    audio.completeLoad()
    await playing
    await flush()
    expect(queue.isPaused).toBe(true)
    expect(audio.paused).toBe(true)
  })
})
