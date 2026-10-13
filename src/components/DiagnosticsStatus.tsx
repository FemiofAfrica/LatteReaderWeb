import { useSyncExternalStore } from 'react'
import { BUFFER_LIMIT, diagnostics, isTransportEvent } from '../diagnostics/diagnostics'

function ago(ms: number): string {
  if (!ms) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.round(seconds / 60)}m ago`
}

export function DiagnosticsStatus() {
  useSyncExternalStore(diagnostics.subscribe, diagnostics.revision)
  const events = diagnostics.snapshot()
  const transport = diagnostics.transport()
  // Only genuine application failures count here. A transport retry is delivery state,
  // shown separately as the strip's transport state, never as an app error.
  const appErrors = events.filter(event => event.severity === 'error' && !isTransportEvent(event.event)).length
  const errorLabel = appErrors === 0 ? 'no errors' : `${appErrors} ${appErrors === 1 ? 'error' : 'errors'}`
  const degraded = transport.consecutiveFailures > 0 && transport.state !== 'local only'
  return <details className="diagnostics-panel">
    <summary>Diagnostics · {transport.state} · {errorLabel}</summary>
    <div className="diagnostics-controls">
      <p>Content-free events only. {events.length}/{BUFFER_LIMIT} in memory · session {events.at(-1)?.sessionId.slice(0, 8) ?? 'none'}.</p>
      {transport.state !== 'local only' && <p>
        Private transport: last send succeeded {ago(transport.lastSuccessAt)}
        {degraded ? ` · ${transport.consecutiveFailures} consecutive failures · reason ${transport.reason}` : ''}
        {transport.droppedBatches ? ` · ${transport.droppedBatches} batches dropped` : ''}.
      </p>}
      <p>Application errors: {errorLabel}. Transport state above is separate and does not count as an application error.</p>
      <p>Messages, filenames, text, URLs and stacks are never recorded. Clear removes this browser buffer, not already delivered private logs.</p>
      <button className="key-button" onClick={diagnostics.export}>Export diagnostics</button>
      <button className="delete-button" onClick={diagnostics.clear}>Clear diagnostics</button>
    </div>
  </details>
}
