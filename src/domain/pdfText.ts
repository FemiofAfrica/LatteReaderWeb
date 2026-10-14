export interface PdfTextItem {
  str: string; width: number; height: number; transform: number[]; dir: string; hasEOL: boolean
}
export function joinPdfTextItems(items: readonly PdfTextItem[]): string {
  let text = ''
  let previous: PdfTextItem | undefined
  for (const item of items) {
    if (previous && !/\s$/.test(text) && !/^\s/.test(item.str) && item.str) {
      text += separator(previous, item)
    }
    text += item.str
    if (item.hasEOL) text += '\n'
    // PDF.js can emit empty EOL markers; do not lose the preceding geometry.
    if (item.str) previous = item
  }
  return text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
}

/** Join only nearly touching runs on the same baseline and writing axis.
 * Content, names and dictionaries never decide spacing. Ambiguous geometry
 * retains a separator rather than silently gluing words together. */
function separator(a: PdfTextItem, b: PdfTextItem): string {
  const [ax, ay, , , x, y] = a.transform
  const [bx, by, , , nextX, nextY] = b.transform
  const size = Math.hypot(ax, ay), nextSize = Math.hypot(bx, by)
  if (!size || !nextSize || ![ax, ay, bx, by, x, y, nextX, nextY, a.width].every(Number.isFinite)) return ' '
  const ux = ax / size, uy = ay / size
  const alignment = ux * bx / nextSize + uy * by / nextSize
  const dx = nextX - x, dy = nextY - y
  const em = Math.min(size, nextSize)
  if (alignment < 0.999 || a.dir !== b.dir || a.dir === 'ttb') return '\n'
  if (Math.abs(-uy * dx + ux * dy) > em * 0.15) return '\n'
  // PDF.js RTL item origins/widths do not express logical-end geometry.
  // Preserve their logical order without guessing an adjacency from LTR math.
  if (a.dir === 'rtl') return ' '
  const gap = ux * dx + uy * dy - a.width
  if (gap < -em * 0.15 || gap > em * 2) return '\n'
  return gap <= em * 0.12 ? '' : ' '
}
