// Upstream legacy build supplies reviewed compatibility in this realm.
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// Imported only when an upload or a saved document needs PDF.js.
export function loadPdf(bytes: ArrayBuffer) {
  return getDocument({ data: bytes }).promise
}
