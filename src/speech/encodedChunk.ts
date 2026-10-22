import type { LocalPart } from './localPlan'

export interface EncodedChunk {
  part: LocalPart
  wav: ArrayBuffer
  duration: number
  sampleRate: number
}

export function encodedKey(part: Pick<LocalPart, 'chunk' | 'start' | 'end'>): string {
  return `${part.chunk}:${part.start}:${part.end}`
}

export function cacheId(documentId: string, producerId: string, speed: number, part: Pick<LocalPart, 'chunk' | 'start' | 'end'>): string {
  return `${documentId}|${producerId}|${speed.toFixed(2)}|${encodedKey(part)}`
}
