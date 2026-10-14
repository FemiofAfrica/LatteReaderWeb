/** The one status line the reader shows for playback.
 *
 * It feeds the mobile status bar, the desktop readout and the hidden live
 * region, so it is resolved once, in one place, from one value. Order matters:
 * a broken extraction outranks everything, and a local voice that is still
 * loading is not a failure.
 */

export type VoiceEngine = 'browser' | 'local'
export type LocalVoiceStatus = 'off' | 'preparing' | 'ready' | 'buffering' | 'playing' | 'paused' | 'error'
export type PlaybackDisplay = 'Ready' | 'Reading' | 'Paused' | 'Stopped' | 'Finished' | 'Waiting for text' | 'Voice unavailable' | 'Reading error'

export interface ReadingStatusInput {
  extraction: 'loading' | 'extracting' | 'complete' | 'error' | undefined
  pagesWithReadableText: number
  engine: VoiceEngine
  localStatus: LocalVoiceStatus
  /** The engine reports itself usable only once a voice is actually loaded. */
  voiceAvailable: boolean
  playback: { status: 'ready' | 'playing' | 'paused'; display?: PlaybackDisplay }
}

export function readingStatusText(input: ReadingStatusInput): string {
  if (input.extraction === 'error') return 'Text extraction error'
  if (input.engine === 'local') {
    // The local model load takes tens of seconds and is not a fault, so it must
    // never read as "Voice unavailable" while it runs.
    if (input.localStatus === 'preparing') return 'Loading local voice'
    if (input.localStatus === 'buffering') return 'Buffering local voice'
    if (input.localStatus === 'error') return 'Voice unavailable'
  } else if (!input.voiceAvailable) {
    return 'Voice unavailable'
  }
  if (input.extraction === 'complete' && !input.pagesWithReadableText) return 'No readable text'
  return input.playback.display ?? 'Ready'
}

/** Plain-language panel line for the private local narrator. */
export function localVoiceCopy(localStatus: LocalVoiceStatus): string {
  if (localStatus === 'ready') return 'Voice ready. Press Play.'
  if (localStatus === 'error') return 'Local voice failed. Retry or use Browser default.'
  if (localStatus === 'preparing') return 'Loading the local voice. This can take up to a minute.'
  return `Local voice: ${localStatus}`
}
