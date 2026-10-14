/** Minimal read-only sfnt (TrueType/OpenType) reader.
 *
 * It exists for one job: naming glyphs whose Unicode the document's own
 * ToUnicode CMap does not state. Every fact used here is read out of the
 * embedded font program — the character map the font ships with, the glyph
 * programs, the advance widths. Nothing is inferred from language, a
 * dictionary, a spell checker or a heuristically "expected" letter.
 *
 * A document whose font cannot name a glyph therefore stays honestly
 * unresolved instead of gaining a plausible-looking wrong letter.
 */

export interface SfntFont {
  readonly numGlyphs: number
  /** glyph id -> the single codepoint the font's own cmap gives it.
   * Glyphs the font maps to more than one codepoint, and codepoints that are
   * not readable text (controls, surrogates, private use), are omitted. */
  readonly codepointByGlyph: ReadonlyMap<number, number>
  /** codepoint -> glyph id for the same verified mapping. */
  readonly glyphByCodepoint: ReadonlyMap<number, number>
  /** glyph id -> component glyph ids, for composite glyphs only. */
  readonly componentsByGlyph: ReadonlyMap<number, readonly number[]>
  /** Advance width straight out of hmtx. */
  advanceWidth(gid: number): number
  /** A glyph whose outline program is empty draws nothing (a placeholder). */
  isEmpty(gid: number): boolean
}

const SFNT_SIGNATURES = [0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */, 0x74746366 /* ttcf */]

export function isSfnt(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const signature = (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0
  return SFNT_SIGNATURES.includes(signature)
}

/** Glyph outlines carry no text; codepoints outside readable text (control
 * characters, surrogates, private use areas, non-characters) name nothing. */
function isReadableCodepoint(codepoint: number): boolean {
  if (codepoint < 0x20 || codepoint > 0x10ffff) return false
  if (codepoint >= 0x7f && codepoint <= 0x9f) return false
  if (codepoint >= 0xd800 && codepoint <= 0xdfff) return false
  if (codepoint >= 0xe000 && codepoint <= 0xf8ff) return false
  if (codepoint >= 0xf0000) return false
  if (codepoint === 0xfffc || codepoint === 0xfffd || codepoint === 0xfffe || codepoint === 0xffff) return false
  return true
}

function tableDirectory(bytes: Uint8Array): Map<string, { offset: number; length: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tables = new Map<string, { offset: number; length: number }>()
  const count = view.getUint16(4)
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16
    if (record + 16 > bytes.length) break
    const tag = String.fromCharCode(bytes[record], bytes[record + 1], bytes[record + 2], bytes[record + 3])
    const offset = view.getUint32(record + 8)
    const length = view.getUint32(record + 12)
    if (offset + length <= bytes.length) tables.set(tag, { offset, length })
  }
  return tables
}

/** cmap subtable walk covering formats 0, 4, 6 and 12. */
function readCmap(bytes: Uint8Array, offset: number, length: number, add: (codepoint: number, gid: number) => void): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = offset + length
  if (offset + 4 > bytes.length) return
  const subtables = view.getUint16(offset + 2)
  for (let i = 0; i < subtables; i++) {
    const record = offset + 4 + i * 8
    if (record + 8 > end || record + 8 > bytes.length) break
    const subtable = offset + view.getUint32(record + 4)
    if (subtable + 2 > bytes.length) continue
    const format = view.getUint16(subtable)
    if (format === 0) {
      if (subtable + 262 > bytes.length) continue
      for (let codepoint = 0; codepoint < 256; codepoint++) {
        const gid = view.getUint8(subtable + 6 + codepoint)
        if (gid) add(codepoint, gid)
      }
    } else if (format === 4) {
      if (subtable + 14 > bytes.length) continue
      const segments = view.getUint16(subtable + 6) / 2
      const ends = subtable + 14
      const starts = ends + segments * 2 + 2
      const deltas = starts + segments * 2
      const ranges = deltas + segments * 2
      if (ranges + segments * 2 > bytes.length) continue
      for (let segment = 0; segment < segments; segment++) {
        const last = view.getUint16(ends + segment * 2)
        const first = view.getUint16(starts + segment * 2)
        if (first > last) continue
        const delta = view.getInt16(deltas + segment * 2)
        const rangeOffset = view.getUint16(ranges + segment * 2)
        for (let codepoint = first; codepoint <= last && codepoint !== 0xffff; codepoint++) {
          let gid: number
          if (rangeOffset === 0) {
            gid = (codepoint + delta) & 0xffff
          } else {
            const index = ranges + segment * 2 + rangeOffset + (codepoint - first) * 2
            if (index + 2 > bytes.length) continue
            gid = view.getUint16(index)
            if (gid) gid = (gid + delta) & 0xffff
          }
          if (gid) add(codepoint, gid)
        }
      }
    } else if (format === 6) {
      if (subtable + 10 > bytes.length) continue
      const first = view.getUint16(subtable + 6)
      const count = view.getUint16(subtable + 8)
      if (subtable + 10 + count * 2 > bytes.length) continue
      for (let i = 0; i < count; i++) {
        const gid = view.getUint16(subtable + 10 + i * 2)
        if (gid) add(first + i, gid)
      }
    } else if (format === 12) {
      if (subtable + 16 > bytes.length) continue
      const groups = view.getUint32(subtable + 12)
      if (subtable + 16 + groups * 12 > bytes.length) continue
      for (let group = 0; group < groups; group++) {
        const record = subtable + 16 + group * 12
        const first = view.getUint32(record)
        const last = view.getUint32(record + 4)
        const startGlyph = view.getUint32(record + 8)
        if (last - first > 0x10000) continue
        for (let codepoint = first; codepoint <= last; codepoint++) {
          const gid = startGlyph + (codepoint - first)
          if (gid) add(codepoint, gid)
        }
      }
    }
  }
}

