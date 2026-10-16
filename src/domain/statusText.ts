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
  /** The Natural voice files are already stored on this device. */
  voiceCached?: boolean
  playback: { status: 'ready' | 'playing' | 'paused'; display?: PlaybackDisplay }
}

export function readingStatusText(input: ReadingStatusInput): string {
  if (input.extraction === 'error') return 'Could not read the text'
  if (input.engine === 'local') {
    // The local model load takes tens of seconds and is not a fault, so it must
    // never read as "Voice unavailable" while it runs.
    if (input.localStatus === 'preparing') return 'Preparing voice…'
    if (input.localStatus === 'buffering') return 'Preparing reading…'
    if (input.localStatus === 'error') return 'Voice unavailable'
    if (input.localStatus === 'off' && input.pagesWithReadableText) return input.voiceCached ? 'Turn on voice first' : 'Download voice first'
    // A loaded voice with nothing playing invites playback. "Stopped" reads like
    // a fault, and switches to the local engine stop playback by design.
    if (input.localStatus === 'ready'
      && input.playback.status === 'ready'
      && (input.playback.display === undefined || input.playback.display === 'Ready' || input.playback.display === 'Stopped')) {
      return 'Press play to begin'
    }
  } else if (!input.voiceAvailable) {
    return 'Voice unavailable'
  }
  if (input.extraction === 'complete' && !input.pagesWithReadableText) return 'No readable text'
  return input.playback.display ?? 'Ready'
}

/** Plain-language panel line for the private local narrator. */
export function localVoiceCopy(localStatus: LocalVoiceStatus, saved = false): string {
  if (localStatus === 'ready') return 'Press play to begin'
  if (saved && localStatus === 'preparing') return 'Loading voice from this device…'
  if (saved && localStatus === 'off') return 'Voice saved on this device. Turn it on to begin'
  if (localStatus === 'error') return 'Could not use this voice. Try again or choose Browser voice.'
  if (localStatus === 'preparing') return 'Preparing voice… This may take a minute.'
  return ({off: 'Download the voice to begin', buffering: 'Preparing reading…', playing: 'Reading', paused: 'Paused'} as const)[localStatus]
}

/**
 * The plain line for the rare part of a passage this voice cannot say. Reading
 * carries on without it, so the reader is told once, in words they can act on,
 * rather than watching a run stop for a reason only the logs explain. No counters
 * and no engine detail: how many characters, and why, stays in diagnostics.
 */
export function narratorNoticeCopy(): string {
  return 'Some of this passage could not be spoken. Reading continued. Switch to Browser voice if you need it read.'
}
