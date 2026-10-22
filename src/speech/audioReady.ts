/** Live copy for how much spoken audio is actually ready to survive a minimized tab. */

export interface AudioReadyProgress {
  generatedParts: number
  totalParts: number
  generatedPercent: number
  listenedSeconds: number
  generatedSeconds: number
  remainingReadySeconds: number
  lastReadyPage: number | null
  preparing: boolean
  preparingPercent: number
}

export const emptyAudioReady = (preparing = false): AudioReadyProgress => ({
  generatedParts: 0,
  totalParts: 0,
  generatedPercent: 0,
  listenedSeconds: 0,
  generatedSeconds: 0,
  remainingReadySeconds: 0,
  lastReadyPage: null,
  preparing,
  preparingPercent: 0,
})

export function audioReadyProgress(input: {
  parts: readonly { duration: number; pageEnd: number }[]
  totalParts: number
  listenedSeconds: number
  preparing?: boolean
}): AudioReadyProgress {
  const generatedParts = input.parts.length
  const generatedSeconds = input.parts.reduce((total, part) => total + part.duration, 0)
  const listenedSeconds = Math.max(0, Math.min(input.listenedSeconds, generatedSeconds))
  const totalParts = Math.max(0, input.totalParts)
  const generatedPercent = totalParts ? Math.round((generatedParts / totalParts) * 100) : 0
  return {
    generatedParts,
    totalParts,
    generatedPercent: Math.min(100, generatedPercent),
    listenedSeconds,
    generatedSeconds,
    remainingReadySeconds: Math.max(0, generatedSeconds - listenedSeconds),
    lastReadyPage: input.parts.at(-1)?.pageEnd ?? null,
    preparing: !!input.preparing,
    preparingPercent: Math.min(100, generatedPercent),
  }
}

export function formatReadyDuration(seconds: number): string {
  if (seconds < 10) return 'a few seconds'
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `${minutes} min`
}

/**
 * One plain line. Uses real packed durations, never an estimate from character counts.
 * Avoids engine jargon: the reader only needs to know how long they can leave.
 */
export function audioReadyCopy(progress: AudioReadyProgress): string {
  if (progress.preparing && progress.generatedParts === 0) return 'Preparing audio…'
  if (progress.generatedParts === 0) return 'No audio ready yet. Stay on this page while it prepares.'
  if (progress.totalParts > 0 && progress.generatedParts >= progress.totalParts) {
    return 'The whole document is ready. You can minimize now and it will keep playing.'
  }
  const duration = formatReadyDuration(progress.remainingReadySeconds)
  if (progress.lastReadyPage) {
    return `About ${duration} ready. If you minimize now, it'll play until page ${progress.lastReadyPage}.`
  }
  return `About ${duration} ready. If you minimize now, that audio will keep playing.`
}

export function listenedPercent(progress: AudioReadyProgress): number {
  if (!progress.generatedSeconds || !progress.generatedPercent) return 0
  return Math.min(progress.generatedPercent, (progress.listenedSeconds / progress.generatedSeconds) * progress.generatedPercent)
}
