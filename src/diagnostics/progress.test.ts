import { describe, expect, it } from 'vitest'
import { PROGRESS_TARGET_SAMPLES, progressStep, shouldRecordProgress } from './progress'

describe('extraction progress coalescing', () => {
  it('records the first page, the final page, and evenly spaced samples', () => {
    const track = { lastPage: 0 }
    expect(shouldRecordProgress(1, 341, track)).toBe(true)
    track.lastPage = 1
    expect(shouldRecordProgress(2, 341, track)).toBe(false)
    expect(shouldRecordProgress(1 + progressStep(341), 341, track)).toBe(true)
    expect(shouldRecordProgress(341, 341, { lastPage: 300 })).toBe(true)
    expect(shouldRecordProgress(5, 341, { lastPage: 10 })).toBe(false)
    expect(shouldRecordProgress(Number.NaN, 341, track)).toBe(false)
  })

  it('cannot emit a per-page burst for any document size', () => {
    for (const total of [1, 2, 50, 341, 5000]) {
      const track = { lastPage: 0 }
      let emitted = 0
      for (let page = 1; page <= total; page++) {
        if (shouldRecordProgress(page, total, track)) { emitted++; track.lastPage = page }
      }
      expect(emitted, `pages=${total}`).toBeLessThanOrEqual(PROGRESS_TARGET_SAMPLES + 2)
      expect(emitted, `pages=${total}`).toBeGreaterThanOrEqual(Math.min(2, total))
    }
  })
})
