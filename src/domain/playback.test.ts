import { describe, expect, it } from 'vitest'
import {
  advancePage,
  buildReadingPages,
  buildReadingSteps,
  initialPlaybackState,
  nextReadablePage,
  nextReadingPage,
  playbackReducer,
  type PlaybackState,
} from './playback'

// Page 2 has no readable text, so it must be skipped without stalling.
const pages = ['Alpha text.', '   ', 'Gamma text.', 'Delta text.']

const playing = (page: number): PlaybackState => playbackReducer(
  initialPlaybackState,
  { type: 'PLAY', scope: 'document', page },
)

describe('playbackReducer', () => {
  it('moves through playing, paused, resumed, and stopped states', () => {
    const started = playbackReducer(initialPlaybackState, { type: 'PLAY', scope: 'page', page: 1 })
    const paused = playbackReducer(started, { type: 'PAUSE' })
    const resumed = playbackReducer(paused, { type: 'RESUME' })
    const stopped = playbackReducer(resumed, { type: 'STOP' })

    expect(started).toMatchObject({ status: 'playing', scope: 'page' })
    expect(paused.status).toBe('paused')
    expect(resumed.status).toBe('playing')
    expect(stopped).toEqual(initialPlaybackState)
  })

  it('records engine completion without losing the chosen scope', () => {
    const started = playbackReducer(initialPlaybackState, { type: 'PLAY', scope: 'document' })
    expect(playbackReducer(started, { type: 'END' })).toMatchObject({
      status: 'ready',
      scope: 'document',
    })
  })

  it('defaults to continuous reading', () => {
    expect(initialPlaybackState.scope).toBe('document')
  })
})

describe('continuous reading sequence', () => {
  it('advances in order across at least three pages and then stops at the end', () => {
    const order = buildReadingPages(pages, 1, 'document')
    expect(order).toEqual([1, 3, 4])

    // Walk the sequence exactly as the app does: read current page, ask for the next one.
    const visited: number[] = []
    let state = playing(1)
    visited.push(state.page)
    for (let guard = 0; guard < 10; guard += 1) {
      const next = nextReadingPage(pages, state)
      if (next === null) break
      state = { ...state, page: next }
      visited.push(next)
    }
    expect(visited).toEqual([1, 3, 4])
    expect(nextReadingPage(pages, state)).toBeNull()
  })

  it('skips a page with no readable text instead of stalling on it', () => {
    expect(nextReadablePage(pages, 1)).toBe(3)
    expect(nextReadablePage(['one', '', '', 'four'], 1)).toBe(4)
    expect(nextReadablePage(['one', '', ''], 1)).toBeNull()
  })

  it('advances from the page just read, not from stale reducer state', () => {
    // The engine can finish a page before React re-renders, so the reducer still says
    // page 1 while the reader has already moved to page 3.
    const started = playing(1)
    expect(advancePage(pages, started, 1)).toBe(3)
    expect(advancePage(pages, started, 3)).toBe(4)
    expect(advancePage(pages, started, 4)).toBeNull()
  })

  it('stops at the page boundary in page-only mode', () => {
    expect(buildReadingPages(pages, 3, 'page')).toEqual([3])
    const pageOnly = playbackReducer(initialPlaybackState, { type: 'PLAY', scope: 'page', page: 3 })
    expect(nextReadingPage(pages, pageOnly)).toBeNull()
  })

  it('keeps the position and status through pause and resume mid-sequence', () => {
    const started = playing(1)
    const advanced = playbackReducer(started, { type: 'ADVANCE', page: 3, totalPages: 4 })
    const paused = playbackReducer(advanced, { type: 'PAUSE' })
    // A paused run must not advance while paused ...
    expect(nextReadingPage(pages, paused)).toBeNull()
    const resumed = playbackReducer(paused, { type: 'RESUME' })
    // ... and resumes on the same page it paused on.
    expect(resumed.page).toBe(3)
    expect(resumed.status).toBe('playing')
    expect(nextReadingPage(pages, resumed)).toBe(4)
  })

  it('produces nothing further once stop cancels a run mid-sequence', () => {
    const started = playing(1)
    const advanced = playbackReducer(started, { type: 'ADVANCE', page: 3, totalPages: 4 })
    const stopped = playbackReducer(advanced, { type: 'STOP' })

    expect(stopped).toEqual(initialPlaybackState)
    expect(stopped.status).toBe('ready')
    expect(stopped.page).toBe(0)
    // The cancelled run cannot request another page, so no queued utterance survives stop.
    expect(nextReadingPage(pages, stopped)).toBeNull()
  })
})

describe('buildReadingSteps', () => {
  it('carries the readable text for each ordered page', () => {
    expect(buildReadingSteps(pages, 1, 'document')).toEqual([
      { pageNumber: 1, text: 'Alpha text.' },
      { pageNumber: 3, text: 'Gamma text.' },
      { pageNumber: 4, text: 'Delta text.' },
    ])
  })
})
