import { expect, it } from 'vitest'
import { joinPdfTextItems } from './pdfText'
import { normalizeExtractedText } from './textQuality'
import { planSpeechChunks } from './speechPlan'
const item = (str: string, x: number, width = 6, y = 40, hasEOL = false) => ({ str, width, height: 12, transform: [12, 0, 0, 12, x, y], dir: 'ltr', hasEOL })
it('joins touching style runs without manufacturing a word space', () => {
  expect(joinPdfTextItems([item('R', 0), item('o', 6)])).toBe('Ro')
})
it('preserves explicit whitespace, genuine gaps, initials and punctuation', () => {
  expect(joinPdfTextItems([item('R ', 0), item('o', 6)])).toBe('R o')
  expect(joinPdfTextItems([item('R', 0), item('o', 10)])).toBe('R o')
  expect(joinPdfTextItems([item('A.', 0, 10), item('B.', 14, 10)])).toBe('A. B.')
  expect(joinPdfTextItems([item('fine', 0, 20), item('friends', 24, 30)])).toBe('fine friends')
  expect(joinPdfTextItems([item('can', 0, 18), item('’t', 18, 8), item('.', 26, 3)])).toBe('can’t.')
  expect(joinPdfTextItems([item('中', 0, 12), item('文', 12, 12)])).toBe('中文')
})
it('keeps lines, columns, hyphens and rotated baselines separate', () => {
  expect(joinPdfTextItems([item('well-', 0, 30, 40, true), item('known', 0, 30, 25)])).toBe('well-\nknown')
  expect(joinPdfTextItems([item('Left', 0, 24), item('Right', 200, 30)])).toBe('Left\nRight')
  const rotated = (str: string, y: number) => ({ ...item(str, 0), transform: [0, 12, -12, 0, 0, y] })
  expect(joinPdfTextItems([rotated('R', 0), rotated('o', 6)])).toBe('Ro')
  expect(joinPdfTextItems([item('End', 0), rotated('Start', 0)])).toBe('End\nStart')
  expect(joinPdfTextItems([item('Line', 0), { ...item('', 0), hasEOL: true }, item('Next', 0, 6, 25)])).toBe('Line\nNext')
})
it('maps normalized ligature and split-run speech offsets to extracted read-along text', () => {
  const text = normalizeExtractedText(joinPdfTextItems([item('R', 0), item('o', 6), item(' ﬁne.', 12, 30)])).text
  const [chunk] = planSpeechChunks([text], 1, 'page')
  expect(text).toBe('Ro fine.')
  expect(chunk.text).toBe(text)
  expect(chunk.source?.map(s => s?.start)).toEqual(Array.from({ length: text.length }, (_, i) => i))
})
