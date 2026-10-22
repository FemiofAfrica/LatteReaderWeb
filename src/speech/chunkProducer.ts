/**
 * A voice that turns planned text into PCM. Kitten is the only producer today;
 * a later on-device voice can implement the same contract and reuse the WAV queue.
 */
export interface ProducedAudio {
  pcm: Float32Array
  sampleRate: number
  metrics?: { dropped?: number; readByOtherMeans?: number }
}

export interface ChunkProducer {
  readonly id: string
  readonly label: string
  generate(text: string, speed: number): Promise<ProducedAudio>
}

export type PrepareResult = 'ready' | 'not-cached' | 'error' | 'cancelled'

export interface LoadableProducer extends ChunkProducer {
  downloadedFiles: number
  readonly prepared: boolean
  prepare(options?: { allowNetwork?: boolean }): Promise<PrepareResult>
  dispose(): void
}

/** Default how far ahead of the playhead to generate, in seconds. */
export const DEFAULT_LOOKAHEAD_SECONDS = 5 * 60
/** Cap on audio held as playable blob URLs, slightly above the lookahead. */
export const MAX_BUFFERED_SECONDS = 8 * 60
/** Keep this much finished audio behind the playhead for a short rewind. */
export const RETAIN_BEHIND_SECONDS = 20
/** Pack consecutive parts into one WAV so a locked screen has a long current file. */
export const PACK_TARGET_SECONDS = 45
/** Start the next file before the current one ends, when more audio is already packed. */
export const UNDERRUN_GUARD_SECONDS = 1.5
