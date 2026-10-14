import { normalizeExtractedText } from './textQuality'

export interface TextAvailability {
  pagesWithReadableText: number
  pagesWithoutReadableText: number
}

/** Availability is not scan detection: blanks and broken mappings are not image evidence. */
export function hasUsableText(text: string): boolean {
  return normalizeExtractedText(text).text.replace(/[\s\u0000-\u001f\u007f\ufffd]/g, '').length > 0
}

export function textAvailability(pages: readonly string[]): TextAvailability {
  const pagesWithReadableText = pages.filter(hasUsableText).length
  return { pagesWithReadableText, pagesWithoutReadableText: pages.length - pagesWithReadableText }
}

export type ExtractionErrorCode = 'extract-startup' | 'extract-runtime' | 'extract-protocol' | 'extract-pdf'
export const extractionErrorCopy: Record<ExtractionErrorCode, string> = {
  'extract-startup': 'Text extraction could not start. Try opening the PDF again.',
  'extract-runtime': 'Text extraction stopped unexpectedly. Try opening the PDF again.',
  'extract-protocol': 'Text extraction returned an invalid result. Try opening the PDF again.',
  'extract-pdf': 'Could not extract text from this PDF. Try opening it again.',
}

export type ExtractionMessage =
  | { type: 'metadata'; pageCount: number }
  | { type: 'page'; pageNumber: number; text: string; characterCount: number; unmapped: number }
  | ({ type: 'complete'; characterCount: number } & TextAvailability)
  | { type: 'error'; errorCode: ExtractionErrorCode }

export function isExtractionMessage(value: unknown, pageCount: number): value is ExtractionMessage {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (v.type === 'metadata') return v.pageCount === pageCount
  if (v.type === 'page') return count(v.pageNumber) && v.pageNumber >= 1 && v.pageNumber <= pageCount && typeof v.text === 'string' && count(v.characterCount) && count(v.unmapped)
  if (v.type === 'complete') return count(v.characterCount) && count(v.pagesWithReadableText) && count(v.pagesWithoutReadableText) && v.pagesWithReadableText + v.pagesWithoutReadableText === pageCount
  return v.type === 'error' && typeof v.errorCode === 'string' && Object.hasOwn(extractionErrorCopy, v.errorCode)
}

export interface DocumentState extends TextAvailability {
  name: string
  id: string
  size: number
  pageCount: number
  pages: string[]
  characterCount: number
  extractedPages: number
  extraction: 'loading' | 'extracting' | 'complete' | 'error'
  error: string
  errorCode?: ExtractionErrorCode
  unmapped: number
}

export function availabilityWarning(document: DocumentState): string {
  if (document.extraction !== 'complete') return ''
  if (!document.pagesWithReadableText) return 'No readable text found. This may be an image-only PDF; OCR is not available.'
  const missing = document.pagesWithoutReadableText
  return missing ? `${missing} ${missing === 1 ? 'page has' : 'pages have'} no readable text. Reading skips these pages; they may be blank or image-only. OCR is not available.` : ''
}

export const emptyDocumentState = (): DocumentState => ({
  name: '', id: '', size: 0, pageCount: 0, pages: [], characterCount: 0,
  extractedPages: 0, extraction: 'loading', pagesWithReadableText: 0,
  pagesWithoutReadableText: 0, error: '', unmapped: 0,
})