/** Component glyph ids of a composite glyph program, in draw order. */
function componentGlyphs(bytes: Uint8Array, start: number, end: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const components: number[] = []
  let position = start + 10
  while (position + 4 <= end && components.length < 64) {
    const flags = view.getUint16(position)
    components.push(view.getUint16(position + 2))
    position += 4
    position += flags & 0x0001 ? 4 : 2
    if (flags & 0x0008) position += 2
    else if (flags & 0x0040) position += 4
    else if (flags & 0x0080) position += 8
    if (!(flags & 0x0020)) break
  }
  return components
}

export function parseSfntFont(bytes: Uint8Array): SfntFont | null {
  if (!isSfnt(bytes) || bytes.length < 12) return null
  const tables = tableDirectory(bytes)
  const head = tables.get('head')
  const maxp = tables.get('maxp')
  const loca = tables.get('loca')
  const glyf = tables.get('glyf')
  const hhea = tables.get('hhea')
  const hmtx = tables.get('hmtx')
  if (!maxp || !hhea || !hmtx) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const numGlyphs = view.getUint16(maxp.offset + 4)
  if (!numGlyphs || numGlyphs > 0xffff) return null

  const codepoints = new Map<number, Set<number>>()
  const cmap = tables.get('cmap')
  if (cmap) {
    readCmap(bytes, cmap.offset, cmap.length, (codepoint, gid) => {
      if (gid >= numGlyphs || !isReadableCodepoint(codepoint)) return
      const set = codepoints.get(gid)
      if (set) set.add(codepoint)
      else codepoints.set(gid, new Set([codepoint]))
    })
  }
  const codepointByGlyph = new Map<number, number>()
  const glyphByCodepoint = new Map<number, number>()
  for (const [gid, set] of codepoints) {
    // Ambiguous glyphs (one glyph drawn for several different characters) name nothing.
    if (set.size !== 1) continue
    const [codepoint] = set
    codepointByGlyph.set(gid, codepoint)
    if (!glyphByCodepoint.has(codepoint)) glyphByCodepoint.set(codepoint, gid)
  }

  const offsets: number[] | null = head && loca ? readLocaOffsets(bytes, head, loca, numGlyphs) : null
  const componentsByGlyph = new Map<number, readonly number[]>()
  if (offsets && glyf) {
    for (let gid = 0; gid < numGlyphs; gid++) {
      const start = glyf.offset + offsets[gid]
      const end = glyf.offset + offsets[gid + 1]
      if (end - start < 10) continue
      if (view.getInt16(start) >= 0) continue // simple glyph, no components
      const components = componentGlyphs(bytes, start, end)
      if (components.length) componentsByGlyph.set(gid, components)
    }
  }

  const numberOfHMetrics = view.getUint16(hhea.offset + 34)
  const advanceWidth = (gid: number): number => {
    if (gid < 0 || gid >= numGlyphs) return 0
    const index = numberOfHMetrics ? Math.min(gid, numberOfHMetrics - 1) : 0
    const position = hmtx.offset + index * 4
    return position + 2 <= bytes.length ? view.getUint16(position) : 0
  }

  /** Format 3/4 loca tables are absent in rare subsets; an empty outline is
   * then unknowable and every glyph is reported as non-empty (never guessed). */
  const isEmpty = (gid: number): boolean => {
    if (!offsets) return false
    if (gid < 0 || gid >= numGlyphs) return true
    return offsets[gid + 1] - offsets[gid] === 0
  }

  return { numGlyphs, codepointByGlyph, glyphByCodepoint, componentsByGlyph, advanceWidth, isEmpty }
}

function readLocaOffsets(bytes: Uint8Array, head: { offset: number }, loca: { offset: number; length: number }, numGlyphs: number): number[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const format = view.getInt16(head.offset + 50)
  const count = numGlyphs + 1
  if (format === 0) {
    if (loca.offset + count * 2 > bytes.length) return null
    return Array.from({ length: count }, (_, i) => view.getUint16(loca.offset + i * 2) * 2)
  }
  if (format === 1) {
    if (loca.offset + count * 4 > bytes.length) return null
    return Array.from({ length: count }, (_, i) => view.getUint32(loca.offset + i * 4))
  }
  return null
}
