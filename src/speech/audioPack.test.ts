import { describe, expect, it } from 'vitest'
import { contentSeconds, packChunks, takeOne, takePack } from './audioPack'
import { encodeWav } from './wav'
import type { EncodedChunk } from './encodedChunk'
import type { LocalPart } from './localPlan'

const part = (text: string, start: number): LocalPart => ({
  text, chunk: 0, start, end: start + text.length, page: 1, pageEnd: 1,
})

const chunk = (text: string, start: number, seconds: number): EncodedChunk => ({
  part: part(text, start),
  wav: encodeWav(new Float32Array(seconds * 24000), 24000),
  duration: seconds,
  sampleRate: 24000,
})

describe('packed playback files', () => {
  it('starts with one part and concatenates the rest into a longer file', () => {
    const chunks = [chunk('One.', 0, 1), chunk('Two.', 4, 1), chunk('Three.', 8, 1)]
    const first = takeOne(chunks)
    expect(first).toHaveLength(1)
    expect(first[0]?.part.text).toBe('One.')
    expect(chunks).toHaveLength(2)
    const rest = takePack(chunks, 30)
    expect(contentSeconds(rest)).toBe(2)
    const packed = packChunks(rest)
    expect(packed.contentDuration).toBe(2)
    expect(packed.slices).toHaveLength(2)
    expect(packChunks(first).id).not.toBe(packed.id)
  })

  it('pads a short first file to five seconds without inventing spoken slices', () => {
    const packed = packChunks([chunk('Hi.', 0, 1)], 5)
    expect(packed.contentDuration).toBe(1)
    expect(packed.duration).toBe(5)
    expect(packed.slices).toHaveLength(1)
  })
})
