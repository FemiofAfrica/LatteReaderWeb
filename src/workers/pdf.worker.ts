/// <reference lib="webworker" />
// Upstream legacy build supplies reviewed compatibility in this realm.
import { GlobalWorkerOptions, OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { normalizeExtractedText } from '../domain/textQuality'
import { joinPdfTextItems } from '../domain/pdfText'
import { hasUsableText, type ExtractionMessage } from '../domain/document'
import { recoverDroppedGlyphs } from '../domain/ligatureRecovery'
import { indexEmbeddedFontPrograms } from '../pdf/embeddedFonts'
import { collectGlyphRuns, createFontCodeResolver, hasEnoughEvidence } from '../pdf/glyphRecovery'

// PDF.js's automatic worker setup reads window.location, which does not
// exist in this extraction worker. Supply a real nested worker explicitly
// instead of letting that path fall back to a LoopbackPort in this realm.
GlobalWorkerOptions.workerPort = new Worker(
  pdfWorkerUrl,
  { type: 'module' },
)

type Request = { type: 'extract'; bytes: ArrayBuffer }
const send = (message: ExtractionMessage) => self.postMessage(message)

const DROPPED_GLYPH = /[\u0000\ufffd]/

self.onmessage = async (event: MessageEvent<Request>) => {
  if (event.data.type !== 'extract') return
  try {
    const pdf = new Uint8Array(event.data.bytes)
    // PDF.js may take ownership of the transferred buffer, so the font scan
    // works from its own copy rather than from a detached view.
    const fontSource = pdf.slice()
    const document = await getDocument({ data: pdf }).promise
    send({ type: 'metadata', pageCount: document.numPages })
    // The document's own embedded font programs, read once and only if a page
    // actually has a glyph the document failed to name.
    let embeddedFonts: Awaited<ReturnType<typeof indexEmbeddedFontPrograms>> | null = null
    // One resolver per font: the naming evidence is a property of the font, not
    // of the page, so a page-level retry can never be cheaper than this cache.
    const resolvers = new Map<string, (code: number) => string | null>()
    // Fonts no embedded program could speak for: the second content-stream pass
    // that reads raw character codes is not worth paying for them again.
    const hopeless = new Set<string>()
    let characterCount = 0
    let pagesWithText = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      let items = content.items.filter((item): item is TextItem => 'str' in item)
      if (items.some(item => DROPPED_GLYPH.test(item.str))) {
        embeddedFonts ??= await indexEmbeddedFontPrograms(fontSource)
        const droppedFonts = new Set(items.filter(item => DROPPED_GLYPH.test(item.str)).map(item => item.fontName))
        const worthReading = embeddedFonts.length > 0 && [...droppedFonts].some(name => !hopeless.has(name))
        if (worthReading) {
          const runs = collectGlyphRuns(await page.getOperatorList(), OPS.showText, OPS.showSpacedText, OPS.setFont)
          const codesByFont = new Map<string, readonly number[]>()
          for (const [fontName, run] of runs) {
            if (!run.unmappedCodes.length) continue
            if (!resolvers.has(fontName) && !hopeless.has(fontName)) {
              const resolve = createFontCodeResolver(embeddedFonts.map(program => program.font), run)
              if (resolve) resolvers.set(fontName, resolve)
              // Only a page that named enough glyphs can tell a font apart from
              // every other embedded program; a thin page is retried later.
              else if (hasEnoughEvidence(run.samples)) hopeless.add(fontName)
            }
            if (resolvers.has(fontName)) codesByFont.set(fontName, run.unmappedCodes)
          }
          items = recoverDroppedGlyphs(items, codesByFont, (fontName, code) => resolvers.get(fontName)?.(code) ?? null).items
        }
      }
      const text = joinPdfTextItems(items)
      const normalized = normalizeExtractedText(text)
      characterCount += normalized.text.length
      if (hasUsableText(normalized.text)) pagesWithText += 1
      send({ type: 'page', pageNumber, text: normalized.text, characterCount, unmapped: normalized.unmapped })
      page.cleanup()
    }
    send({
      type: 'complete',
      characterCount,
      pagesWithReadableText: pagesWithText,
      pagesWithoutReadableText: document.numPages - pagesWithText,
    })
    await document.cleanup()
  } catch {
    send({ type: 'error', errorCode: 'extract-pdf' })
  }
}
