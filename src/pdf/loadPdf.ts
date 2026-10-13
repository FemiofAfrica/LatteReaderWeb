import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// Imported only when an upload or a saved document needs PDF.js.
export function loadPdf(bytes: ArrayBuffer) {
  return getDocument({ data: bytes }).promise
}
