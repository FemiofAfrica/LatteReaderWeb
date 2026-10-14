import type { SfntFont } from './sfnt'

/** Ties the extraction worker to evidence inside the document's own fonts.
 *
 * PDF.js reports a dropped glyph as one text item character with no Unicode,
 * and separately reports the glyph's raw character code through the operator
 * list. This module lines those two up per font and answers one question per
 * raw code: what does the font program itself say this glyph draws?
 *
 * The answer has to come from the font, and it has to be unambiguous. An
 * unnamed glyph is named only through structure the program states: a glyph the
 * font's cmap names, a composite that draws a named glyph, or a named glyph
 * left empty that a single unnamed glyph with its exact advance width
 * replaces. Otherwise the answer is "unknown", and the caller keeps today's
 * honest unmapped marker.
 */

/** Presentation-form ligature codepoints. Naming one of these is exactly the
 * failure this recovers: the shape is drawn, the character was never stated. */
const LIGATURE_MIN = 0xfb00
const LIGATURE_MAX = 0xfb06

const MIN_AGREEMENTS = 5

/** A page that named at least this many glyphs for a font gives that font a
 * fair chance of being recognised; below it, "no match" means "no evidence". */
export function hasEnoughEvidence(samples: readonly { code: number; text: string }[]): boolean {
  return samples.length >= MIN_AGREEMENTS
}

export interface GlyphRun {
  /** Raw character codes of glyphs the document gave no Unicode for, in order. */
  unmappedCodes: number[]
  /** Glyphs the document did name, as evidence for matching a font program. */
  samples: { code: number; text: string }[]
}

export interface OperatorListLike {
  fnArray: readonly number[]
  argsArray: readonly unknown[]
}

/** Walks showText showSpacedText and setFont operators into per-font runs. */
export function collectGlyphRuns(ops: OperatorListLike, showText: number, showSpacedText: number, setFont: number): Map<string, GlyphRun> {
  const runs = new Map<string, GlyphRun>()
  let fontName: string | null = null
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    if (fn === setFont) {
      const [name] = ops.argsArray[i] as [string]
      fontName = typeof name === 'string' ? name : null
      continue
    }
    if (fn !== showText && fn !== showSpacedText) continue
    if (!fontName) continue
    const glyphs = (ops.argsArray[i] as unknown[])[0]
    if (!Array.isArray(glyphs)) continue
    const run = runs.get(fontName) ?? { unmappedCodes: [], samples: [] }
    runs.set(fontName, run)
    for (const glyph of glyphs) {
      if (!glyph || typeof glyph !== 'object') continue
      const { originalCharCode, unicode } = glyph as { originalCharCode?: unknown; unicode?: unknown }
      if (typeof originalCharCode !== 'number') continue
      if (typeof unicode === 'string' && unicode.length > 0 && unicode !== '\u0000' && unicode !== '\ufffd') {
        run.samples.push({ code: originalCharCode, text: unicode })
      } else {
        run.unmappedCodes.push(originalCharCode)
      }
    }
  }
  return runs
}

/** Does this font program reproduce the characters PDF.js already read for the
 * same raw codes? Only a program that does can be trusted to name the rest. */
function agreesWithDocument(font: SfntFont, samples: readonly { code: number; text: string }[]): boolean {
  let agreements = 0
  for (const sample of samples) {
    const codepoint = font.codepointByGlyph.get(sample.code)
    if (codepoint === undefined) continue
    if (codepoint === sample.text.codePointAt(0)) agreements++
    else return false
  }
  return agreements >= MIN_AGREEMENTS
}

/** Naming a glyph from the font program alone. Tiers, strongest first:
 *  1. the font's own cmap names this glyph;
 *  2. the glyph is a composite that draws named glyphs (their characters, in
 *     draw order — this is how a ligature duplicate is built);
 *  3. a named glyph left empty is replaced by exactly one unnamed glyph of the
 *     same advance width: the drawn form of that character.
 * Anything else stays unknown. */
export function createGlyphTextResolver(font: SfntFont): (code: number) => string | null {
  const placeholders = placeholderTwins(font)
  const cache = new Map<number, string | null>()
  const resolve = (gid: number, depth: number): string | null => {
    const named = font.codepointByGlyph.get(gid)
    if (named !== undefined) return String.fromCodePoint(named)
    const components = font.componentsByGlyph.get(gid)
    if (components && depth < 4) {
      const parts = components.map(component => resolve(component, depth + 1))
      if (parts.length && parts.every(part => part !== null && part !== '')) return parts.join('')
    }
    const placeholder = placeholders.get(gid)
    if (placeholder !== undefined) return String.fromCodePoint(placeholder)
    return null
  }
  return (code: number) => {
    if (cache.has(code)) return cache.get(code) ?? null
    const text = code >= 0 && code <= 0xffff ? resolve(code, 0) : null
    cache.set(code, text)
    return text
  }
}

/** A glyph the font names but draws nothing for, matched to the single unnamed
 * glyph that carries its exact advance width. Restricted to ligature
 * presentation forms: the case where a producer copied the shape into a second
 * glyph, left the named one empty, and dropped the character from ToUnicode. */
function placeholderTwins(font: SfntFont): Map<number, number> {
  const byAdvance = new Map<number, number[]>()
  for (let gid = 0; gid < font.numGlyphs; gid++) {
    if (font.codepointByGlyph.has(gid)) continue
    const advance = font.advanceWidth(gid)
    const list = byAdvance.get(advance)
    if (list) list.push(gid)
    else byAdvance.set(advance, [gid])
  }
  const twins = new Map<number, number>()
  const claimed = new Map<number, number>()
  for (const [named, codepoint] of font.codepointByGlyph) {
    if (codepoint < LIGATURE_MIN || codepoint > LIGATURE_MAX) continue
    if (!font.isEmpty(named)) continue
    const candidates = (byAdvance.get(font.advanceWidth(named)) ?? []).filter(gid => !font.isEmpty(gid) && !font.componentsByGlyph.has(gid))
    if (candidates.length !== 1) continue
    const [candidate] = candidates
    const previous = claimed.get(candidate)
    if (previous !== undefined && previous !== codepoint) { twins.delete(candidate); continue }
    claimed.set(candidate, codepoint)
    twins.set(candidate, codepoint)
  }
  return twins
}

/** Resolves a raw code against every font program that matches the document's
 * own reading, and accepts a result only when they agree. Returns null when no
 * embedded program reproduces the document's own characters — then the page has
 * no usable evidence and the caller must leave today's marker alone. */
export function createFontCodeResolver(programs: readonly SfntFont[], run: GlyphRun): ((code: number) => string | null) | null {
  const matching = programs.filter(font => agreesWithDocument(font, run.samples)).map(createGlyphTextResolver)
  if (!matching.length) return null
  return (code: number) => {
    const answers = matching.map(resolve => resolve(code)).filter((text): text is string => text !== null && text !== '')
    if (!answers.length) return null
    const unique = [...new Set(answers)]
    return unique.length === 1 ? unique[0] : null
  }
}
