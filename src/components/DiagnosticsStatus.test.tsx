import {render,screen,cleanup} from '@testing-library/react'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {DiagnosticsStatus} from './DiagnosticsStatus'
import {diagnostics,type TransportState} from '../diagnostics/diagnostics'
afterEach(()=>{cleanup();vi.restoreAllMocks()})
describe('plain problem reports',()=>{
 for(const [state,copy] of Object.entries({'local only':'Reports stay in this browser.','live connecting':'Connecting private test reports…','private live':'Reports are shared for this private test.','live retrying':'Could not send the report. Retrying.','live unavailable':'Reports are not being shared. Save a report instead.'})){
  it(`preserves the meaning of ${state} without telemetry`,()=>{
   vi.spyOn(diagnostics,'transport').mockReturnValue({state:state as TransportState,lastSuccessAt:0,consecutiveFailures:state==='local only'?0:5,reason:'network',droppedBatches:1});render(<DiagnosticsStatus/>);
   expect(screen.getByText(copy)).toBeInTheDocument();expect(screen.getByText('Reports never include your PDF, text or filename.')).toBeInTheDocument();expect(screen.getByText('Clearing removes reports here, not reports already shared.')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Save problem report',hidden:true})).toBeInTheDocument();expect(screen.getByRole('button',{name:'Clear problem reports',hidden:true})).toBeInTheDocument();expect(document.body.textContent).not.toMatch(/session|buffer|transport|diagnostic|reason code|in memory/i)
  })
 }
})
