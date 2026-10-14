import { isSfnt, parseSfntFont, type SfntFont } from './sfnt'

/** Reads the font programs a PDF embeds in itself.
 *
 * PDF.js hands applications the font it re-encodes for drawing. That copy has
 * its character map replaced with private-use codes, so it can no longer say
 * which Unicode a glyph stands for. The document still contains the original
 * embedded program, and that program's own cmap is the evidence this fix uses.
 *
 * Only the objects a FontDescriptor points at are touched, so a 341-page book
 * inflates a handful of small streams, not every image on the page.
 */

export interface EmbeddedFontProgram {
  readonly objectNumber: number
  readonly font: SfntFont
}

interface StreamSlice {
  data: Uint8Array
  flate: boolean
}

const MAX_PROGRAMS = 64

function latin1(bytes: Uint8Array): string {
  const chunk = 0x8000
  let out = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }
  return out
}

function objectStart(text: string, objectNumber: number): number {
  const pattern = new RegExp(`(?:^|[\\r\\n\\s])${objectNumber}\\s+0\\s+obj\\b`)
  const match = pattern.exec(text)
  return match ? match.index : -1
}

function streamAt(text: string, bytes: Uint8Array, start: number): StreamSlice | null {
  const keyword = text.indexOf('stream', start)
  if (keyword < 0) return null
  const dictionary = text.slice(start, keyword)
  const flate = /\/Filter\s*(?:\[\s*)?\/FlateDecode/.test(dictionary)
  const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictionary)
  let dataStart = keyword + 'stream'.length
  while (dataStart < bytes.length && (bytes[dataStart] === 0x0d || bytes[dataStart] === 0x0a)) dataStart++
  let dataEnd: number
  if (declared) {
    dataEnd = dataStart + Number(declared[1])
  } else {
    dataEnd = text.indexOf('endstream', dataStart)
    if (dataEnd < 0) return null
    while (dataEnd > dataStart && (bytes[dataEnd - 1] === 0x0d || bytes[dataEnd - 1] === 0x0a)) dataEnd--
  }
  if (dataEnd <= dataStart || dataEnd > bytes.length) return null
  return { data: bytes.subarray(dataStart, dataEnd), flate }
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream !== 'function') return null
  try {
    const stream = new DecompressionStream('deflate')
    const writer = stream.writable.getWriter()
    // Copy into a fresh, non-shared buffer: the zlib writable accepts only
    // ArrayBuffer-backed views.
    const input = new Uint8Array(bytes.byteLength)
    input.set(bytes)
    void writer.write(input)
    void writer.close()
    const buffer = await new Response(stream.readable).arrayBuffer()
    return new Uint8Array(buffer)
  } catch {
    return null
  }
}

export async function indexEmbeddedFontPrograms(pdf: Uint8Array): Promise<EmbeddedFontProgram[]> {
  const text = latin1(pdf)
  const references = new Set<number>()
  for (const match of text.matchAll(/\/FontFile[23]?\s+(\d+)\s+0\s+R/g)) {
    references.add(Number(match[1]))
    if (references.size >= MAX_PROGRAMS) break
  }
  const programs: EmbeddedFontProgram[] = []
  for (const objectNumber of references) {
    const start = objectStart(text, objectNumber)
    if (start < 0) continue
    const slice = streamAt(text, pdf, start)
    if (!slice) continue
    let bytes = slice.data
    if (slice.flate) {
      const inflated = await inflate(bytes)
      if (!inflated) continue
      bytes = inflated
    }
    if (!isSfnt(bytes)) continue
    const font = parseSfntFont(bytes)
    if (font) programs.push({ objectNumber, font })
  }
  return programs
}
