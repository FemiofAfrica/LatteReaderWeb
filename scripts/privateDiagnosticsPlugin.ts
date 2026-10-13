import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateEvent, type DiagnosticEvent } from '../src/diagnostics/schema'
export const SERVER_LIMIT = 1000
// Per-page progress may never evict lifecycle/failure history: progress is capped well below
// the whole-file limit, and trimming drops the oldest progress lines first.
export const PROGRESS_LIMIT = 200
export const REQUEST_LIMIT = 16384
export const REJECTION_LIMIT = 500
// Fixed, content-free reason codes. Never a payload, URL, header value or document field.
export const REJECTION_REASONS = [
  'not-loopback', 'bad-host', 'method', 'origin', 'content-type', 'too-large', 'bad-json', 'invalid-batch', 'client-abort',
] as const
export type RejectionReason = typeof REJECTION_REASONS[number]
export interface IngestNote { timestamp: string; status: number | null; reason: RejectionReason }
const marker = '<meta name="latte-private-diagnostics" content="enabled">'
// Preview URLs carry tester query strings (`/?build=<sha>`), so match the request
// path only. Absolute-form request targets are deliberately not treated as the
// document request; only an origin-form index path receives the marker.
export function isIndexDocumentRequest(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0].split('#')[0]
  return path === '/' || path === '/index.html'
}
// A retried batch must not be stored twice. Two events are the same event only when every
// allowlisted field matches, including the millisecond timestamp, so a resent batch collapses
// onto the copy that already landed. The key is derived in memory for the comparison only and
// is never written: no payload, filename, document or error text enters it.
function eventKey(event: DiagnosticEvent): string {
  return [event.sessionId, event.event, event.timestamp, event.severity,
    event.errorCode ?? '', event.page ?? '', event.count ?? '', event.durationMs ?? '', event.zoom ?? ''].join('|')
}
export function dropAlreadyStored(stored: DiagnosticEvent[], incoming: DiagnosticEvent[]): DiagnosticEvent[] {
  const seen = new Set(stored.map(eventKey))
  const fresh: DiagnosticEvent[] = []
  for (const event of incoming) {
    const key = eventKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(event)
  }
  return fresh
}
// Keep every lifecycle/failure event; bound extraction.progress first so a single
// full-document extraction cannot evict meaningful session history.
export function trimEvents(events: DiagnosticEvent[], limit = SERVER_LIMIT, progressLimit = PROGRESS_LIMIT): DiagnosticEvent[] {
  let kept = events
  const progress = kept.reduce((count, event) => count + (event.event === 'extraction.progress' ? 1 : 0), 0)
  if (progress > progressLimit) {
    let toDrop = progress - progressLimit
    kept = kept.filter(event => {
      if (toDrop > 0 && event.event === 'extraction.progress') { toDrop--; return false }
      return true
    })
  }
  return kept.length > limit ? kept.slice(-limit) : kept
}
export function privateDiagnosticsPlugin(enabled: boolean): Plugin {
  const root = process.cwd()
  const log = resolve(root, '.runtime/diagnostics/events.jsonl')
  const rejectionsLog = resolve(root, '.runtime/diagnostics/ingest-rejections.jsonl')
  let entries: DiagnosticEvent[] | undefined
  let notes: IngestNote[] | undefined
  function loadNotes(): IngestNote[] {
    if (notes) return notes
    notes = existsSync(rejectionsLog) ? readFileSync(rejectionsLog, 'utf8').split('\n').filter(Boolean).slice(-REJECTION_LIMIT).flatMap(line => {
      try {
        const note: unknown = JSON.parse(line)
        const v = note as Record<string, unknown>
        return v && typeof v === 'object' && REJECTION_REASONS.includes(v.reason as RejectionReason) && (v.status === null || typeof v.status === 'number') ? [note as IngestNote] : []
      } catch { return [] }
    }) : []
    return notes
  }
  function noteIngest(reason: RejectionReason, status: number | null) {
    try {
      const next = [...loadNotes(), { timestamp: new Date().toISOString(), status, reason }].slice(-REJECTION_LIMIT)
      mkdirSync(resolve(root, '.runtime/diagnostics'), { recursive: true })
      writeFileSync(`${rejectionsLog}.tmp`, next.map(note => JSON.stringify(note)).join('\n') + '\n')
      renameSync(`${rejectionsLog}.tmp`, rejectionsLog)
      notes = next
    } catch { /* diagnostics must never break ingestion */ }
  }
  function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (!enabled) return next()
    const address = req.socket.localAddress
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')) { noteIngest('not-loopback', 403); res.statusCode = 403; res.end(); return }
    const host = req.headers.host ?? ''
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) { noteIngest('bad-host', 403); res.statusCode = 403; res.end(); return }
    if (req.url !== '/__latte_diagnostics/events') return next()
    res.setHeader('Cache-Control', 'no-store')
    const origin = req.headers.origin
    if (req.method !== 'POST') { noteIngest('method', 403); res.statusCode = 403; res.end(); return }
    if (origin !== `http://${host}`) { noteIngest('origin', 403); res.statusCode = 403; res.end(); return }
    if (req.headers['content-type'] !== 'application/json') { noteIngest('content-type', 403); res.statusCode = 403; res.end(); return }
    let settled = false
    const finish = (status: number) => { settled = true; res.statusCode = status; res.end() }
    // A client that aborts mid-body is the signature of an intermittent network failure.
    req.on('close', () => { if (!settled && !req.complete) noteIngest('client-abort', null) })
    req.on('error', () => { /* a dropped connection is expected; close records it */ })
    if (Number(req.headers['content-length']) > REQUEST_LIMIT) { noteIngest('too-large', 413); finish(413); req.resume(); return }
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= REQUEST_LIMIT) chunks.push(chunk)
      else if (!res.writableEnded) { noteIngest('too-large', 413); finish(413) }
    })
    req.on('end', () => {
      if (res.writableEnded) return
      try {
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!Array.isArray(payload) || !payload.length || payload.length > 25 || !payload.every(validateEvent)) {
          noteIngest('invalid-batch', 400); finish(400); return
        }
        if (!entries) {
          entries = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(-SERVER_LIMIT).flatMap(line => {
            try { const event: unknown = JSON.parse(line); return validateEvent(event) ? [event] : [] } catch { return [] }
          }) : []
        }
        const fresh = dropAlreadyStored(entries, payload)
        // A batch that already landed is acknowledged, not stored again.
        if (!fresh.length) { finish(204); return }
        const retained = trimEvents([...entries, ...fresh])
        mkdirSync(resolve(root, '.runtime/diagnostics'), { recursive: true })
        writeFileSync(`${log}.tmp`, retained.map(e => JSON.stringify(e)).join('\n') + '\n')
        renameSync(`${log}.tmp`, log)
        entries = retained
        finish(204)
      } catch { noteIngest('bad-json', 400); finish(400) }
    })
  }
  return {
    name: 'latte-private-diagnostics',
    apply: 'serve',
    configResolved(config) {
      if (enabled && (![config.server.host, config.preview.host].every(host =>
        host === '127.0.0.1' || host === 'localhost' || host === '::1'))) {
        throw new Error('Private diagnostics requires loopback hosts.')
      }
    },
    transformIndexHtml(html) { return enabled ? html.replace('</head>', `${marker}</head>`) : html },
    configureServer(server) { server.middlewares.use(middleware) },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
      server.middlewares.use((req, res, next) => {
        if (!enabled || !isIndexDocumentRequest(req.url)) return next()
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.localAddress ?? '')) { res.statusCode = 403; res.end(); return }
        res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store')
        res.end(readFileSync(resolve(root, 'dist/index.html'), 'utf8').replace('</head>', `${marker}</head>`))
      })
    },
  }
}
