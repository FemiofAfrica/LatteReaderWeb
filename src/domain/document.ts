export type ExtractionMessage =
  | { type: 'metadata'; pageCount: number }
  | { type: 'page'; pageNumber: number; text: string; characterCount: number; unmapped: number }
  | { type: 'complete'; characterCount: number; scanned: boolean }
  | { type: 'error'; message: string }

export interface DocumentState {
  name: string
  id: string
  size: number
  pageCount: number
  pages: string[]
  characterCount: number
  extractedPages: number
  extraction: 'loading' | 'extracting' | 'complete' | 'error'
  scanned: boolean
  error: string
  unmapped: number
}

export const emptyDocumentState = (): DocumentState => ({
  name: '',
  id: '',
  size: 0,
  pageCount: 0,
  pages: [],
  characterCount: 0,
  extractedPages: 0,
  extraction: 'loading',
  scanned: false,
  error: '',
  unmapped: 0,
})
