import type { EncodedChunk } from './encodedChunk'
import type { LocalPart } from './localPlan'
import { concatWav } from './wav'

export interface PackedSlice {
  part: LocalPart
  start: number
  duration: number
}

export interface PackedSegment {
  url: string
  duration: number
  slices: PackedSlice[]
}

export function packChunks(chunks: readonly EncodedChunk[]): PackedSegment {
  const slices: PackedSlice[] = []
  let start = 0
  for (const chunk of chunks) {
    slices.push({ part: chunk.part, start, duration: chunk.duration })
    start += chunk.duration
  }
  const wav = concatWav(chunks.map(chunk => chunk.wav))
  const blob = new Blob([wav], { type: 'audio/wav' })
  return { url: URL.createObjectURL(blob), duration: start, slices }
}

/** Take a prefix of unpacked audio up to `targetSeconds`, always at least one chunk. */
export function takePack(chunks: EncodedChunk[], targetSeconds: number): EncodedChunk[] {
  if (!chunks.length) return []
  const taken: EncodedChunk[] = [chunks[0]!]
  let duration = chunks[0]!.duration
  for (let i = 1; i < chunks.length && duration < targetSeconds; i += 1) {
    taken.push(chunks[i]!)
    duration += chunks[i]!.duration
  }
  chunks.splice(0, taken.length)
  return taken
}
