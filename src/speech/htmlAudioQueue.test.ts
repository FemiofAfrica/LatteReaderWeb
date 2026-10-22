import { describe, expect, it, vi } from 'vitest'
import { HtmlAudioQueue } from './htmlAudioQueue'
import type { PackedSegment } from './audioPack'
import type { LocalPart } from './localPlan'

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

const part = (page: number, start: number): LocalPart => ({ text: `p${page}`, chunk: 0, start, end: start + 2, page, pageEnd: page })
const segment = (url: string, page: number, duration = 1): PackedSegment => ({
  url,
  duration,
  slices: [{ part: part(page, page), start: 0, duration }],
})

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
    await Promise.resolve(); await Promise.resolve()
    expect(audio.src).toBe('blob:two')
    audio.dispatchEvent(new Event('ended'))
    await Promise.resolve(); await Promise.resolve()
    expect(idle).toHaveBeenCalledOnce()
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
})
