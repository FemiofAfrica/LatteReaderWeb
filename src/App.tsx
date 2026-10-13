import { useEffect, useReducer, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PdfCanvas } from './components/PdfCanvas'
import { analyzeDocument, chunkText, type DocumentVoicePlan } from './domain/analysis'
import {
  clearCurrentDocument,
  loadCurrentDocument,
  updateCurrentDocument,
  validateAndReplaceCurrentDocument,
  type CurrentDocumentRecord,
} from './domain/currentDocumentStore'
import { emptyDocumentState, type DocumentState, type ExtractionMessage } from './domain/document'
import { initialPlaybackState, playbackReducer, type ReadScope } from './domain/playback'
import { BrowserSpeechEngine } from './speech/SpeechEngine'

const formatNumber = new Intl.NumberFormat()
const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function selectionText(): string {
  const selection = window.getSelection()
  const parent = selection?.anchorNode instanceof Element
    ? selection.anchorNode
    : selection?.anchorNode?.parentElement
  return parent?.closest('.page-text') ? selection?.toString().trim() ?? '' : ''
}

function Icon({ name }: { name: 'back' | 'next' | 'stop' | 'play' | 'pause' }) {
  const paths = {
    back: 'M15 18l-6-6 6-6',
    next: 'M9 18l6-6-6-6',
    stop: 'M7 7h10v10H7z',
    play: 'M8 5v14l11-7z',
    pause: 'M7 5h4v14H7zm6 0h4v14h-4z',
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d={paths[name]} /></svg>
}

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const extractionWorkerRef = useRef<Worker | null>(null)
  const speechRef = useRef(new BrowserSpeechEngine())
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [documentState, setDocumentState] = useState<DocumentState | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [zoom, setZoom] = useState(100)
  const [speed, setSpeed] = useState(1)
  const [readScope, setReadScope] = useState<ReadScope>('page')
  const [voicePlan, setVoicePlan] = useState<DocumentVoicePlan | null>(null)
  const [analysisMessage, setAnalysisMessage] = useState('Analyze the extracted text to find character labels and dialogue.')
  const [uploadError, setUploadError] = useState('')
  const [isRestoring, setIsRestoring] = useState(true)
  const [playback, dispatchPlayback] = useReducer(playbackReducer, initialPlaybackState)

  useEffect(() => {
    speechRef.current.onEnd(() => dispatchPlayback({ type: 'END' }))
    return () => speechRef.current.stop()
  }, [])


  useEffect(() => () => {
    extractionWorkerRef.current?.terminate()
  }, [])

  const openPicker = () => fileInputRef.current?.click()

  const activateDocument = async (record: CurrentDocumentRecord, document: PDFDocumentProxy) => {
    speechRef.current.stop()
    dispatchPlayback({ type: 'STOP' })
    extractionWorkerRef.current?.terminate()
    if (pdf) await pdf.cleanup()

    setPdf(document)
    setUploadError('')
    setCurrentPage(Math.min(Math.max(record.reader.currentPage, 1), document.numPages))
    setZoom(record.reader.zoom)
    setSpeed(record.reader.speed)
    setReadScope(record.reader.readScope)
    setVoicePlan(record.voicePlan)
    setAnalysisMessage(record.voicePlan
      ? 'Restored the saved local voice plan for this document.'
      : 'Analyze the extracted text to find character labels and dialogue.')

    const state = emptyDocumentState()
    state.name = record.name
    state.size = record.size
    state.id = record.id
    state.pageCount = document.numPages
    state.pages = Array(document.numPages).fill('')
    state.extraction = 'extracting'
    setDocumentState(state)

    const workerBytes = record.bytes.slice(0)
    const worker = new Worker(new URL('./workers/pdf.worker.ts', import.meta.url), { type: 'module' })
    extractionWorkerRef.current = worker
    worker.onmessage = (event: MessageEvent<ExtractionMessage>) => {
      const message = event.data
      setDocumentState((current) => {
        if (!current || current.id !== record.id) return current
        if (message.type === 'metadata') {
          return { ...current, pageCount: message.pageCount, pages: Array(message.pageCount).fill('') }
        }
        if (message.type === 'page') {
          const pages = [...current.pages]
          pages[message.pageNumber - 1] = message.text
          return {
            ...current,
            pages,
            characterCount: message.characterCount,
            extractedPages: message.pageNumber,
            extraction: 'extracting',
          }
        }
        if (message.type === 'complete') {
          return {
            ...current,
            characterCount: message.characterCount,
            extraction: 'complete',
            scanned: message.scanned,
          }
        }
        return { ...current, extraction: 'error', error: message.message }
      })
      if (message.type === 'complete' || message.type === 'error') worker.terminate()
    }
    worker.onerror = () => {
      setDocumentState((current) => current?.id === record.id ? {
        ...current,
        extraction: 'error',
        error: 'Text extraction stopped unexpectedly. Try opening the PDF again.',
      } : current)
      worker.terminate()
    }
    worker.postMessage({ type: 'extract', bytes: workerBytes }, [workerBytes])
  }

  const loadPdf = async (file: File) => {
    setUploadError('')
    try {
      const bytes = await file.arrayBuffer()
      const record: CurrentDocumentRecord = {
        schemaVersion: 1,
        id: `${file.name}:${file.size}:${file.lastModified}`,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        mimeType: file.type || 'application/pdf',
        bytes,
        reader: { currentPage: 1, zoom, speed, readScope },
        voicePlan: null,
      }
      const document = await validateAndReplaceCurrentDocument(
        record,
        async (validationBytes) => (await import('./pdf/loadPdf')).loadPdf(validationBytes),
      )
      await activateDocument(record, document)
    } catch {
      setUploadError('That file is not a readable PDF. Your current saved document was not changed.')
    }
  }

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      try {
        const record = await loadCurrentDocument()
        if (!record || cancelled) return
        const document = await (await import('./pdf/loadPdf')).loadPdf(record.bytes.slice(0))
        if (!cancelled) await activateDocument(record, document)
      } catch {
        if (!cancelled) setUploadError('The saved PDF could not be restored. You can delete it and open another PDF.')
      } finally {
        if (!cancelled) setIsRestoring(false)
      }
    }
    void restore()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!documentState) return
    const timeout = window.setTimeout(() => {
      void updateCurrentDocument({ reader: { currentPage, zoom, speed, readScope } })
    }, 150)
    return () => window.clearTimeout(timeout)
  }, [currentPage, zoom, speed, readScope, documentState?.id])

  const analyze = () => {
    if (!documentState) return
    const plan = analyzeDocument(documentState.id, documentState.name, documentState.pages)
    setVoicePlan(plan)
    void updateCurrentDocument({ voicePlan: plan })
    const characterCount = Math.max(0, plan.profiles.length - 1)
    setAnalysisMessage(`Found ${characterCount} character ${characterCount === 1 ? 'speaker' : 'speakers'} plus the narrator.`)
  }

  const currentText = documentState?.pages[currentPage - 1] ?? ''
  const extractionPercent = documentState?.pageCount
    ? Math.round((documentState.extractedPages / documentState.pageCount) * 100)
    : 0

  const read = () => {
    if (!documentState || documentState.scanned || !speechRef.current.available) return
    if (playback.status === 'paused') {
      speechRef.current.resume()
      dispatchPlayback({ type: 'RESUME' })
      return
    }
    if (playback.status === 'playing') {
      speechRef.current.pause()
      dispatchPlayback({ type: 'PAUSE' })
      return
    }

    const selected = selectionText()
    const scope = selected ? 'selection' : readScope
    const text = selected || (scope === 'page' ? currentText : documentState.pages.join('\n'))
    if (!text.trim()) return
    const scopedPlan = voicePlan && !selected ? {
      ...voicePlan,
      segments: scope === 'page'
        ? voicePlan.segments.filter((segment) => segment.pageNumber === currentPage)
        : voicePlan.segments,
    } : null
    speechRef.current.speak({ text: chunkText(text).join(' '), rate: speed, plan: scopedPlan })
    dispatchPlayback({ type: 'PLAY', scope })
  }

  const stop = () => {
    speechRef.current.stop()
    dispatchPlayback({ type: 'STOP' })
  }

  const deleteLocalData = async () => {
    speechRef.current.stop()
    extractionWorkerRef.current?.terminate()
    if (pdf) await pdf.cleanup()
    await clearCurrentDocument()
    setPdf(null)
    setDocumentState(null)
    setVoicePlan(null)
    setCurrentPage(1)
    setZoom(100)
    setSpeed(1)
    setReadScope('page')
    setAnalysisMessage('Analyze the extracted text to find character labels and dialogue.')
    setUploadError('Saved PDF, voice plan, settings, and reading position deleted from this browser.')
    dispatchPlayback({ type: 'STOP' })
  }

  const extractionLabel = !documentState ? ''
    : documentState.extraction === 'complete' ? 'Extraction complete'
    : documentState.extraction === 'error' ? 'Extraction error'
    : `Extracting page ${documentState.extractedPages} of ${documentState.pageCount}`

  return (
    <main className="ambient-shell">
      <section className="reader-deck" aria-label="LatteReader PDF console">
        <header className="topbar">
          <div className="brand-lockup">
            <span className="coffee-mark" aria-hidden="true"><span /></span>
            <span><strong>LatteReader</strong><small>Open a PDF · Extract · Listen</small></span>
          </div>
          <div className="topbar-actions">
            {documentState && (
              <div className="document-status" title={documentState.name}>
                <span className={`status-led ${playback.status}`} aria-hidden="true" />
                <span>{playback.status === 'playing' ? 'Reading' : 'Ready'}</span>
                <span className="filename">{documentState.name}</span>
              </div>
            )}
            <button className="primary-button" onClick={openPicker}>{documentState ? 'Replace PDF' : 'Open PDF'}</button>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept="application/pdf,.pdf"
              aria-label="Choose a local PDF"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void loadPdf(file)
                event.target.value = ''
              }}
            />
          </div>
        </header>

        {uploadError && <p className="global-message" role="alert">{uploadError}</p>}

        {!documentState ? (
          <section className="empty-state">
            <span className="coffee-mark large" aria-hidden="true"><span /></span>
            <div>
              <h1>{isRestoring ? 'Checking local reader storage' : 'Choose a PDF to begin'}</h1>
              <p>{isRestoring ? 'Looking for your current PDF in this browser.' : 'Open a text PDF, preview each page, and listen with a voice already available in your browser.'}</p>
            </div>
            <button className="primary-button" onClick={openPicker} disabled={isRestoring}>Open a local PDF</button>
            <p className="privacy-note">Your current PDF is saved only in this browser and restored after reload. Opening another PDF replaces it. Nothing is uploaded.</p>
            {uploadError.includes('could not be restored') && <button className="delete-button compact-delete" onClick={() => void deleteLocalData()}>Clear saved reader data</button>}
          </section>
        ) : (
          <>
            <div className="workspace">
              <aside className="control-rail" aria-label="Document controls">
                <section className="bezel">
                  <h2>Document</h2>
                  <div className="document-metrics">
                    <span><small>Pages</small><strong>{documentState.pageCount || '...'}</strong></span>
                    <span><small>Characters</small><strong>{formatNumber.format(documentState.characterCount)}</strong></span>
                  </div>
                  <div className="lcd-panel">
                    <div className="page-stepper">
                      <button aria-label="Previous page" disabled={currentPage <= 1} onClick={() => setCurrentPage((page) => page - 1)}><Icon name="back" /></button>
                      <output aria-label="Current page"><strong>{currentPage}</strong><span>/</span>{documentState.pageCount}</output>
                      <button aria-label="Next page" disabled={currentPage >= documentState.pageCount} onClick={() => setCurrentPage((page) => page + 1)}><Icon name="next" /></button>
                    </div>
                    <progress aria-label="Document page progress" value={currentPage} max={documentState.pageCount || 1} />
                    <label className="page-jump">Go to page
                      <input
                        type="number"
                        min="1"
                        max={documentState.pageCount}
                        value={currentPage}
                        onChange={(event) => setCurrentPage(Math.min(documentState.pageCount, Math.max(1, Number(event.target.value))))}
                      />
                    </label>
                  </div>
                  <div className="file-facts"><span>{formatBytes(documentState.size)}</span><span>{extractionLabel}</span></div>
                  {documentState.extraction === 'extracting' && <progress aria-label="Text extraction progress" value={extractionPercent} max="100" />}
                  {documentState.error && <p className="error-copy">{documentState.error}</p>}
                  {documentState.scanned && <p className="warning-copy"><strong>OCR required.</strong> This PDF appears to contain images without readable text. OCR is not included in this version.</p>}
                  <p className="panel-copy">One current PDF is stored in this browser with its voice plan, settings, and page position. Replacing it removes the previous document data.</p>
                  <button className="delete-button" onClick={() => {
                    if (window.confirm('Delete the current PDF and all saved reader data from this browser?')) void deleteLocalData()
                  }}>Delete local data</button>
                </section>

                <section className="bezel">
                  <h2>Read</h2>
                  <fieldset className="segmented-control">
                    <legend>Reading scope</legend>
                    {(['page', 'document'] as ReadScope[]).map((scope) => (
                      <label key={scope}><input type="radio" name="scope" checked={readScope === scope} onChange={() => setReadScope(scope)} /><span>{scope === 'page' ? 'Page' : 'Full'}</span></label>
                    ))}
                  </fieldset>
                  <p className="panel-copy">Select text in the page transcript to read only that selection.</p>
                </section>

                <section className="bezel">
                  <h2>Voice engine</h2>
                  <div className="engine-readout"><span className="status-led ready" aria-hidden="true" /><strong>Browser voice</strong></div>
                  <p className="panel-copy">Uses SpeechSynthesis with voices installed in this browser. No Kokoro model is active yet.</p>
                </section>

                <section className="bezel">
                  <h2>Character voices</h2>
                  <button className="key-button" onClick={analyze} disabled={!documentState.characterCount}>Analyze Characters</button>
                  <p className="panel-copy" aria-live="polite">{analysisMessage}</p>
                  {voicePlan && (
                    <div className="speaker-list" aria-label="Detected speakers">
                      <p><strong>{voicePlan.profiles.length}</strong> voices · <strong>{voicePlan.segments.length}</strong> segments</p>
                      <ul>{voicePlan.profiles.map((profile) => <li key={profile.id}><span className={profile.id === 'narrator' ? 'narrator-dot' : ''} /><strong>{profile.displayName}</strong><small>{Math.round(profile.confidence * 100)}%</small></li>)}</ul>
                    </div>
                  )}
                </section>
              </aside>

              <section className="preview" aria-label="PDF preview">
                <header className="preview-header"><span><strong>Preview</strong> Page {currentPage}</span><span className="zoom-readout">{zoom}% zoom</span></header>
                <div className="preview-scroll">
                  {pdf ? <PdfCanvas document={pdf} pageNumber={currentPage} zoom={zoom} /> : <p>Loading preview...</p>}
                  <section className="page-text" aria-label={`Selectable text from page ${currentPage}`} tabIndex={0}>
                    <h2>Selectable page text</h2>
                    <p>{currentText || (documentState.extraction === 'complete' ? 'No readable text was found on this page.' : 'Extracting text...')}</p>
                  </section>
                </div>
              </section>
            </div>

            <footer className="transport" aria-label="Speech playback controls">
              <div className="transport-buttons">
                <button aria-label="Stop reading" onClick={stop} disabled={playback.status === 'ready'}><Icon name="stop" /></button>
                <button className="play-button" aria-label={playback.status === 'playing' ? 'Pause reading' : playback.status === 'paused' ? 'Resume reading' : 'Start reading'} onClick={read} disabled={!documentState.characterCount || documentState.scanned || !speechRef.current.available}><Icon name={playback.status === 'playing' ? 'pause' : 'play'} /></button>
              </div>
              <div className="waveform" data-playing={playback.status === 'playing'} aria-hidden="true">{Array.from({ length: 32 }, (_, index) => <i key={index} style={{ height: `${8 + ((index * 17) % 25)}px` }} />)}</div>
              <div className="playback-readout" aria-live="polite"><strong>{playback.status}</strong><span>{playback.message}</span></div>
              <label className="dial-control">Speed <output>{speed.toFixed(2)}x</output><input aria-label="Reading speed" type="range" min="0.5" max="2" step="0.05" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></label>
              <label className="dial-control">Zoom <output>{zoom}%</output><input aria-label="Preview zoom" type="range" min="50" max="180" step="10" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
            </footer>
          </>
        )}
        <div className="visually-hidden" role="status" aria-live="polite">{documentState ? `${extractionLabel}. ${playback.message}.` : 'No PDF open.'}</div>
      </section>
    </main>
  )
}

export default App
