import { describe, expect, it } from 'vitest'
import { normalizeExtractedText } from './textQuality'
import { planSpeechChunks } from './speechPlan'

describe('extraction and continuous source-aware speech', () => {
  it('preserves f and safely expands only known ligatures', () => {
    expect(normalizeExtractedText('f ff fi fl ffi ffl ﬀ ﬁ ﬂ ﬃ ﬄ “fine”').text).toBe('f ff fi fl ffi ffl ff fi fl ffi ffl “fine”')
    expect(normalizeExtractedText('di\0erence \0lling').text).toBe('di�erence �lling')
    expect(normalizeExtractedText('di\0erence').unmapped).toBe(1)
  })
  it('joins a split sentence across blank pages without inventing punctuation', () => {
    const chunks = planSpeechChunks(['Five fine friends', '', 'find fresh coffee. Next sentence.'], 1, 'document')
    expect(chunks.map(c => c.text)).toEqual(['Five fine friends find fresh coffee. Next sentence.'])
    expect(chunks[0].spans).toEqual([{ pageNumber: 1, start: 0, end: 17 }, { pageNumber: 3, start: 18, end: 51 }])
  })
  it('preserves real sentence ends, punctuation and hard hyphens; removes explicit soft wraps only', () => {
    expect(planSpeechChunks(['“Fine.”', 'A well-\nknown dif\u00ad\nference.'], 1, 'document')[0].text).toBe('“Fine.” A well- known difference.')
  })
  it('bounds long speech and never reads before the selected page', () => {
    const chunks = planSpeechChunks(['ignored', ('fine friends. ').repeat(200)], 2, 'document', null, 180)
    expect(chunks.every(c => c.text.length <= 180 && c.spans.every(s => s.pageNumber === 2))).toBe(true)
    expect(chunks.map(c => c.text).join(' ')).toBe(('fine friends. ').repeat(200).trim())
  })
  it('honors explicit soft hyphens across pages but never guesses hard hyphens', () => {
    expect(planSpeechChunks(['dif\u00ad', 'ference.'], 1, 'document')[0].text).toBe('difference.')
    expect(planSpeechChunks(['well-', 'known.'], 1, 'document')[0].text).toBe('well- known.')
  })
  it('retains genuine sentence punctuation at a bounded cross-page split', () => {
    const chunks = planSpeechChunks(['A full sentence ends.', 'Five fine friends find coffee.'], 1, 'document', null, 32)
    expect(chunks.map(c => c.text)).toEqual(['A full sentence ends.', 'Five fine friends find coffee.'])
    expect(chunks.map(c => c.spans[0].pageNumber)).toEqual([1, 2])
  })
  it('page scope does not buffer the next page', () => {
    expect(planSpeechChunks(['first half', 'second half.'], 1, 'page').map(c => c.text)).toEqual(['first half'])
  })
})
