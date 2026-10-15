import { describe, expect, it } from 'vitest'
import { availabilityWarning, emptyDocumentState, hasUsableText, isExtractionMessage, textAvailability } from './document'
import { initialPlaybackState, playbackReducer } from './playback'
import { planSpeechChunks } from './speechPlan'

describe('honest text availability', () => {
  it.each(['Hi.', 'I', '一', 'ﬀ'])('accepts short usable text %s', value => expect(hasUsableText(value)).toBe(true))
  it.each(['', ' \n\t', '\u0000', '\ufffd\ufffd', '\u001f'])('rejects empty or unmapped-only %j', value => expect(hasUsableText(value)).toBe(false))
  it('counts every page without claiming scan detection', () => {
    expect(textAvailability(['Hi.', '', '\u0000', '正文', '', 'End.'])).toEqual({ pagesWithReadableText: 3, pagesWithoutReadableText: 3 })
    const state = { ...emptyDocumentState(), ...textAvailability(['Hi.', '']), extraction: 'complete' as const }
    expect(availabilityWarning(state)).toMatch(/1 page has no readable text/)
    expect(availabilityWarning({ ...state, extraction: 'extracting' })).toBe('')
    expect(availabilityWarning({ ...state, pagesWithReadableText: 0 })).toMatch(/cannot read text inside images/)
    const chunks = planSpeechChunks(['Hi.', '\u0000', '', 'End.'], 1, 'document')
    expect(chunks.map(c => c.text).join(' ')).toBe('Hi. End.')
    expect(chunks.flatMap(c => c.spans.map(s => s.pageNumber))).toEqual([1, 4])
  })
  it('only accepts finite valid worker counts and allowlisted failures', () => {
    expect(isExtractionMessage({ type: 'complete', characterCount: 3, pagesWithReadableText: 1, pagesWithoutReadableText: 1 }, 2)).toBe(true)
    for (const value of [null, { type: 'complete', characterCount: NaN, pagesWithReadableText: 0, pagesWithoutReadableText: 2 }, { type: 'page', pageNumber: 3, text: 'Hi.', characterCount: 3, unmapped: 0 }, { type: 'error', errorCode: 'PRIVATE raw error' }, { type: 'complete', characterCount: 3, scanned: true }]) expect(isExtractionMessage(value, 2)).toBe(false)
    for (const errorCode of ['extract-startup', 'extract-runtime', 'extract-protocol', 'extract-pdf']) expect(isExtractionMessage({ type: 'error', errorCode }, 2)).toBe(true)
  })
})

it('distinguishes visible states without changing engine status or Stop source page', () => {
  let state = playbackReducer(initialPlaybackState, { type: 'WAIT', scope: 'document', page: 3 })
  expect(state.display).toBe('Waiting for text')
  state = playbackReducer(state, { type: 'PAUSE' }); expect(state.display).toBe('Paused')
  state = playbackReducer(state, { type: 'RESUME' }); expect(state.display).toBe('Waiting for text')
  state = playbackReducer(state, { type: 'PLAY', scope: 'document', page: 3 }); expect(state.display).toBe('Reading')
  state = playbackReducer(state, { type: 'STOP' }); expect(state).toMatchObject({ status: 'ready', display: 'Stopped', page: 3 })
  state = playbackReducer(state, { type: 'SEEK', page: 4 }); expect(state).toMatchObject({ status: 'ready', display: 'Stopped', page: 4 })
  expect(playbackReducer(state, { type: 'END' }).display).toBe('Finished')
  expect(playbackReducer(state, { type: 'FAIL', display: 'Voice unavailable', message: 'Voice stopped' }).display).toBe('Voice unavailable')
  expect(playbackReducer(state, { type: 'FAIL', message: 'Text is not ready' }).display).toBe('Reading error')
  expect(playbackReducer(state, { type: 'RESET' })).toEqual(initialPlaybackState)
})
