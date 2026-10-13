// Per-page extraction progress is coalesced so a full-document extraction cannot flood
// retention and evict meaningful lifecycle/failure events. The first page, the final page
// and roughly TARGET_SAMPLES evenly spaced pages are recorded — a rate, not every page —
// for any document size.
export const PROGRESS_TARGET_SAMPLES = 20

export interface ProgressTrack {
  lastPage: number
}

export function progressStep(totalPages: number): number {
  if (!Number.isFinite(totalPages) || totalPages <= 1) return 1
  return Math.max(1, Math.ceil(totalPages / PROGRESS_TARGET_SAMPLES))
}

export function shouldRecordProgress(pageNumber: number, totalPages: number, track: ProgressTrack): boolean {
  if (!Number.isFinite(pageNumber) || pageNumber <= track.lastPage) return false
  if (track.lastPage === 0) return true
  if (totalPages > 0 && pageNumber >= totalPages) return true
  return pageNumber - track.lastPage >= progressStep(totalPages)
}
