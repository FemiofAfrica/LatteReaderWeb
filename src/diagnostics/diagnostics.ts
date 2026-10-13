import { APP_VERSION, classifyError, validateEvent, type DiagnosticEvent, type EventName } from './schema'
export const BUFFER_LIMIT = 250
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
let transportState = 'local only'
export function transportEnabled() {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) &&
    document.querySelector('meta[name="latte-private-diagnostics"]')?.getAttribute('content') === 'enabled'
}
function notify() { revision++; listeners.forEach(fn => fn()) }
async function flush() {
  timer = undefined
  if (sending || !pending.length) return
  sending = true
  const batch = pending.splice(0, 25)
  try {
    const response = await fetch('/__latte_diagnostics/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch), credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(3000),
    })
    transportState = response.ok ? 'private live' : 'live unavailable'
  } catch { transportState = 'live unavailable' }
  finally {
    sending = false
    notify()
    if (pending.length) timer = setTimeout(() => void flush(), 200)
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
  status: () => transportEnabled() ? transportState === 'local only' ? 'live connecting' : transportState : 'local only',
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
