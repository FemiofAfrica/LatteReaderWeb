// Upstream legacy build supplies reviewed compatibility in this realm.
import { GlobalWorkerOptions, InvalidPDFException, PasswordException, ResponseException, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { classifyUploadFailure, type PdfErrorClasses, type UploadFailure, type UploadPhase } from './uploadFailure'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// PDF.js's own error types, so upload failures are classified on type rather than on message
// text. The parser stays lazily imported: nothing here runs until a document is opened.
const PDF_ERROR_CLASSES: PdfErrorClasses = {
  invalid: InvalidPDFException,
  password: PasswordException,
  response: ResponseException,
}

// Imported only when an upload or a saved document needs PDF.js.
export function loadPdf(bytes: ArrayBuffer) {
  return getDocument({ data: bytes }).promise
}

export function classifyUploadError(error: unknown, phase: UploadPhase): UploadFailure {
  return classifyUploadFailure(error, phase, PDF_ERROR_CLASSES)
}
