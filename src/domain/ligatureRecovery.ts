/** Rewrites text items in place so that glyphs a document failed to name can be
 * filled from font evidence, without moving a single source offset.
 *
 * The contract: one dropped character is replaced by the text the font program
 * proves for it. `normalizeMappedText` then maps every produced character back
 * to the index of the item it came from, exactly as it already does for the
 * presentation-form ligatures it knows. Item strings are the only thing
 * touched, so joining, spacing, highlighting, selection and seek are unchanged.
 *
 * Nothing here knows about fonts. It is handed one text per raw character code
 * and refuses to act when the page's glyph sequence cannot be lined up with the
 * dropped characters it is meant to explain.
 */

export interface RecoveryItem {
  fontName: string
  str: string
}

export interface RecoveryResult<T> {
  items: T[]
  /** Dropped characters replaced by font-proven text. */
  recovered: number
  /** Dropped characters the font could not name; left as today's marker. */
  unresolved: number
  /** Fonts whose glyph sequence did not line up; their items are untouched. */
  unalignedFonts: string[]
}

const DROPPED = /[\u0000\ufffd]/

export function countDroppedGlyphs<T extends RecoveryItem>(items: readonly T[]): number {
  let count = 0
  for (const item of items) for (const character of item.str) if (DROPPED.test(character)) count++
  return count
}

export function recoverDroppedGlyphs<T extends RecoveryItem>(
  items: readonly T[],
  codesByFont: ReadonlyMap<string, readonly number[]>,
  resolve: (fontName: string, code: number) => string | null,
): RecoveryResult<T> {
  const droppedByFont = new Map<string, number>()
  for (const item of items) {
    let count = 0
    for (const character of item.str) if (DROPPED.test(character)) count++
    if (count) droppedByFont.set(item.fontName, (droppedByFont.get(item.fontName) ?? 0) + count)
  }

  // The glyph sequence for a font is only usable when its dropped glyphs line up
  // one for one with the dropped characters in the text. Aligning a partial list
  // would silently attach the wrong character to the wrong position.
  const aligned = new Set<string>()
  for (const [fontName, count] of droppedByFont) {
    const codes = codesByFont.get(fontName)
    if (codes && codes.length === count) aligned.add(fontName)
  }

  const cursors = new Map<string, number>()
  let recovered = 0
  let unresolved = 0
  const rewritten: T[] = items.map((item) => {
    if (!aligned.has(item.fontName)) return item
    const codes = codesByFont.get(item.fontName) as readonly number[]
    let cursor = cursors.get(item.fontName) ?? 0
    let str = ''
    let changed = false
    for (const character of item.str) {
      if (!DROPPED.test(character)) { str += character; continue }
      const text = resolve(item.fontName, codes[cursor++])
      if (text) { str += text; changed = true; recovered++ } else { str += character; unresolved++ }
    }
    cursors.set(item.fontName, cursor)
    return changed ? { ...item, str } : item
  })

  return { items: rewritten, recovered, unresolved, unalignedFonts: [...droppedByFont.keys()].filter(name => !aligned.has(name)) }
}
