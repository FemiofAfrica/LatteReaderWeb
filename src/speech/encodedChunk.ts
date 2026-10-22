import type { LocalPart } from './localPlan'

export interface EncodedChunk {
  part: LocalPart
  wav: ArrayBuffer
  duration: number
  sampleRate: number
}

/** In-run identity for the slice currently playing. Not used as a cache key. */
export function encodedKey(part: Pick<LocalPart, 'chunk' | 'start' | 'end'>): string {
  return `${part.chunk}:${part.start}:${part.end}`
}

/** FNV-1a so the same passage hashes the same way across visits. */
export function hashText(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/**
 * Stable identity for a spoken passage. `planSpeechChunks` renumbers from zero
 * for every from-page plan, so chunk/start/end collide across pages.
 */
export function passageKey(part: Pick<LocalPart, 'page' | 'text'>): string {
  return `${part.page}:${hashText(part.text)}`
}

export function cacheId(
  documentId: string,
  producerId: string,
  speed: number,
  part: Pick<LocalPart, 'page' | 'text'>,
): string {
  return `${documentId}|${producerId}|${speed.toFixed(2)}|${passageKey(part)}`
}
