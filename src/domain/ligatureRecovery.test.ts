import { describe, expect, it } from 'vitest'
import { recoverDroppedGlyphs, countDroppedGlyphs } from './ligatureRecovery'
import { normalizeMappedText, normalizeExtractedText } from './textQuality'

const items = [
  { fontName: 'f1', str: 'co\u0000ee' },
  { fontName: 'f1', str: ' dis\u0000cult' },
]

describe('dropped glyph recovery', () => {
  it('replaces a dropped character with the text the font proved', () => {
    const codes = new Map([['f1', [1040, 1043]]])
    const result = recoverDroppedGlyphs(items, codes, (_font, code) => (code === 1040 ? '\ufb00' : '\ufb03'))
    expect(result.items.map(item => item.str)).toEqual(['co\ufb00ee', ' dis\ufb03cult'])
    expect(result.recovered).toBe(2)
    expect(result.unresolved).toBe(0)
    expect(normalizeExtractedText(result.items[0].str).text).toBe('coffee')
    expect(normalizeExtractedText(result.items[1].str).text).toBe(' disfficult')
  })

  it('keeps every expanded character on the source offset it replaced', () => {
    const codes = new Map([['f1', [1040]]])
    const { items: rewritten } = recoverDroppedGlyphs([{ fontName: 'f1', str: 'a\u0000b' }], codes, () => '\ufb00')
    const { text, source } = normalizeMappedText(rewritten[0].str)
    expect(text).toBe('affb')
    expect(rewritten[0].str).toBe('a\ufb00b')
    expect(source).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ])
  })

  it('keeps offsets exact when a composite supplies several characters at once', () => {
    const codes = new Map([['f1', [7]]])
    const { items: rewritten } = recoverDroppedGlyphs([{ fontName: 'f1', str: 'di\u0000cult' }], codes, () => 'ffi')
    // A composite that draws three glyphs contributes three characters; the page
    // string is the only thing that moved, and every character still reports the
    // source index it occupies in that string.
    expect(rewritten[0].str).toBe('difficult')
    const { text, source } = normalizeMappedText(rewritten[0].str)
    expect(text).toBe('difficult')
    expect(source).toEqual(Array.from({ length: 9 }, (_, index) => ({ start: index, end: index + 1 })))
  })

  it('refuses to act when the glyph sequence cannot be aligned with the text', () => {
    const codes = new Map([['f1', [1040]]]) // two dropped characters in the text, one code
    const result = recoverDroppedGlyphs(items, codes, () => '\ufb00')
    expect(result.items).toEqual(items)
    expect(result.recovered).toBe(0)
    expect(result.unresolved).toBe(0)
    expect(result.unalignedFonts).toEqual(['f1'])
    expect(normalizeExtractedText(result.items[0].str).text).toBe('co\ufffdee')
  })

  it('leaves a glyph the font cannot name unresolved instead of inventing a letter', () => {
    const codes = new Map([['f1', [1040, 999]]])
    const result = recoverDroppedGlyphs(items, codes, (_font, code) => (code === 999 ? null : '\ufb00'))
    expect(result.items[0].str).toBe('co\ufb00ee')
    expect(result.items[1].str).toContain('\u0000')
    expect(result.recovered).toBe(1)
    expect(result.unresolved).toBe(1)
    const normalized = normalizeExtractedText(result.items[1].str)
    expect(normalized.unmapped).toBe(1)
    expect(normalized.text).toBe(' dis\ufffdcult')
  })

  it('counts dropped characters per font', () => {
    expect(countDroppedGlyphs([{ fontName: 'a', str: 'x\u0000\ufffdy' }, { fontName: 'b', str: 'ok' }])).toBe(2)
  })
})
