import {useSyncExternalStore} from 'react'
import {diagnostics} from '../diagnostics/diagnostics'
/** Keep technical reports and counters out of the reader, not out of diagnostics. */
export function DiagnosticsStatus(){
 useSyncExternalStore(diagnostics.subscribe,diagnostics.revision)
 const transport=diagnostics.transport()
 const shared=transport.state!=='local only'
 return <details className="diagnostics-panel">
  <summary>Help with problems</summary>
  <div className="diagnostics-controls">
   <p>Reports never include your PDF, text or filename.</p>
   <p>{!shared?'Reports stay in this browser.':transport.state==='live unavailable'?'Reports are not being shared. Save a report instead.':transport.state==='live retrying'?'Could not send the report. Retrying.':transport.state==='live connecting'?'Connecting private test reports…':'Reports are shared for this private test.'}</p>
   <p>Clearing removes reports here, not reports already shared.</p>
   <button className="key-button" onClick={diagnostics.export}>Save problem report</button>
   <button className="delete-button" onClick={diagnostics.clear}>Clear problem reports</button>
  </div>
 </details>
}
