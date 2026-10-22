/**
 * Playhead work always wins. Whole-document prepare is background work that
 * must not take the voice while the listener is close to running out of audio.
 *
 * Pause prepare when fewer than 60s are ready; resume once about 90s are ready
 * so a single background clip cannot starve the next packed file.
 */
export const PREPARE_PAUSE_SECONDS = 60
export const PREPARE_RESUME_SECONDS = 90

export type SynthesisJob = 'playback' | 'prepare'

export interface ScheduleInput {
  hasPlaybackWork: boolean
  bufferHasRoom: boolean
  hasPrepareWork: boolean
  playableSeconds: number
  playing: boolean
  prepareStarved: boolean
  pauseSeconds?: number
  resumeSeconds?: number
}

export interface ScheduleDecision {
  job: SynthesisJob | null
  prepareStarved: boolean
}

export function decideSynthesisJob(input: ScheduleInput): ScheduleDecision {
  const pauseAt = input.pauseSeconds ?? PREPARE_PAUSE_SECONDS
  const resumeAt = input.resumeSeconds ?? PREPARE_RESUME_SECONDS
  if (input.hasPlaybackWork && input.bufferHasRoom) {
    return { job: 'playback', prepareStarved: input.playableSeconds < pauseAt }
  }
  if (!input.hasPrepareWork) return { job: null, prepareStarved: input.prepareStarved }
  if (!input.playing) return { job: 'prepare', prepareStarved: false }
  let starved = input.prepareStarved
  if (starved) {
    if (input.playableSeconds >= resumeAt) starved = false
  } else if (input.playableSeconds < pauseAt) {
    starved = true
  }
  return { job: starved ? null : 'prepare', prepareStarved: starved }
}

export function yieldToPlayback(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}
