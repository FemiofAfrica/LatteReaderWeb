import { describe, expect, it } from 'vitest'
import { initialPlaybackState, playbackReducer } from './playback'

describe('playbackReducer', () => {
  it('moves through playing, paused, resumed, and stopped states', () => {
    const playing = playbackReducer(initialPlaybackState, { type: 'PLAY', scope: 'page' })
    const paused = playbackReducer(playing, { type: 'PAUSE' })
    const resumed = playbackReducer(paused, { type: 'RESUME' })
    const stopped = playbackReducer(resumed, { type: 'STOP' })

    expect(playing).toMatchObject({ status: 'playing', scope: 'page' })
    expect(paused.status).toBe('paused')
    expect(resumed.status).toBe('playing')
    expect(stopped).toEqual(initialPlaybackState)
  })

  it('records engine completion without losing the chosen scope', () => {
    const playing = playbackReducer(initialPlaybackState, { type: 'PLAY', scope: 'document' })
    expect(playbackReducer(playing, { type: 'END' })).toMatchObject({
      status: 'ready',
      scope: 'document',
    })
  })
})
