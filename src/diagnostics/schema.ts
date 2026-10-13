// No free-text fields: messages, stacks, URLs and document identifiers are discarded.
export const APP_VERSION = '0.1.0-diag.1'
export const EVENTS = [
  'session.start', 'upload.start', 'upload.validated', 'upload.replaced', 'upload.fail',
  'restore.start', 'restore.complete', 'restore.empty', 'restore.fail', 'delete.start', 'delete.complete', 'delete.fail',
  'extraction.start', 'extraction.progress', 'extraction.complete', 'extraction.fail',
  'renderer.start', 'renderer.complete', 'renderer.fail', 'analysis.start', 'analysis.complete', 'analysis.fail',
  'speech.start', 'speech.pause', 'speech.resume', 'speech.stop', 'speech.end', 'speech.error',
  'window.error', 'window.rejection',
] as const
export type EventName = typeof EVENTS[number]
export const ERROR_CODES = ['unknown', 'type', 'range', 'syntax', 'abort', 'pdf', 'worker', 'storage', 'speech', 'render'] as const
export type ErrorCode = typeof ERROR_CODES[number]
export interface DiagnosticEvent {
  timestamp: string
  sessionId: string
  version: typeof APP_VERSION
  event: EventName
  severity: 'info' | 'error'
  page?: number
  count?: number
  durationMs?: number
  zoom?: number
  errorCode?: ErrorCode
}
const numericKeys = ['page', 'count', 'durationMs', 'zoom'] as const
export function validateEvent(value: unknown): value is DiagnosticEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => !['timestamp', 'sessionId', 'version', 'event', 'severity', 'errorCode', ...numericKeys].includes(k))) return false
  if (typeof v.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.timestamp) || !Number.isFinite(Date.parse(v.timestamp))) return false
  if (typeof v.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.sessionId)) return false
  if (v.version !== APP_VERSION || !EVENTS.includes(v.event as EventName)) return false
  if (v.severity !== (String(v.event).match(/fail$|error$|rejection$/) ? 'error' : 'info')) return false
  if (v.errorCode !== undefined && !ERROR_CODES.includes(v.errorCode as ErrorCode)) return false
  // Event-specific allowlists prevent repurposing otherwise valid fields.
  const event = v.event as EventName
  const allowed = new Set<string>()
  if (/^(upload|restore|extraction|analysis)\.(start|validated|replaced|complete)$/.test(event)) allowed.add('count')
  if (event === 'extraction.progress' || event.startsWith('renderer.')) allowed.add('page')
  if (event.startsWith('renderer.')) allowed.add('zoom')
  if (/\.(complete|replaced|fail|end)$/.test(event)) allowed.add('durationMs')
  if (v.severity === 'error') allowed.add('errorCode')
  if ([...numericKeys, 'errorCode'].some(key => v[key] !== undefined && !allowed.has(key))) return false
  return numericKeys.every(k => v[k] === undefined || (typeof v[k] === 'number' && Number.isInteger(v[k]) && v[k] >= 0 && v[k] <= 1e9))
}
export function classifyError(reason: unknown): ErrorCode {
  // Never serialize or inspect message/stack; even error names are mapped to constants.
  if (reason instanceof TypeError) return 'type'
  if (reason instanceof RangeError) return 'range'
  if (reason instanceof SyntaxError) return 'syntax'
  return 'unknown'
}
