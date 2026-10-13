import { useEffect, useReducer, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PdfCanvas } from './components/PdfCanvas'
import { analyzeDocument, chunkText, type DocumentVoicePlan } from './domain/analysis'
import {
  clearCurrentDocument,
  CURRENT_SCHEMA_VERSION,
  loadCurrentDocument,
  updateCurrentDocument,
  validateAndReplaceCurrentDocument,
  type CurrentDocumentRecord,
} from './domain/currentDocumentStore'
import { emptyDocumentState, type DocumentState, type ExtractionMessage } from './domain/document'
import { computeFitZoom, MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM } from './domain/fit'
import {
  advancePage,
  buildReadingSteps,
  hasReadableText,
  initialPlaybackState,
  playbackReducer,
  type PlaybackState,
  type ReadScope,
} from './domain/playback'
import { BrowserSpeechEngine } from './speech/SpeechEngine'
import { recordEvent } from './diagnostics/diagnostics'
import { shouldRecordProgress } from './diagnostics/progress'
import { DiagnosticsStatus } from './components/DiagnosticsStatus'

const formatNumber = new Intl.NumberFormat()
const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

// Single breakpoint shared by the mobile bar's CSS and this component's media query.
const MOBILE_QUERY = '(max-width: 780px)'
// Bounded wait for the next page's text while extraction is still running, so reading
// continues as text arrives instead of failing.
const PENDING_TEXT_TIMEOUT_MS = 15000
const PENDING_TEXT_POLL_MS = 250

type MobilePanel = 'document' | 'read' | 'voices' | 'preview'

const MOBILE_PANELS: { id: MobilePanel; label: string; paths: string[] }[] = [
  { id: 'document', label: 'Document', paths: ['M7 3h7l5 5v13H7z', 'M14 3v5h5'] },
  { id: 'read', label: 'Read', paths: ['M4 5h7v14H4z', 'M13 5h7v14h-7z'] },
  { id: 'voices', label: 'Voices', paths: ['M12 3a3.5 3.5 0 013.5 3.5v4a3.5 3.5 0 01-7 0v-4A3.5 3.5 0 0112 3z', 'M5.5 11a6.5 6.5 0 0013 0'] },
  { id: 'preview', label: 'Preview', paths: ['M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z', 'M12 14.5A2.5 2.5 0 1112 9.5a2.5 2.5 0 010 5z'] },
]

function selectionText(): string {
  const selection = window.getSelection()
  const parent = selection?.anchorNode instanceof Element
    ? selection.anchorNode
    : selection?.anchorNode?.parentElement
  return parent?.closest('.page-text') ? selection?.toString().trim() ?? '' : ''
}

