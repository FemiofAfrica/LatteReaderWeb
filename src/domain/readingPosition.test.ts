import { describe, expect, it } from 'vitest'
import { analyzeDocument } from './analysis'
import { planSpeechChunks } from './speechPlan'
import { mappedSpeech, readingTimeline, sentencePosition, sentenceSkip, seekChunks } from './readingPosition'

describe('source-position reading', () => {
  it('maps UTF-16 positions through ligatures, whitespace, replacement and discretionary wraps', () => {
    const raw = '  ﬁne\n\t  ﬃve co\u00ad\nffee \u0000. '
    const mapped = mappedSpeech(raw, 3)
    expect(mapped.text).toBe('fine ffive coffee �.')
    expect(mapped.source[0]).toEqual({ pageNumber: 3, start: 2, end: 3 })
    expect(mapped.source[1]).toEqual(mapped.source[0])
    const coffee = mapped.text.indexOf('coffee')
    expect(raw.slice(mapped.source[coffee].start, mapped.source[coffee + 5].end)).toBe('co\u00ad\nffee')
    expect(mapped.source).toHaveLength(mapped.text.length)
  })
  it('repeated dialogue blocks retain distinct source ranges, voices and source pages', () => {
    const pages = ['ALICE: Same.\nALICE: Same.', '', 'Again.']
    const chunks = planSpeechChunks(pages, 1, 'document', analyzeDocument('id', 'fixture', pages))
    const timeline = readingTimeline(chunks)
    const second = timeline.text.indexOf('ALICE:', 1)
    const position = sentencePosition(timeline, second + 7, 'boundary')
    expect(position.ranges).toEqual([{ pageNumber: 1, start: 13, end: 25 }])
    expect(pages[0].slice(position.ranges[0].start, position.ranges[0].end)).toBe('ALICE: Same.')
    expect(chunks.map(c => c.voiceIndex)).toEqual([1, 0])
    const next = sentenceSkip(timeline, second, 1)
    expect(timeline.text.slice(next)).toBe('Again.')
    expect(sentencePosition(timeline, next, 'boundary').ranges[0].pageNumber).toBe(3)
    expect(sentenceSkip(timeline, next, -1)).toBe(second)
    expect(sentenceSkip(timeline, timeline.text.length, -1)).toBe(next)
  })
  it('a sentence crossing pages is not cut at a page boundary', () => {
    const chunks = planSpeechChunks(['First sentence. Fine friends', 'find coffee. Last.'], 1, 'document', null, 32)
    const timeline = readingTimeline(chunks)
    const offset = timeline.text.indexOf('find')
    const ranges = sentencePosition(timeline, offset, 'boundary').ranges
    expect(ranges).toEqual([{ pageNumber: 1, start: 16, end: 28 }, { pageNumber: 2, start: 0, end: 12 }])
    expect(sentenceSkip(timeline, offset, -1)).toBe(0)
    expect(timeline.text.slice(sentenceSkip(timeline, offset, 1))).toBe('Last.')
  })
  it('seeks start, middle and end without losing chunk provenance or voice assignments', () => {
    const chunks = planSpeechChunks(['One. Two.', 'Three. Four.'], 1, 'document', null, 32)
    const full = readingTimeline(chunks)
    expect(seekChunks(chunks, 0)).toEqual(chunks)
    const middle = full.text.indexOf('Three')
    const seek = seekChunks(chunks, middle)
    expect(seek[0].text).toBe('Three. Four.')
    expect(seek[0].source?.[0]).toEqual({ pageNumber: 2, start: 0, end: 1 })
    expect(seek[0].spans[0].start).toBe(0)
    expect(seekChunks(chunks, full.text.length)).toEqual([])
  })
  it('keeps decimals and punctuation in the highlighted source sentence', () => {
    const raw = 'Value 1.5 is fine. "Again!" Last'
    const timeline = readingTimeline(planSpeechChunks([raw], 1, 'page'))
    expect(timeline.sentences.map(s => timeline.text.slice(s.start, s.end))).toEqual(['Value 1.5 is fine.', '"Again!"', 'Last'])
    expect(sentencePosition(timeline, 8, 'boundary').ranges).toEqual([{ pageNumber: 1, start: 0, end: 18 }])
  })
  it('does not invent sentence highlights without voice boundaries or a matching source', () => {
    const chunks = planSpeechChunks(['Fine. Friends.'], 1, 'document')
    expect(sentencePosition(readingTimeline(chunks), 0, 'utterance').ranges).toEqual([])
    const plan = analyzeDocument('id', 'fixture', ['Different.'])
    expect(sentencePosition(readingTimeline(planSpeechChunks(['Fine.'], 1, 'page', plan)), 0, 'boundary').ranges).toEqual([])
  })
})
