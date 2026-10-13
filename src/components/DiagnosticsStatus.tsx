import { useSyncExternalStore } from 'react'
import { BUFFER_LIMIT, diagnostics } from '../diagnostics/diagnostics'
export function DiagnosticsStatus() {
  useSyncExternalStore(diagnostics.subscribe, diagnostics.revision)
  const events = diagnostics.snapshot()
  const errors = events.filter(e => e.severity === 'error').length
  return <details className="diagnostics-panel">
    <summary>Diagnostics · {diagnostics.status()} · {errors ? `${errors} errors` : 'ready'}</summary>
    <div className="diagnostics-controls">
      <p>Content-free events only. {events.length}/{BUFFER_LIMIT} in memory · session {events.at(-1)?.sessionId.slice(0, 8) ?? '—'}.</p>
      <p>Messages, filenames, text, URLs and stacks are never recorded. Clear removes this browser buffer, not already delivered private logs.</p>
      <button className="key-button" onClick={diagnostics.export}>Export diagnostics</button>
      <button className="delete-button" onClick={diagnostics.clear}>Clear diagnostics</button>
    </div>
  </details>
}
