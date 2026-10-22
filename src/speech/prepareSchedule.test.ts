import { describe, expect, it } from 'vitest'
import { decideSynthesisJob, PREPARE_PAUSE_SECONDS, PREPARE_RESUME_SECONDS } from './prepareSchedule'

const base = {
  hasPlaybackWork: false,
  bufferHasRoom: false,
  hasPrepareWork: true,
  playableSeconds: 0,
  playing: true,
  prepareStarved: false,
}

describe('prepare scheduling', () => {
  it('always runs playhead work before prepare', () => {
    const decision = decideSynthesisJob({
      ...base,
      hasPlaybackWork: true,
      bufferHasRoom: true,
      playableSeconds: 200,
    })
    expect(decision.job).toBe('playback')
  })

  it('pauses prepare when lookahead is below 60s and resumes after 90s', () => {
    const paused = decideSynthesisJob({ ...base, playableSeconds: PREPARE_PAUSE_SECONDS - 1 })
    expect(paused.job).toBeNull()
    expect(paused.prepareStarved).toBe(true)

    const stillPaused = decideSynthesisJob({
      ...base,
      playableSeconds: PREPARE_RESUME_SECONDS - 1,
      prepareStarved: true,
    })
    expect(stillPaused.job).toBeNull()

    const resumed = decideSynthesisJob({
      ...base,
      playableSeconds: PREPARE_RESUME_SECONDS,
      prepareStarved: true,
    })
    expect(resumed.job).toBe('prepare')
    expect(resumed.prepareStarved).toBe(false)
  })

  it('runs prepare freely when nothing is playing', () => {
    expect(decideSynthesisJob({ ...base, playing: false, playableSeconds: 0 }).job).toBe('prepare')
  })

  it('does not start prepare while the playhead still has room to fill', () => {
    const decision = decideSynthesisJob({
      ...base,
      hasPlaybackWork: true,
      bufferHasRoom: true,
      playableSeconds: 10,
    })
    expect(decision.job).toBe('playback')
  })
})
