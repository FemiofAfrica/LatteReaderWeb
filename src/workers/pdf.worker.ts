/// <reference lib="webworker" />
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

type Request = { type: 'extract'; bytes: ArrayBuffer }
type Response =
  | { type: 'metadata'; pageCount: number }
  | { type: 'page'; pageNumber: number; text: string; characterCount: number }
  | { type: 'complete'; characterCount: number; scanned: boolean }
  | { type: 'error'; message: string }

const send = (message: Response) => self.postMessage(message)

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
      const text = content.items
        .filter((item): item is TextItem => 'str' in item)
        .map((item) => `${item.str}${item.hasEOL ? '\n' : ' '}`)
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim()
      characterCount += text.length
      if (text.length >= 20) pagesWithText += 1
      send({ type: 'page', pageNumber, text, characterCount })
      page.cleanup()
    }
    const sampledPages = Math.min(document.numPages, 5)
    send({
      type: 'complete',
      characterCount,
      scanned: sampledPages > 0 && pagesWithText === 0,
    })
    await document.cleanup()
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : 'Could not read this PDF.' })
  }
}
