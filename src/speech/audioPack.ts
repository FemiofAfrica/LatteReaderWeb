import type { EncodedChunk } from './encodedChunk'
import type { LocalPart } from './localPlan'
import { concatWav, padWav } from './wav'

export interface PackedSlice {
  part: LocalPart
  start: number
  duration: number
}

export interface PackedSegment {
  url: string
  /** File duration, including trailing silence used for a media notification. */
  duration: number
  /** Spoken duration only. Lookahead and handoff use this, not padded silence. */
  contentDuration: number
  slices: PackedSlice[]
}

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
  return { url: URL.createObjectURL(blob), duration, contentDuration, slices }
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