function useMediaQuery(query: string): boolean {
  const read = () => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches
  const [matches, setMatches] = useState(read)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const update = () => setMatches(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return matches
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

function PanelIcon({ paths }: { paths: string[] }) {
  return <svg className="panel-icon" aria-hidden="true" viewBox="0 0 24 24">{paths.map((d) => <path key={d} d={d} />)}</svg>
}

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const extractionWorkerRef = useRef<Worker | null>(null)
  const speechRef = useRef(new BrowserSpeechEngine())
  const mobileBarRef = useRef<HTMLElement>(null)
  const topbarRef = useRef<HTMLElement>(null)
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const waitTimerRef = useRef<number | null>(null)
  const endHandlerRef = useRef<() => void>(() => undefined)
  const runRef = useRef({ pages: 0, started: 0 })
  // The page currently being read, written synchronously so a page that finishes before the
  // next render still advances correctly.
  const readingPageRef = useRef(0)
  const isMobile = useMediaQuery(MOBILE_QUERY)

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [documentState, setDocumentState] = useState<DocumentState | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  // `zoom` is the reader's stored zoom setting. On mobile the preview opens at a fit-to-width
  // value held separately in `fitZoom`, so the fit is a view value that never overwrites the
  // saved setting. `manualZoom` marks a zoom the reader set by hand, which is never re-fitted.
  const [zoom, setZoom] = useState(100)
  const [fitZoom, setFitZoom] = useState<number | null>(null)
  const [manualZoom, setManualZoom] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [readScope, setReadScope] = useState<ReadScope>('document')
  const [voicePlan, setVoicePlan] = useState<DocumentVoicePlan | null>(null)
  const [analysisMessage, setAnalysisMessage] = useState('Analyze the extracted text to find character labels and dialogue.')
  const [uploadError, setUploadError] = useState('')
  const [isRestoring, setIsRestoring] = useState(true)
  const [activePanel, setActivePanel] = useState<MobilePanel>('preview')
  const [playback, dispatchPlayback] = useReducer(playbackReducer, initialPlaybackState)

  // Latest values, read by the speech callback that is registered only once.
  const playbackRef = useRef<PlaybackState>(playback)
  playbackRef.current = playback
  const documentRef = useRef<DocumentState | null>(documentState)
  documentRef.current = documentState
  const speedRef = useRef(speed)
  speedRef.current = speed
  const voicePlanRef = useRef<DocumentVoicePlan | null>(voicePlan)
  voicePlanRef.current = voicePlan
  const currentPageRef = useRef(currentPage)
  currentPageRef.current = currentPage

  const clearWait = () => {
    if (waitTimerRef.current !== null) { window.clearTimeout(waitTimerRef.current); waitTimerRef.current = null }
  }

  // Read one page aloud. The preview and the persisted position both follow this page.
  const speakPage = (pageNumber: number) => {
    const document = documentRef.current
    const text = document?.pages[pageNumber - 1] ?? ''
    if (!document || !hasReadableText(text)) return
    const plan = voicePlanRef.current
    const scopedPlan = plan ? { ...plan, segments: plan.segments.filter((segment) => segment.pageNumber === pageNumber) } : null
    if (runRef.current.pages === 0) runRef.current.started = performance.now()
    runRef.current.pages += 1
    readingPageRef.current = pageNumber
    setCurrentPage(pageNumber)
    speechRef.current.speak({ text: chunkText(text).join(' '), rate: speedRef.current, plan: scopedPlan })
  }

  const completeRun = () => {
    const pages = runRef.current.pages
    if (pages > 1) recordEvent('playback.complete', { count: pages, durationMs: performance.now() - runRef.current.started })
    runRef.current = { pages: 0, started: 0 }
    readingPageRef.current = 0
    dispatchPlayback({ type: 'END' })
  }

  const hasPendingPages = (document: DocumentState, afterPage: number) => {
    for (let page = afterPage + 1; page <= document.pageCount; page += 1) {
      if (page > document.extractedPages) return true
    }
    return false
  }

  const waitForPendingText = () => {
    const started = performance.now()
    const tick = () => {
      const state = playbackRef.current
      const document = documentRef.current
      if (state.status !== 'playing' || !document) return
      const next = advancePage(document.pages, state, readingPageRef.current)
      if (next !== null) {
        dispatchPlayback({ type: 'ADVANCE', page: next, totalPages: document.pageCount })
        speakPage(next)
        return
      }
      if (document.extraction === 'complete' || performance.now() - started > PENDING_TEXT_TIMEOUT_MS) { completeRun(); return }
      waitTimerRef.current = window.setTimeout(tick, PENDING_TEXT_POLL_MS)
    }
    waitTimerRef.current = window.setTimeout(tick, PENDING_TEXT_POLL_MS)
  }

  // Called when the engine finishes the current page's utterance.
  const handleSpeechEnd = () => {
    const state = playbackRef.current
    const document = documentRef.current
    const currentPage = readingPageRef.current
    if (state.status !== 'playing') return
    if (state.scope !== 'document' || !document) { completeRun(); return }
    const next = advancePage(document.pages, state, currentPage)
    if (next !== null) {
      dispatchPlayback({ type: 'ADVANCE', page: next, totalPages: document.pageCount })
      speakPage(next)
      return
    }
    if (document.extraction !== 'complete' && hasPendingPages(document, currentPage)) {
      waitForPendingText()
      return
    }
    completeRun()
  }
  endHandlerRef.current = handleSpeechEnd

  useEffect(() => {
    speechRef.current.onEnd(() => endHandlerRef.current())
    return () => {
      clearWait()
      speechRef.current.stop()
    }
  }, [])

  useEffect(() => () => {
    extractionWorkerRef.current?.terminate()
  }, [])

  useEffect(() => {
    if (!isMobile) {
      document.documentElement.style.removeProperty('--mobile-bar-height')
      return
    }
    const node = mobileBarRef.current
    if (!node) return
    const apply = () => document.documentElement.style.setProperty('--mobile-bar-height', `${Math.ceil(node.getBoundingClientRect().height)}px`)
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(apply)
    observer.observe(node)
    return () => observer.disconnect()
    // Re-runs once the bar actually mounts, which happens with the first document.
  }, [isMobile, Boolean(documentState)])

  // The pinned preview header sits directly beneath the top bar, so it is offset by the bar's
  // real measured height rather than a guess: the bar can wrap or gain the filename row, and
  // the two must stay flush without a gap or an overlap. Follows the bottom bar's pattern.
  useEffect(() => {
    if (!isMobile) {
      document.documentElement.style.removeProperty('--mobile-topbar-height')
      return
    }
    const node = topbarRef.current
    if (!node) return
    const apply = () => document.documentElement.style.setProperty('--mobile-topbar-height', `${Math.ceil(node.getBoundingClientRect().height)}px`)
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(apply)
    observer.observe(node)
    return () => observer.disconnect()
  }, [isMobile, Boolean(documentState)])

  // Mobile opens the preview at a fit-to-width zoom so a whole line of text is readable
  // without sideways scrolling. The value is recomputed whenever the container changes
  // (rotation, resize, switching to the Preview panel) but never once the reader has set a
  // zoom by hand: that override stays for the rest of the session.
  useEffect(() => {
    if (!isMobile || manualZoom || !pdf) return
    const node = previewScrollRef.current
    if (!node) return
    let cancelled = false
    let observer: ResizeObserver | undefined

    const apply = async () => {
      const scroller = previewScrollRef.current
      if (!scroller) return
      const page = await pdf.getPage(currentPage)
      if (cancelled) return
      const style = window.getComputedStyle(scroller)
      const available = scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const nativeWidth = page.getViewport({ scale: 1 }).width
      if (available <= 0 || nativeWidth <= 0) return
      setFitZoom(computeFitZoom(available, nativeWidth))
    }

    void apply()
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => { void apply() })
      observer.observe(node)
    }
    return () => { cancelled = true; observer?.disconnect() }
  }, [isMobile, manualZoom, pdf, currentPage, activePanel])

  const openPicker = () => fileInputRef.current?.click()

  const activateDocument = async (record: CurrentDocumentRecord, document: PDFDocumentProxy) => {
    clearWait()
    runRef.current = { pages: 0, started: 0 }
    readingPageRef.current = 0
    speechRef.current.stop()
    dispatchPlayback({ type: 'STOP' })
    extractionWorkerRef.current?.terminate()
    if (pdf) await pdf.cleanup()

    setPdf(document)
    setUploadError('')
    setCurrentPage(Math.min(Math.max(record.reader.currentPage, 1), document.numPages))
    setZoom(record.reader.zoom)
    // A newly opened document starts from the stored setting again, so the mobile fit applies.
    setFitZoom(null)
    setManualZoom(false)
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

    const extractionStart = performance.now()
    recordEvent('extraction.start', { count: document.numPages })
    try {
      const workerBytes = record.bytes.slice(0)
      const progressTrack = { lastPage: 0 }
      const worker = new Worker(new URL('./workers/pdf.worker.ts', import.meta.url), { type: 'module' })
      extractionWorkerRef.current = worker
      worker.onmessage = (event: MessageEvent<ExtractionMessage>) => {
        const message = event.data
        // Coalesce per-page progress: first page, final page and evenly spaced samples only.
        if (message.type === 'page' && shouldRecordProgress(message.pageNumber, document.numPages, progressTrack)) {
          progressTrack.lastPage = message.pageNumber
          recordEvent('extraction.progress', { page: message.pageNumber })
        }
        if (message.type === 'complete') recordEvent('extraction.complete', { count: document.numPages, durationMs: performance.now() - extractionStart })
        if (message.type === 'error') recordEvent('extraction.fail', { errorCode: 'worker', durationMs: performance.now() - extractionStart })
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
        recordEvent('extraction.fail', { errorCode: 'worker', durationMs: performance.now() - extractionStart })
        setDocumentState((current) => current?.id === record.id ? {
          ...current,
          extraction: 'error',
          error: 'Text extraction stopped unexpectedly. Try opening the PDF again.',
        } : current)
        worker.terminate()
      }
      worker.postMessage({ type: 'extract', bytes: workerBytes }, [workerBytes])
    } catch {
      recordEvent('extraction.fail', { errorCode: 'worker', durationMs: performance.now() - extractionStart })
      setDocumentState(current => current ? { ...current, extraction: 'error', error: 'Text extraction could not start. Try opening the PDF again.' } : current)
    }
  }

  const loadPdf = async (file: File) => {
    const started = performance.now()
    recordEvent('upload.start')
    setUploadError('')
    try {
      const bytes = await file.arrayBuffer()
      const record: CurrentDocumentRecord = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
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
      recordEvent('upload.validated', { count: document.numPages })
      recordEvent('upload.replaced', { count: document.numPages, durationMs: performance.now() - started })
      await activateDocument(record, document)
    } catch {
      recordEvent('upload.fail', { errorCode: 'pdf', durationMs: performance.now() - started })
      setUploadError('That file is not a readable PDF. Your current saved document was not changed.')
    }
  }

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      const started = performance.now()
      recordEvent('restore.start')
      try {
        const record = await loadCurrentDocument()
        if (cancelled) return
        if (!record) { recordEvent('restore.empty'); return }
        const document = await (await import('./pdf/loadPdf')).loadPdf(record.bytes.slice(0))
        if (!cancelled) {
          await activateDocument(record, document)
          recordEvent('restore.complete', { count: document.numPages, durationMs: performance.now() - started })
        }
      } catch {
        recordEvent('restore.fail', { errorCode: 'storage', durationMs: performance.now() - started })
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
    const started = performance.now()
    recordEvent('analysis.start', { count: documentState.pageCount })
    try {
      const plan = analyzeDocument(documentState.id, documentState.name, documentState.pages)
      setVoicePlan(plan)
      void updateCurrentDocument({ voicePlan: plan })
      const characterCount = Math.max(0, plan.profiles.length - 1)
      setAnalysisMessage(`Found ${characterCount} character ${characterCount === 1 ? 'speaker' : 'speakers'} plus the narrator.`)
      recordEvent('analysis.complete', { count: plan.profiles.length, durationMs: performance.now() - started })
    } catch {
      recordEvent('analysis.fail', { durationMs: performance.now() - started })
      setAnalysisMessage('Character analysis failed. Try again.')
    }
  }

  const currentText = documentState?.pages[currentPage - 1] ?? ''
  const extractionPercent = documentState?.pageCount
    ? Math.round((documentState.extractedPages / documentState.pageCount) * 100)
    : 0
  // What is actually rendered: the mobile fit while it is active, otherwise the stored setting.
  const renderZoom = isMobile && !manualZoom && fitZoom !== null ? fitZoom : zoom

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

    clearWait()
    runRef.current = { pages: 0, started: performance.now() }

    // Selection reading keeps its own path and reads only the selection.
    const selected = selectionText()
    if (selected) {
      speechRef.current.speak({ text: chunkText(selected).join(' '), rate: speedRef.current, plan: null })
      runRef.current.pages = 1
      readingPageRef.current = currentPage
      dispatchPlayback({ type: 'PLAY', scope: 'selection', page: currentPage })
      return
    }

    const steps = buildReadingSteps(documentState.pages, currentPage, readScope)
    const first = steps[0]
    if (!first) return
    dispatchPlayback({ type: 'PLAY', scope: readScope, page: first.pageNumber })
    speakPage(first.pageNumber)
  }

  const stop = () => {
    clearWait()
    runRef.current = { pages: 0, started: 0 }
    readingPageRef.current = 0
    speechRef.current.stop()
    dispatchPlayback({ type: 'STOP' })
  }

  const deleteLocalData = async () => {
    recordEvent('delete.start')
    try {
      clearWait()
      runRef.current = { pages: 0, started: 0 }
      readingPageRef.current = 0
      speechRef.current.stop()
      extractionWorkerRef.current?.terminate()
      if (pdf) await pdf.cleanup()
      await clearCurrentDocument()
      setPdf(null)
      setDocumentState(null)
      setVoicePlan(null)
      setCurrentPage(1)
      setZoom(100)
      setFitZoom(null)
      setManualZoom(false)
      setSpeed(1)
      setReadScope('document')
      setAnalysisMessage('Analyze the extracted text to find character labels and dialogue.')
      setUploadError('Saved PDF, voice plan, settings, and reading position deleted from this browser.')
      dispatchPlayback({ type: 'STOP' })
      recordEvent('delete.complete')
    } catch {
      recordEvent('delete.fail', { errorCode: 'storage' })
      setUploadError('Local data could not be deleted. Try again.')
    }
  }

  const extractionLabel = !documentState ? ''
    : documentState.extraction === 'complete' ? 'Extraction complete'
    : documentState.extraction === 'error' ? 'Extraction error'
    : `Extracting page ${documentState.extractedPages} of ${documentState.pageCount}`

  const playLabel = playback.status === 'playing' ? 'Pause reading' : playback.status === 'paused' ? 'Resume reading' : 'Start reading'

  return (
    <main className="ambient-shell">
      <section className="reader-deck" data-panel={activePanel} aria-label="LatteReader PDF console">
        <header className="topbar" ref={topbarRef}>
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
            <p className="privacy-note">Your current PDF is saved only in this browser and restored after reload. Opening another PDF replaces it. PDF content is never uploaded.</p>
            {uploadError.includes('could not be restored') && <button className="delete-button compact-delete" onClick={() => void deleteLocalData()}>Clear saved reader data</button>}
          </section>
        ) : (
          <>
            <div className="workspace">
              <aside className="control-rail" aria-label="Document controls">
                <section className="bezel" id="panel-document" data-panel="document">
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

                <section className="bezel" id="panel-read" data-panel="read">
                  <h2>Read</h2>
                  <fieldset className="segmented-control">
                    <legend>Reading scope</legend>
                    {(['page', 'document'] as ReadScope[]).map((scope) => (
                      <label key={scope}><input type="radio" name="scope" checked={readScope === scope} onChange={() => setReadScope(scope)} /><span>{scope === 'page' ? 'This page only' : 'To the end'}</span></label>
                    ))}
                  </fieldset>
                  <p className="panel-copy">Play reads from the current page to the end of the document. Select text in the page transcript to read only that selection.</p>
                  {isMobile && (
                    <label className="dial-control bezel-dial">Speed <output>{speed.toFixed(2)}x</output><input aria-label="Reading speed" type="range" min="0.5" max="2" step="0.05" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></label>
                  )}
                </section>

                <section className="bezel" id="panel-voices" data-panel="voices">
                  <h2>Voice engine</h2>
                  <div className="engine-readout"><span className="status-led ready" aria-hidden="true" /><strong>Browser voice</strong></div>
                  <p className="panel-copy">Uses SpeechSynthesis with voices installed in this browser. No Kokoro model is active yet.</p>
                </section>

                <section className="bezel" data-panel="voices">
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

              <section className="preview" id="panel-preview" aria-label="PDF preview">
                <header className="preview-header">
                  <span><strong>Preview</strong> Page {currentPage}</span>
                  {isMobile ? (
                    <div className="preview-zoom-controls">
                      <label className="dial-control preview-zoom">Zoom <output>{renderZoom}%</output><input aria-label="Preview zoom" type="range" min={MIN_PREVIEW_ZOOM} max={MAX_PREVIEW_ZOOM} step="1" value={renderZoom} onChange={(event) => { setManualZoom(true); setZoom(Number(event.target.value)) }} /></label>
                      <button type="button" className="fit-width-button" onClick={() => setManualZoom(false)}>Fit width</button>
                    </div>
                  ) : (
                    <span className="zoom-readout">{renderZoom}% zoom</span>
                  )}
                </header>
                <div className="preview-scroll" ref={previewScrollRef}>
                  {pdf ? <PdfCanvas document={pdf} pageNumber={currentPage} zoom={renderZoom} /> : <p>Loading preview...</p>}
                  <details className="page-text-disclosure">
                    <summary>Select text to read only that part</summary>
                    <div className="page-text" aria-label={`Selectable text from page ${currentPage}`} tabIndex={0}>
                      <p>{currentText || (documentState.extraction === 'complete' ? 'No readable text was found on this page.' : 'Extracting text...')}</p>
                    </div>
                  </details>
                </div>
              </section>
            </div>

            {!isMobile && (
              <footer className="transport" aria-label="Speech playback controls">
                <div className="transport-buttons">
                  <button aria-label="Stop reading" onClick={stop} disabled={playback.status === 'ready'}><Icon name="stop" /></button>
                  <button className="play-button" aria-label={playLabel} onClick={read} disabled={!documentState.characterCount || documentState.scanned || !speechRef.current.available}><Icon name={playback.status === 'playing' ? 'pause' : 'play'} /></button>
                </div>
                <div className="waveform" data-playing={playback.status === 'playing'} aria-hidden="true">{Array.from({ length: 32 }, (_, index) => <i key={index} style={{ height: `${8 + ((index * 17) % 25)}px` }} />)}</div>
                <div className="playback-readout" aria-live="polite"><strong>{playback.status}</strong><span>{playback.message}</span></div>
                <label className="dial-control">Speed <output>{speed.toFixed(2)}x</output><input aria-label="Reading speed" type="range" min="0.5" max="2" step="0.05" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></label>
                <label className="dial-control">Zoom <output>{zoom}%</output><input aria-label="Preview zoom" type="range" min="50" max="180" step="10" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
              </footer>
            )}

            {isMobile && (
              <nav className="mobile-bar" ref={mobileBarRef} aria-label="Reader panels and playback">
                <div className="mobile-tabs" role="tablist" aria-label="Reader panels">
                  {MOBILE_PANELS.map((panel) => (
                    <button
                      key={panel.id}
                      type="button"
                      role="tab"
                      id={`tab-${panel.id}`}
                      aria-selected={activePanel === panel.id}
                      aria-controls={`panel-${panel.id}`}
                      className={activePanel === panel.id ? 'active' : ''}
                      onClick={() => setActivePanel(panel.id)}
                    >
                      <PanelIcon paths={panel.paths} />
                      <span>{panel.label}</span>
                    </button>
                  ))}
                </div>
                <div className="mobile-transport">
                  <span className="mobile-page" aria-live="polite">Page {currentPage}</span>
                  <button aria-label="Stop reading" onClick={stop} disabled={playback.status === 'ready'}><Icon name="stop" /></button>
                  <button className="play-button" aria-label={playLabel} onClick={read} disabled={!documentState.characterCount || documentState.scanned || !speechRef.current.available}><Icon name={playback.status === 'playing' ? 'pause' : 'play'} /></button>
                </div>
              </nav>
            )}
          </>
        )}
        <DiagnosticsStatus />
        <div className="visually-hidden" role="status" aria-live="polite">{documentState ? `${extractionLabel}. ${playback.message}.` : 'No PDF open.'}</div>
      </section>
    </main>
  )
}

export default App
