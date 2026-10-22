import { describe, expect, it } from 'vitest'
import { encodeWav } from './wav'
import { packChunks } from './audioPack'
import type { LocalPart } from './localPlan'

/**
 * Master played PCM through WebAudio as soon as one part returned.
 * The HTMLAudio path adds WAV encode + blob URL + loadedmetadata. First audio
 * must still start after that first part, not after a 45s pack.
 */
describe('time-to-first-audio vs the just-in-time engine', () => {
  it('encodes and packs the first part without waiting for later parts', () => {
    const part = (text: string): LocalPart => ({ text, chunk: 0, start: 0, end: text.length, page: 1, pageEnd: 1 })
    const pcm = new Float32Array(24000)
    const wavStarted = performance.now()
    const wav = encodeWav(pcm, 24000)
    const packed = packChunks([{ part: part('First sentence.'), wav, duration: 1, sampleRate: 24000 }], 5)
    const htmlPathMs = performance.now() - wavStarted
    expect(packed.contentDuration).toBe(1)
    expect(packed.duration).toBe(5)
    expect(htmlPathMs).toBeLessThan(100)
  })
})
