import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateEvent, type DiagnosticEvent } from '../src/diagnostics/schema'
export const SERVER_LIMIT = 1000
export const REQUEST_LIMIT = 16384
const marker = '<meta name="latte-private-diagnostics" content="enabled">'
// Preview URLs carry tester query strings (`/?build=<sha>`), so match the request
// path only. Absolute-form request targets are deliberately not treated as the
// document request; only an origin-form index path receives the marker.
export function isIndexDocumentRequest(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0].split('#')[0]
  return path === '/' || path === '/index.html'
}
export function privateDiagnosticsPlugin(enabled: boolean): Plugin {
  const root = process.cwd()
  const log = resolve(root, '.runtime/diagnostics/events.jsonl')
  let entries: DiagnosticEvent[] | undefined
  function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (!enabled) return next()
    const address = req.socket.localAddress
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')) { res.statusCode = 403; res.end(); return }
    const host = req.headers.host ?? ''
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) { res.statusCode = 403; res.end(); return }
    if (req.url !== '/__latte_diagnostics/events') return next()
    res.setHeader('Cache-Control', 'no-store')
    const origin = req.headers.origin
    if (req.method !== 'POST' || origin !== `http://${host}` || req.headers['content-type'] !== 'application/json') {
      res.statusCode = 403; res.end(); return
    }
    if (Number(req.headers['content-length']) > REQUEST_LIMIT) { res.statusCode = 413; res.end(); req.resume(); return }
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= REQUEST_LIMIT) chunks.push(chunk)
      else if (!res.writableEnded) { res.statusCode = 413; res.end() }
    })
    req.on('end', () => {
      if (res.writableEnded) return
      try {
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!Array.isArray(payload) || !payload.length || payload.length > 25 || !payload.every(validateEvent)) {
          res.statusCode = 400; res.end(); return
        }
        if (!entries) {
          entries = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(-SERVER_LIMIT).flatMap(line => {
            try { const event: unknown = JSON.parse(line); return validateEvent(event) ? [event] : [] } catch { return [] }
          }) : []
        }
        const retained = [...entries, ...payload].slice(-SERVER_LIMIT)
        mkdirSync(resolve(root, '.runtime/diagnostics'), { recursive: true })
        writeFileSync(`${log}.tmp`, retained.map(e => JSON.stringify(e)).join('\n') + '\n')
        renameSync(`${log}.tmp`, log)
        entries = retained
        res.statusCode = 204; res.end()
      } catch { res.statusCode = 400; res.end() }
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
