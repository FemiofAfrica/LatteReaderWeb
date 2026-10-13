import { APP_VERSION, classifyError, validateEvent, type DiagnosticEvent, type ErrorCode, type EventName } from './schema'
export const BUFFER_LIMIT = 250
export const TRANSPORT_TIMEOUT_MS = 3000
export const MAX_BATCH_ATTEMPTS = 4
const RETRY_BACKOFF_MS = [250, 750, 1500, 3000]
// Fixed, content-free reason codes for a failed send. No status text, URL or payload.
export const TRANSPORT_REASONS = ['none', 'http-client', 'http-server', 'timeout', 'network', 'unknown'] as const
export type TransportReason = typeof TRANSPORT_REASONS[number]
export type TransportState = 'local only' | 'live connecting' | 'private live' | 'live retrying' | 'live unavailable'
// Transport lifecycle events describe the delivery path, not an application failure.
export const TRANSPORT_EVENTS = ['transport.fail', 'transport.recover'] as const
export function isTransportEvent(event: string): boolean {
  return (TRANSPORT_EVENTS as readonly string[]).includes(event)
}
export interface TransportRecord {
  state: TransportState
  lastSuccessAt: number
  consecutiveFailures: number
  reason: TransportReason
  droppedBatches: number
}
export class DiagnosticBuffer {
  private events: DiagnosticEvent[] = []
  add(event: DiagnosticEvent) {
    if (!validateEvent(event)) return false
    this.events.push(Object.freeze({ ...event }))
    this.events = this.events.slice(-BUFFER_LIMIT)
    return true
  }
  snapshot() { return this.events.map(e => ({ ...e })) }
  clear() { this.events = [] }
}
const buffer = new DiagnosticBuffer()
const sessionId = crypto.randomUUID()
const listeners = new Set<() => void>()
let revision = 0
let pending: DiagnosticEvent[] = []
let sending = false
let timer: ReturnType<typeof setTimeout> | undefined
// Truthful transport bookkeeping: last successful send, consecutive failures, fixed reason code.
let state: TransportState = 'live connecting'
let lastSuccessAt = 0
let consecutiveFailures = 0
let reason: TransportReason = 'none'
let batchAttempts = 0
let droppedBatches = 0
let sawSuccess = false
export function transportEnabled() {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) &&
    document.querySelector('meta[name="latte-private-diagnostics"]')?.getAttribute('content') === 'enabled'
}
function enabledState(): TransportState { return transportEnabled() ? state : 'local only' }
function failureState(): TransportState {
  // Sustained failures, or failures with no prior success, mean genuinely not connected.
  if (consecutiveFailures >= 5 || (!sawSuccess && consecutiveFailures >= 2)) return 'live unavailable'
  return 'live retrying'
}
function classifyTransportError(error: unknown): TransportReason {
  // Only the error name/class is used; message and stack are never inspected.
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout'
  if (error instanceof TypeError) return 'network'
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout'
  return 'unknown'
}
function reasonToErrorCode(value: TransportReason): ErrorCode {
  if (value === 'timeout') return 'timeout'
  if (value === 'network') return 'network'
  if (value === 'http-client' || value === 'http-server') return 'http'
  return 'unknown'
}
function notify() { revision++; listeners.forEach(fn => fn()) }
// Transport lifecycle events are edge-triggered, never per-attempt, so they cannot flood retention.
function emitTransport(event: 'transport.fail' | 'transport.recover', errorCode?: ErrorCode) {
  const entry: DiagnosticEvent = {
    timestamp: new Date().toISOString(), sessionId, version: APP_VERSION, event,
    severity: event === 'transport.fail' ? 'error' : 'info',
  }
  if (errorCode) entry.errorCode = errorCode
  if (!buffer.add(entry)) return
  if (transportEnabled()) {
    pending.push(entry)
    pending = pending.slice(-BUFFER_LIMIT)
  }
}
async function flush() {
  timer = undefined
  if (sending || !pending.length) return
  sending = true
  const batch = pending.splice(0, 25)
  let ok = false
  let failure: TransportReason = 'none'
  try {
    const init: RequestInit = {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch), credentials: 'omit', referrerPolicy: 'no-referrer',
    }
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(TRANSPORT_TIMEOUT_MS)
    const response = await fetch('/__latte_diagnostics/events', init)
    ok = response.ok
    if (!ok) failure = response.status >= 500 ? 'http-server' : 'http-client'
  } catch (error) {
    failure = classifyTransportError(error)
  }
  sending = false
  const prior = state
  if (ok) {
    lastSuccessAt = Date.now(); consecutiveFailures = 0; batchAttempts = 0; sawSuccess = true
    state = 'private live'; reason = 'none'
    if (prior === 'live retrying' || prior === 'live unavailable') emitTransport('transport.recover')
  } else {
    consecutiveFailures++
    reason = failure
    state = failureState()
    batchAttempts++
    if (batchAttempts < MAX_BATCH_ATTEMPTS) {
      // Bounded re-queue keeps a transiently failed batch instead of dropping evidence.
      pending = [...batch, ...pending].slice(0, BUFFER_LIMIT)
    } else {
      droppedBatches++; batchAttempts = 0
    }
    if (prior === 'private live' || prior === 'live connecting') emitTransport('transport.fail', reasonToErrorCode(failure))
  }
  notify()
  if (pending.length) {
    const delay = ok ? 200 : RETRY_BACKOFF_MS[Math.min(batchAttempts, RETRY_BACKOFF_MS.length - 1)]
    timer = setTimeout(() => void flush(), delay)
  }
}
export function recordEvent(event: EventName, details: Partial<Pick<DiagnosticEvent, 'page' | 'count' | 'durationMs' | 'zoom' | 'errorCode'>> = {}) {
  const entry: DiagnosticEvent = {
    timestamp: new Date().toISOString(), sessionId, version: APP_VERSION, event,
    severity: /fail$|error$|rejection$/.test(event) ? 'error' : 'info',
  }
  // Pick only numerical values / enum codes. Never spread caller objects.
  for (const key of ['page', 'count', 'durationMs', 'zoom'] as const) {
    const value = details[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9) entry[key] = Math.round(value)
  }
  if (details.errorCode !== undefined) entry.errorCode = details.errorCode
  if (!buffer.add(entry)) return
  if (transportEnabled()) {
    pending.push(entry)
    pending = pending.slice(-BUFFER_LIMIT)
    if (!timer && !sending) timer = setTimeout(() => void flush(), 200)
  }
  notify()
}
export const diagnostics = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
  revision: () => revision,
  snapshot: () => buffer.snapshot(),
  status: (): TransportState => enabledState(),
  transport: (): TransportRecord => ({ state: enabledState(), lastSuccessAt, consecutiveFailures, reason, droppedBatches }),
  clear() { buffer.clear(); pending = []; notify() },
  export() {
    const blob = new Blob([JSON.stringify(buffer.snapshot(), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = url; link.download = 'latte-diagnostics.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  },
}
export function installGlobalDiagnostics() {
  window.addEventListener('error', e => recordEvent('window.error', { errorCode: classifyError(e.error) }))
  window.addEventListener('unhandledrejection', e => recordEvent('window.rejection', { errorCode: classifyError(e.reason) }))
  recordEvent('session.start')
}
