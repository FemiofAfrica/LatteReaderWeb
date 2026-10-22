import type { EncodedChunk } from './encodedChunk'
import type { LocalPart } from './localPlan'
import { concatWav, padWav } from './wav'

export interface PackedSlice {
  part: LocalPart
  start: number
  duration: number
}

export interface PackedSegment {
  /** Monotonic id so a stale `ended` cannot finish the same pack twice. */
  id: number
  url: string
  duration: number
  contentDuration: number
  slices: PackedSlice[]
}

let nextPackedId = 1

export function packChunks(chunks: readonly EncodedChunk[], minDuration = 0): PackedSegment {
  const slices: PackedSlice[] = []
  let start = 0
  for (const chunk of chunks) {
    slices.push({ part: chunk.part, start, duration: chunk.duration })
    start += chunk.duration
  }
  let wav = concatWav(chunks.map(chunk => chunk.wav))
  const contentDuration = start
  const duration = Math.max(contentDuration, minDuration)
  if (duration > contentDuration) wav = padWav(wav, duration)
  const blob = new Blob([wav], { type: 'audio/wav' })
  return { id: nextPackedId++, url: URL.createObjectURL(blob), duration, contentDuration, slices }
}

/** The first spoken part, so playback can start without waiting for a long pack. */
export function takeOne(chunks: EncodedChunk[]): EncodedChunk[] {
  return chunks.length ? chunks.splice(0, 1) : []
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

export function contentSeconds(chunks: readonly EncodedChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.duration, 0)
}
