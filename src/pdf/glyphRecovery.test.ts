import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { joinPdfTextItems } from '../domain/pdfText'
import { normalizeMappedText, normalizeExtractedText } from '../domain/textQuality'
import { recoverDroppedGlyphs, countDroppedGlyphs } from '../domain/ligatureRecovery'
import { indexEmbeddedFontPrograms } from './embeddedFonts'
import { collectGlyphRuns, createFontCodeResolver, createGlyphTextResolver } from './glyphRecovery'

/** The owned fixture reproduces the reported failure shape: an embedded font
 * whose own cmap names the ligatures, and a ToUnicode CMap that states those
 * character codes as U+0000. Only the font program can name the dropped glyphs,
 * so this is the whole fix end to end, on a file we own. */
const FIXTURE = new Uint8Array(readFileSync('tests/fixtures/ligature-mapping.pdf'))

async function extract(recover: boolean) {
  const source = new Uint8Array(FIXTURE)
  // PDF.js may take ownership of the buffer it is handed.
  const programSource = source.slice()
  const document = await getDocument({ data: source }).promise
  const page = await document.getPage(1)
  const content = await page.getTextContent()
  const original = content.items.filter((item): item is TextItem => 'str' in item)
  const dropped = countDroppedGlyphs(original)
  let items = original
  let recoveredCount = 0
  let unaligned: string[] = []
  if (recover) {
    const programs = await indexEmbeddedFontPrograms(programSource)
    const runs = collectGlyphRuns(await page.getOperatorList(), OPS.showText, OPS.showSpacedText, OPS.setFont)
    const codesByFont = new Map<string, readonly number[]>()
    const resolvers = new Map<string, (code: number) => string | null>()
    for (const [fontName, run] of runs) {
      if (!run.unmappedCodes.length) continue
      const resolve = createFontCodeResolver(programs.map(program => program.font), run)
      if (resolve) resolvers.set(fontName, resolve)
      if (resolvers.has(fontName)) codesByFont.set(fontName, run.unmappedCodes)
    }
    const result = recoverDroppedGlyphs(items, codesByFont, (fontName, code) => resolvers.get(fontName)?.(code) ?? null)
    items = result.items
    recoveredCount = result.recovered
    unaligned = result.unalignedFonts
  }
  const joined = joinPdfTextItems(items)
  const normalized = normalizeExtractedText(joined)
  await document.cleanup()
  return { dropped, recoveredCount, unaligned, joined, ...normalized }
}

describe('ligature recovery from the embedded font on an owned fixture', () => {
  it('reads the fixture font program out of the document', async () => {
    const programs = await indexEmbeddedFontPrograms(new Uint8Array(FIXTURE))
    expect(programs).toHaveLength(1)
    expect(programs[0].font.numGlyphs).toBe(26)
    // The font names the ligature shapes; the document itself does not.
    expect(programs[0].font.codepointByGlyph.get(17)).toBe(0xfb00)
    expect(programs[0].font.codepointByGlyph.get(19)).toBe(0xfb02)
    expect(programs[0].font.codepointByGlyph.get(21)).toBe(0xfb04)
    expect(programs[0].font.codepointByGlyph.get(25)).toBeUndefined()
  })

  it('names each shape through the tier the font program states, and only that', async () => {
    const programs = await indexEmbeddedFontPrograms(new Uint8Array(FIXTURE))
    const resolve = createGlyphTextResolver(programs[0].font)
    // tier 1: the font's own cmap names the glyph the document drops.
    expect(resolve(17)).toBe('\ufb00') // ff
    expect(resolve(19)).toBe('\ufb02') // fl
    expect(resolve(20)).toBe('\ufb03') // ffi
    // tier 2: an unnamed composite that draws a named glyph.
    expect(resolve(23)).toBe('\ufb00') // ff duplicate -> ff
    expect(resolve(24)).toBe('\ufb01') // fi duplicate -> fi
    // tier 4: the only unnamed non-empty glyph carrying the advance width of a
    // named glyph the producer left empty.
    expect(resolve(22)).toBe('\ufb04') // ffl duplicate of the empty U+FB04
    // No named twin, no named component, no placeholder: unknown, not invented.
    expect(resolve(25)).toBeNull()
  })

  it('drops every ligature before the fix and names all of them after it', async () => {
    const before = await extract(false)
    const after = await extract(true)

    expect(before.dropped).toBe(10)
    expect(before.unmapped).toBe(10)
    expect(after.recoveredCount).toBe(9)
    expect(after.unaligned).toEqual([])
    // One glyph is genuinely unnameable in this font (no cmap entry, no named
    // component, no named placeholder twin): it must stay honestly unmapped.
    expect(after.unmapped).toBe(1)
    expect(after.text).toContain('\ufffd')

    for (const word of ['different', 'coffee', 'first', 'officer', 'floor', 'definitely', 'financial', 'difficult', 'waffle']) {
      expect(before.text).not.toContain(word)
      expect(after.text).toContain(word)
    }
    expect(before.text).toContain('no\ufffde')
    expect(after.text).toContain('no\ufffde')
  })

  it('keeps every recovered character mapped to the exact source offset', async () => {
    const after = await extract(true)
    const { source } = normalizeMappedText(after.joined)
    // "different" is drawn as d i <ff> e r e n t: the expanded "ff" must both
    // point at the single dropped character it replaced, not at its neighbours.
    const start = after.joined.indexOf('di') 
    expect(after.joined.slice(start, start + 8)).toBe('di\ufb00erent')
    const expanded = after.text.slice(after.text.indexOf('different'), after.text.indexOf('different') + 9)
    expect(expanded).toBe('different')
    const offset = after.text.indexOf('different')
    expect(source.slice(offset, offset + 9)).toEqual([
      { start: start, end: start + 1 },      // d
      { start: start + 1, end: start + 2 },  // i
      { start: start + 2, end: start + 3 },  // f of the ligature
      { start: start + 2, end: start + 3 },  // f of the ligature
      { start: start + 3, end: start + 4 },  // e
      { start: start + 4, end: start + 5 },  // r
      { start: start + 5, end: start + 6 },  // e
      { start: start + 6, end: start + 7 },  // n
      { start: start + 7, end: start + 8 },  // t
    ])
  })
})

