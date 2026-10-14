/// <reference lib="webworker" />
// Upstream legacy build supplies reviewed compatibility in this realm.
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { normalizeExtractedText } from '../domain/textQuality'
import { joinPdfTextItems } from '../domain/pdfText'
import { hasUsableText, type ExtractionMessage } from '../domain/document'

// PDF.js's automatic worker setup reads window.location, which does not
// exist in this extraction worker. Supply a real nested worker explicitly
// instead of letting that path fall back to a LoopbackPort in this realm.
GlobalWorkerOptions.workerPort = new Worker(
  pdfWorkerUrl,
  { type: 'module' },
)

type Request = { type: 'extract'; bytes: ArrayBuffer }
const send = (message: ExtractionMessage) => self.postMessage(message)

self.onmessage = async (event: MessageEvent<Request>) => {
  if (event.data.type !== 'extract') return
  try {
    const document = await getDocument({ data: event.data.bytes }).promise
    send({ type: 'metadata', pageCount: document.numPages })
    let characterCount = 0
    let pagesWithText = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = joinPdfTextItems(content.items.filter((item): item is TextItem => 'str' in item))
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
