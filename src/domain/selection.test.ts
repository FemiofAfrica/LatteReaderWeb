import { describe, it, expect } from 'vitest'
import { selectionChunks, sourceSelection } from './selection'
import { planSpeechChunks } from './speechPlan'
import { mappedSpeech } from './readingPosition'
import { normalizeExtractedText } from './textQuality'

describe('explicit source selections', () => {
  it('uses DOM range provenance across highlight spans and repeated text', () => {
    document.body.innerHTML = '<div class="page-text" data-source-page="2"><p>Same. <mark>Same.</mark> End.</p></div>'
    const range = document.createRange(), mark = document.querySelector('mark')!
    range.setStart(mark.firstChild!, 0); range.setEnd(mark.nextSibling!, 5)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    expect(sourceSelection(selection)).toEqual({ pageNumber: 2, start: 6, end: 16 })
    const chunks = planSpeechChunks(['Earlier.', 'Same. Same. End.', 'Final.'], 2, 'document')
    expect(selectionChunks(chunks, { pageNumber: 2, start: 6, end: 11 }, false).map(c => c.text).join(' ')).toBe('Same.')
    expect(selectionChunks(chunks, { pageNumber: 2, start: 6, end: 11 }, true).map(c => c.text).join(' ')).toBe('Same. End. Final.')
  })
  it('bounds long selections and preserves voices and expanded glyph positions', () => {
    const pages = ['ﬁne. '.repeat(500), 'Last.']
    const chunks = planSpeechChunks(pages, 1, 'document', null, 64)
    const only = selectionChunks(chunks, { pageNumber: 1, start: 5, end: pages[0].length }, false)
    expect(only.every(c => c.text.length <= 64)).toBe(true)
    expect(only[0].source![0]).toEqual({ pageNumber: 1, start: 5, end: 6 })
    expect(only[0].source![1]).toEqual({ pageNumber: 1, start: 5, end: 6 })
    expect(only.every(c => c.spans.every(s => s.pageNumber === 1))).toBe(true)
    const voiced = chunks.map((c, i) => ({ ...c, voiceIndex: i % 2 }))
    expect(selectionChunks(voiced, { pageNumber: 1, start: 6, end: 20 }, true).map(c => c.voiceIndex)).toEqual(voiced.map(c => c.voiceIndex))
  })
  it('rejects cross-container and empty selections', () => {
    document.body.innerHTML = '<div class="page-text" data-source-page="1">One</div><div>Two</div>'
    const range = document.createRange(); range.setStart(document.body.firstChild!.firstChild!, 0); range.setEnd(document.body.lastChild!.firstChild!, 2)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    expect(sourceSelection(selection)).toBeNull()
  })
})
describe('conservative repair provenance', () => {
  it('joins only explicit token-internal contraction splits and maps surviving source', () => {
    const text = "ﬁne don’ t I' m we' re."
    expect(normalizeExtractedText(text).text).toBe("fine don’t I'm we're.")
    const mapped = mappedSpeech(text, 2, 10)
    expect(mapped.text).toBe("fine don’t I'm we're.")
    expect(mapped.source[mapped.text.indexOf('t')]).toEqual({ pageNumber: 2, start: 19, end: 20 })
    expect(mapped.source[0]).toEqual({ pageNumber: 2, start: 10, end: 11 })
    expect(mapped.source[1]).toEqual(mapped.source[0])
  })
  it('leaves ambiguous quotes, possessives, genuine word spaces and multilingual text intact', () => {
    const text = "don ' t John' s rock ' n ' roll l’ amour aujourd’ hui café 中文 f ff ﬁ di\0erence"
    expect(normalizeExtractedText(text)).toEqual({ text: "don ' t John' s rock ' n ' roll l’ amour aujourd’ hui café 中文 f ff fi di�erence", unmapped: 1 })
  })
})
