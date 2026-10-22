import { describe, expect, it } from 'vitest'
import { audioReadyCopy, audioReadyProgress, formatReadyDuration, listenedPercent } from './audioReady'

describe('audio ready copy', () => {
  it('uses real packed durations for the minimize line', () => {
    const progress = audioReadyProgress({
      parts: [
        { duration: 60, pageEnd: 3 },
        { duration: 11 * 60, pageEnd: 8 },
      ],
      totalParts: 20,
      listenedSeconds: 0,
    })
    expect(progress.generatedPercent).toBe(10)
    expect(formatReadyDuration(progress.remainingReadySeconds)).toBe('12 min')
    expect(audioReadyCopy(progress)).toBe("About 12 min ready. If you minimize now, it'll play until page 8.")
  })

  it('says the whole document is ready once every part has audio', () => {
    const progress = audioReadyProgress({
      parts: [{ duration: 30, pageEnd: 2 }, { duration: 30, pageEnd: 4 }],
      totalParts: 2,
      listenedSeconds: 10,
    })
    expect(progress.generatedPercent).toBe(100)
    expect(listenedPercent(progress)).toBeCloseTo(100 * 10 / 60)
    expect(audioReadyCopy(progress)).toBe('The whole document is ready. You can minimize now and it will keep playing.')
  })

  it('keeps the empty and preparing lines free of engine jargon', () => {
    const empty = audioReadyProgress({ parts: [], totalParts: 10, listenedSeconds: 0, preparing: true })
    expect(audioReadyCopy(empty)).toBe('Preparing audio…')
    expect(audioReadyCopy({ ...empty, preparing: false })).toBe('No audio ready yet. Stay on this page while it prepares.')
    expect(audioReadyCopy(empty)).not.toMatch(/chunk|queue|engine|buffer/i)
  })
})
