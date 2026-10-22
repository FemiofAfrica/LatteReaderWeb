import { describe, expect, it, vi } from 'vitest'
import { HtmlAudioQueue } from './htmlAudioQueue'
import type { PackedSegment } from './audioPack'
import type { LocalPart } from './localPlan'

class FakeAudio extends EventTarget {
  currentTime = 0
  paused = true
  loop = false
  muted = false
  ended = false
  autoReady = true
  playCalls = 0
  pauseCalls = 0
  private _src = ''
  get src() { return this._src }
  set src(value: string) {
    const previous = this._src
    const wasPlaying = !this.paused && previous !== '' && previous !== value
    this._src = value
    this.ended = false
    if (wasPlaying) {
      this.dispatchEvent(new Event('pause'))
      super.dispatchEvent(new Event('ended'))
    }
    if (this.autoReady) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')))
  }
  completeLoad() { this.dispatchEvent(new Event('loadedmetadata')) }
  play() { this.paused = false; this.ended = false; this.playCalls += 1; return Promise.resolve() }
  pause() {
    this.paused = true
    this.pauseCalls += 1
    this.dispatchEvent(new Event('pause'))
  }
  load() {}
  removeAttribute(name: string) { if (name === 'src') this._src = '' }
  remove() {}
}

let packIds = 1
const part = (page: number, start: number, text = `p${page}`): LocalPart => ({
  text, chunk: 0, start, end: start + text.length, page, pageEnd: page,
})
const segment = (url: string, page: number, duration = 1, extras: PackedSegment['slices'] = []): PackedSegment => ({
  id: packIds++,
  url,
  duration,
  contentDuration: duration,
  slices: extras.length ? extras : [{ part: part(page, page), start: 0, duration }],
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
    expect(audio.loop).toBe(false)
    expect(slices).toEqual([1])
    audio.currentTime = 1
    audio.dispatchEvent(new Event('ended'))
    await flush()
    expect(audio.src).toBe('blob:two')
    audio.currentTime = 1
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

  it('advances on native ended even when Chrome has reset currentTime to 0', async () => {
    const audio = new FakeAudio()
    const ends = vi.fn()
    const idle = vi.fn()
    const queue = new HtmlAudioQueue(audio as unknown as HTMLAudioElement, {
      onSlice: vi.fn(),
      onSegmentEnd: ends,
      onIdle: idle,
      onError: vi.fn(),
    })
    queue.enqueue(segment('blob:one', 1, 5))
    queue.enqueue(segment('blob:two', 2, 5))
    await queue.play()
    const plays = audio.playCalls
    audio.currentTime = 0
    audio.dispatchEvent(new Event('ended'))
    audio.pause()
    await flush()
    expect(ends).toHaveBeenCalledTimes(1)
    expect(audio.src).toBe('blob:two')
    expect(audio.playCalls).toBeGreaterThan(plays)
    expect(idle).not.toHaveBeenCalled()
  })

  it('does not replay the same src when a finished clip pauses at currentTime 0', async () => {
    const audio = new FakeAudio()
    const ends = vi.fn()
    const idle = vi.fn()
    const queue = new HtmlAudioQueue(audio as unknown as HTMLAudioElement, {
      onSlice: vi.fn(),
      onSegmentEnd: ends,
      onIdle: idle,
      onError: vi.fn(),
    })
    queue.enqueue(segment('blob:one', 1, 5))
    await queue.play()
    const plays = audio.playCalls
    audio.currentTime = 0
    audio.dispatchEvent(new Event('ended'))
    audio.pause()
    await flush()
    expect(ends).toHaveBeenCalledTimes(1)
    expect(idle).toHaveBeenCalledOnce()
    expect(audio.playCalls).toBe(plays)
  })

  it('ignores a mid-clip ended and a double ended so each pack plays once', async () => {
    const audio = new FakeAudio()
    const slices: string[] = []
    const ends = vi.fn()
    const queue = new HtmlAudioQueue(audio as unknown as HTMLAudioElement, {
      onSlice: slice => slices.push(slice.part.text),
      onSegmentEnd: ends,
      onIdle: vi.fn(),
      onError: vi.fn(),
    })
    const first = segment('blob:one', 1, 5, [{ part: part(1, 0, 'One.'), start: 0, duration: 5 }])
    const second = segment('blob:two', 1, 3, [
      { part: part(1, 4, 'Two.'), start: 0, duration: 1 },
      { part: part(1, 8, 'Three.'), start: 1, duration: 1 },
      { part: part(1, 14, 'Four.'), start: 2, duration: 1 },
    ])
    queue.enqueue(first)
    queue.enqueue(second)
    await queue.play()
    audio.currentTime = 0.2
    audio.dispatchEvent(new Event('ended'))
    await flush()
    expect(audio.src).toBe('blob:one')
    expect(ends).not.toHaveBeenCalled()
    audio.currentTime = 0
    audio.dispatchEvent(new Event('ended'))
    await flush()
    expect(audio.src).toBe('blob:two')
    expect(ends).toHaveBeenCalledTimes(1)
    audio.currentTime = 3
    audio.dispatchEvent(new Event('ended'))
    audio.dispatchEvent(new Event('ended'))
    await flush()
    expect(ends).toHaveBeenCalledTimes(2)
    expect(slices.filter(text => text === 'One.')).toHaveLength(1)
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

  it('does not pause when the page is hidden, and resumes only a mid-clip pause', async () => {
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
    audio.currentTime = 2
    const time = audio.currentTime
    audio.pause()
    await flush()
    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBe(time)
    expect(audio.playCalls).toBeGreaterThan(1)
  })

  it('never enables looping, including unlock before the first pack', async () => {
    const audio = new FakeAudio()
    const queue = new HtmlAudioQueue(audio as unknown as HTMLAudioElement, { onSlice: vi.fn(), onIdle: vi.fn(), onError: vi.fn() })
    await queue.unlock()
    expect(audio.loop).toBe(false)
    queue.enqueue(segment('blob:one', 1, 5))
    await queue.play()
    expect(audio.loop).toBe(false)
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