/** The negative proof. This is the project's existing damaged-mapping fixture:
 * the drawn glyph is intact but nothing in the file names it. The fix must not
 * turn it into a plausible letter. */
describe('a font that cannot name the glyph', () => {
  it("keeps today's honest unmapped marker and invents nothing", async () => {
    const fixture = new Uint8Array(readFileSync('tests/fixtures/reading-quality-unmapped.pdf'))
    const programs = await indexEmbeddedFontPrograms(new Uint8Array(fixture))
    expect(programs.length).toBeGreaterThan(0)
    const document = await getDocument({ data: fixture }).promise
    const page = await document.getPage(1)
    const content = await page.getTextContent()
    const items = content.items.filter((item): item is TextItem => 'str' in item)
    const runs = collectGlyphRuns(await page.getOperatorList(), OPS.showText, OPS.showSpacedText, OPS.setFont)
    const codesByFont = new Map<string, readonly number[]>()
    const resolvers = new Map<string, (code: number) => string | null>()
    for (const [fontName, run] of runs) {
      if (!run.unmappedCodes.length) continue
      const resolve = createFontCodeResolver(programs.map(program => program.font), run)
      if (resolve) resolvers.set(fontName, resolve)
      if (resolvers.has(fontName)) codesByFont.set(fontName, run.unmappedCodes)
    }
    const result = recoverDroppedGlyphs(items, codesByFont, (fontName, code) => resolvers.get(fontName)?.(code) ?? null)
    expect(result.recovered).toBe(0)
    expect(result.items.some(item => item.str.includes('\u0000'))).toBe(true)
    const before = normalizeExtractedText(joinPdfTextItems(items)).text
    const after = normalizeExtractedText(joinPdfTextItems(result.items)).text
    expect(after).toBe(before)
    expect(after).toContain('ffi ffl \ufffd fi fl')
    await document.cleanup()
  })

  it('leaves a healthy font exactly as it reads today', async () => {
    const fixture = new Uint8Array(readFileSync('tests/fixtures/reading-quality.pdf'))
    const document = await getDocument({ data: fixture }).promise
    const page = await document.getPage(1)
    const content = await page.getTextContent()
    const items = content.items.filter((item): item is TextItem => 'str' in item)
    expect(countDroppedGlyphs(items)).toBe(0)
    expect(normalizeExtractedText(joinPdfTextItems(items)).text)
      .toBe('f ff fi fl ffi ffl ff fi fl ffi ffl \u201cfine\u201d\nFive fine friends')
    await document.cleanup()
  })
})
