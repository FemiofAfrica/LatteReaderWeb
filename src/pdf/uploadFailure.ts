// Upload failure diagnosis: one honest cause per rejected file, one fixed reason code per
// cause, one plain sentence for the reader.
//
// This module deliberately imports nothing. It has no PDF.js dependency, so a failure can be
// classified without loading the parser, and the rules stay unit testable. PDF.js error
// types are injected by the caller rather than imported here.

export const UPLOAD_REASON_CODES = [
  'file-empty',
  'file-not-pdf',
  'file-unreadable',
  'pdf-password',
  'pdf-damaged',
  'pdf-unopened',
  'storage-full',
  'storage-save',
  'document-open',
] as const

export type UploadReasonCode = (typeof UPLOAD_REASON_CODES)[number]

/**
 * Where the failure happened.
 *
 * `validate` and `replace` both leave the saved document untouched, so only they may claim
 * that. `open` happens after the document was stored and must never make that claim.
 */
export type UploadPhase = 'read' | 'validate' | 'replace' | 'open'

export interface UploadFacts {
  /** Size the browser reports for the file. */
  fileSize: number
  /** Bytes actually available to read. */
  byteLength: number
  hasPdfHeader: boolean
}

export interface UploadFailure {
  code: UploadReasonCode
  message: string
  /** True only when the saved document was already replaced before this failure. */
  replaced: boolean
}

// Short, plain, specific. No jargon, no internal names, no em dash. Exported so the copy
// itself is asserted rather than inferred, and so a change to it is always deliberate.
export const UPLOAD_MESSAGES: Record<UploadReasonCode, string> = {
  'file-empty': 'That file is empty, so your saved document was not changed.',
  'file-not-pdf': 'That file is not a PDF, so your saved document was not changed.',
  'file-unreadable': 'That file could not be read from where it lives, so your saved document was not changed. Download it first and try again.',
  'pdf-password': 'That PDF is locked with a password, so your saved document was not changed. Unlock it and try again.',
  'pdf-damaged': 'That PDF is damaged or incomplete, so your saved document was not changed.',
  'pdf-unopened': 'That PDF could not be opened, so your saved document was not changed.',
  'storage-full': 'There is not enough room in this browser to save that PDF, so your saved document was not changed.',
  'storage-save': 'That PDF could not be saved in this browser, so your saved document was not changed.',
  'document-open': 'Your new PDF was saved, but it could not be opened for reading. Open the file again to recover.',
}

/** A PDF header may appear anywhere inside the first 1024 bytes, not only at the front. */
export const PDF_HEADER_WINDOW = 1024
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-

export function hasPdfHeader(bytes: ArrayBuffer): boolean {
  const window = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, PDF_HEADER_WINDOW))
  for (let start = 0; start + PDF_HEADER.length <= window.length; start++) {
    if (PDF_HEADER.every((byte, offset) => window[start + offset] === byte)) return true
  }
  return false
}

/** PDF.js error classes, injected so classification uses types instead of message text. */
export interface PdfErrorClasses {
  invalid?: new (...args: never[]) => object
  password?: new (...args: never[]) => object
  response?: new (...args: never[]) => object
}

function failure(code: UploadReasonCode, replaced = false): UploadFailure {
  return { code, message: UPLOAD_MESSAGES[code], replaced }
}

function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name
  return typeof name === 'string' ? name : ''
}

// Checks the error type first. The name fallback covers the few PDF.js classes this build
// does not export, and never inspects a message.
function isPdfPassword(error: unknown, pdf: PdfErrorClasses): boolean {
  if (pdf.password && error instanceof pdf.password) return true
  return errorName(error) === 'PasswordException'
}

function isPdfInvalid(error: unknown, pdf: PdfErrorClasses): boolean {
  if (pdf.invalid && error instanceof pdf.invalid) return true
  return ['InvalidPDFException', 'FormatError'].includes(errorName(error))
}

function isPdfResponse(error: unknown, pdf: PdfErrorClasses): boolean {
  if (pdf.response && error instanceof pdf.response) return true
  return ['ResponseException', 'MissingPDFException', 'UnexpectedResponseException'].includes(errorName(error))
}

function isStorageFailure(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return true
  return ['UnknownError', 'InvalidStateError', 'NotAllowedError', 'DataError', 'TransactionInactiveError'].includes(errorName(error))
}

/** A full disk or cache, the browser's own out-of-space signal. */
function isOutOfRoom(error: unknown): boolean {
  return ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(errorName(error))
}

/**
 * The checks that run before PDF.js is asked to parse anything. A real PDF may carry leading
 * bytes before its header, so the header test scans the whole first 1024 bytes instead of
 * trusting the first four.
 */
export function preflightFailure(facts: UploadFacts): UploadFailure | null {
  if (facts.byteLength === 0) {
    // A file that reports bytes but yields none has not been downloaded to this device yet.
    return failure(facts.fileSize > 0 ? 'file-unreadable' : 'file-empty')
  }
  if (!facts.hasPdfHeader) return failure('file-not-pdf')
  return null
}

/**
 * Classifies a failure that has already been located in the upload sequence. The phase is the
 * caller's knowledge, not a guess from the error, so the honesty of the message is decided by
 * where the code actually stood.
 */
export function classifyUploadFailure(
  error: unknown,
  phase: UploadPhase,
  pdf: PdfErrorClasses = {},
): UploadFailure {
  // Stored already: the document was replaced, so never claim it was unchanged.
  if (phase === 'open') return failure('document-open', true)
  if (phase === 'read') return failure('file-unreadable')

  // The replace step is the only place the browser can run out of room for the document.
  if (isOutOfRoom(error)) return failure('storage-full')
  if (isPdfPassword(error, pdf)) return failure('pdf-password')
  if (isPdfInvalid(error, pdf)) return failure('pdf-damaged')
  if (isPdfResponse(error, pdf)) return failure('file-unreadable')
  if (phase === 'replace') return failure('storage-save')
  // Anything else escaping the store is the browser's storage layer, never PDF.js, whose
  // failures are named above or below.
  if (isStorageFailure(error)) return failure('storage-save')
  return failure('pdf-unopened')
}
