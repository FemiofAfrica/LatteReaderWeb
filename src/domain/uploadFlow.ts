import type { CurrentDocumentRecord } from './currentDocumentStore'
import type { ErrorCode, EventName } from '../diagnostics/schema'
import {
  classifyUploadFailure,
  hasPdfHeader,
  preflightFailure,
  type PdfErrorClasses,
  type UploadFacts,
  type UploadFailure,
  type UploadPhase,
} from '../pdf/uploadFailure'

export interface UploadEventDetails {
  count?: number
  durationMs?: number
  errorCode?: ErrorCode
}

export interface UploadDeps<TDocument> {
  readBytes: (file: File) => Promise<ArrayBuffer>
  buildRecord: (file: File, bytes: ArrayBuffer) => CurrentDocumentRecord
  validate: (bytes: ArrayBuffer) => Promise<TDocument>
  validateAndReplace: (record: CurrentDocumentRecord, validate: (bytes: ArrayBuffer) => Promise<TDocument>) => Promise<TDocument>
  activate: (record: CurrentDocumentRecord, document: TDocument) => Promise<void>
  numPages: (document: TDocument) => number
  record: (event: EventName, details?: UploadEventDetails) => void
  /** Bound with the real PDF.js error classes by the caller, which imports it on demand. */
  classify: (error: unknown, phase: UploadPhase) => UploadFailure | Promise<UploadFailure>
  now?: () => number
}

/**
 * Opens one uploaded file as the current document.
 *
 * The sequence is deliberately split so each failure is described by where it happened:
 * read, preflight, validate, replace, then open. Validation runs before the stored document
 * is touched, so a failure in the first four phases genuinely leaves the saved document
 * intact. Opening happens after the replacement, so a failure there says the document was
 * saved and offers a recovery path instead of the old false claim that nothing changed.
 *
 * Returns the failure that was reported, or null when the document opened.
 */
export async function uploadDocument<TDocument>(file: File, deps: UploadDeps<TDocument>): Promise<UploadFailure | null> {
  const now = deps.now ?? (() => performance.now())
  const started = now()
  deps.record('upload.start')
  const report = (failure: UploadFailure) => {
    deps.record('upload.fail', { errorCode: failure.code, durationMs: Math.round(now() - started) })
    return failure
  }

  let bytes: ArrayBuffer
  try {
    bytes = await deps.readBytes(file)
  } catch {
    return report(classifyUploadFailure(null, 'read'))
  }

  const facts: UploadFacts = {
    fileSize: file.size,
    byteLength: bytes.byteLength,
    hasPdfHeader: hasPdfHeader(bytes),
  }
  const preflight = preflightFailure(facts)
  if (preflight) return report(preflight)

  const record = deps.buildRecord(file, bytes)
  // Set once validation resolves, which is the only way to tell a validation failure from a
  // storage failure inside the single atomic validate-then-replace call.
  let validated = false
  let document: TDocument
  try {
    document = await deps.validateAndReplace(record, async (validationBytes: ArrayBuffer) => {
      const loaded = await deps.validate(validationBytes)
      validated = true
      return loaded
    })
  } catch (error) {
    const phase: UploadPhase = validated ? 'replace' : 'validate'
    return report(await deps.classify(error, phase))
  }

  const count = deps.numPages(document)
  deps.record('upload.validated', { count })
  deps.record('upload.replaced', { count, durationMs: Math.round(now() - started) })

  try {
    await deps.activate(record, document)
  } catch (error) {
    // The replacement already landed: report that truthfully.
    return report(await deps.classify(error, 'open'))
  }
  return null
}

/** Kept separate so the PDF.js error classes never reach the pure classification rules. */
export type { PdfErrorClasses }
