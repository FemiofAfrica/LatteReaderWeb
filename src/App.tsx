import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PdfCanvas } from './components/PdfCanvas'
import { analyzeDocument, retainVoiceChoices, type DocumentVoicePlan } from './domain/analysis'
import {
  clearCurrentDocument,
  CURRENT_SCHEMA_VERSION,
  loadCurrentDocument,
  updateCurrentDocument,
  validateAndReplaceCurrentDocument,
  type CurrentDocumentRecord,
} from './domain/currentDocumentStore'
import { availabilityWarning, emptyDocumentState, extractionErrorCopy, hasUsableText, isExtractionMessage, type DocumentState, type ExtractionMessage, type ExtractionErrorCode } from './domain/document'
import { uploadDocument } from './domain/uploadFlow'
import { computeFitZoom, MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM } from './domain/fit'
import {
  initialPlaybackState,
  playbackReducer,
  type PlaybackState,
  type ReadScope,
} from './domain/playback'
import { planSpeechChunks, type SpeechChunk } from './domain/speechPlan'
import { readingTimeline, seekChunks, sentencePosition, sentenceSkip, type ReadingPosition } from './domain/readingPosition'
import { ReadAlong } from './components/ReadAlong'
import { sourceSelection, selectionChunks, type SourceSelection } from './domain/selection'
import { ReadingProgress } from './components/ReadingProgress'
import { BrowserSpeechEngine } from './speech/SpeechEngine'
import { watchBrowserVoices, type VoiceListState } from './speech/browserVoices'
import { VoiceChooser } from './components/VoiceChooser'
import { recordEvent } from './diagnostics/diagnostics'
import { shouldRecordProgress } from './diagnostics/progress'
import type { UploadFailure } from './pdf/uploadFailure'
import { DiagnosticsStatus } from './components/DiagnosticsStatus'
import { PageTurnViewer } from './components/PageTurnViewer'
import { RotaryControl } from './components/RotaryControl'
import { BrandMark } from './components/BrandMark'

const formatNumber = new Intl.NumberFormat()
const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

// Shared with CSS: narrow or short (including browser-zoom reflow) uses the unified Reader.
const MOBILE_QUERY = '(max-width: 780px), (max-height: 600px)'
// Bounded wait for the next page's text while extraction is still running, so reading
// continues as text arrives instead of failing.
const PENDING_TEXT_TIMEOUT_MS = 15000
const PENDING_TEXT_POLL_MS = 250

type MobilePanel = 'document' | 'read' | 'voices'

const MOBILE_PANELS: { id: MobilePanel; label: string; paths: string[] }[] = [
  { id: 'document', label: 'Document', paths: ['M7 3h7l5 5v13H7z', 'M14 3v5h5'] },
  { id: 'read', label: 'Read', paths: ['M4 5h7v14H4z', 'M13 5h7v14h-7z'] },
  { id: 'voices', label: 'Voices', paths: ['M12 3a3.5 3.5 0 013.5 3.5v4a3.5 3.5 0 01-7 0v-4A3.5 3.5 0 0112 3z', 'M5.5 11a6.5 6.5 0 0013 0'] },
]


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
  const resetVoicesRef = useRef(false)
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
  const [spokenPage, setSpokenPage] = useState(0)
  const [readAlong, setReadAlong] = useState(false)
  const [selectedRange, setSelectedRange] = useState<SourceSelection | null>(null)
  useEffect(() => {
    setSelectedRange(null)
    const update = () => setSelectedRange(sourceSelection(window.getSelection()))
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [currentPage, documentState?.id, readAlong])
  const [position, setPosition] = useState<ReadingPosition | null>(null)
  const [readingOffset, setReadingOffset] = useState(0)
  const [sessionChunks, setSessionChunks] = useState<SpeechChunk[] | null>(null)
  const sessionRef = useRef<SpeechChunk[] | null>(null)
  const sessionScopeRef = useRef<ReadScope>('document')
  const pendingSeekRef = useRef<(() => void) | null>(null)
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true)
  // `zoom` is the reader's stored zoom setting. On mobile the preview opens at a fit-to-width
  // value held separately in `fitZoom`, so the fit is a view value that never overwrites the
  // saved setting. `manualZoom` marks a zoom the reader set by hand, which is never re-fitted.
  const [zoom, setZoom] = useState(100)
  const [fitZoom, setFitZoom] = useState<number | null>(null)
  const [manualZoom, setManualZoom] = useState(false)
  const [fitRequested, setFitRequested] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [readScope, setReadScope] = useState<ReadScope>('document')
  const [defaultVoiceKey, setDefaultVoiceKey] = useState<string | undefined>()
  const [voiceList, setVoiceList] = useState<VoiceListState>({ voices: [], status: 'loading' })
  const [voiceFallback, setVoiceFallback] = useState(false)
  useEffect(() => watchBrowserVoices(setVoiceList), [])
  const defaultVoiceRef = useRef(defaultVoiceKey)
  defaultVoiceRef.current = defaultVoiceKey
  const [voicePlan, setVoicePlan] = useState<DocumentVoicePlan | null>(null)
  const [analysisMessage, setAnalysisMessage] = useState('Find character labels and dialogue in this PDF.')
  const [uploadError, setUploadError] = useState('')
  // The diagnosed cause, kept beside the sentence so the reader gets a recovery control only
  // when the document really was replaced and could not be opened.
  const [uploadFailure, setUploadFailure] = useState<UploadFailure | null>(null)
  const [isRestoring, setIsRestoring] = useState(true)
  const [activePanel, setActivePanel] = useState<MobilePanel>('read')
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

  const completeRun = () => {
    setVoiceFallback(false)
    const pages = runRef.current.pages
    if (pages > 1) recordEvent('playback.complete', { count: pages, durationMs: performance.now() - runRef.current.started })
    runRef.current = { pages: 0, started: 0 }
    readingPageRef.current = 0
    setPosition(null)
    if (sessionRef.current) setReadingOffset(readingTimeline(sessionRef.current).text.length)
    dispatchPlayback({ type: 'END' })
  }

  endHandlerRef.current = completeRun

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
    if ((!isMobile && !fitRequested) || manualZoom || !pdf) return
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
  }, [isMobile, fitRequested, manualZoom, pdf, currentPage, activePanel])

  const openPicker = () => fileInputRef.current?.click()

  const activateDocument = async (record: CurrentDocumentRecord, document: PDFDocumentProxy) => {
    clearWait()
    runRef.current = { pages: 0, started: 0 }
    readingPageRef.current = 0
    speechRef.current.stop()
    dispatchPlayback({ type: 'RESET' })
    extractionWorkerRef.current?.terminate()
    if (pdf) await pdf.cleanup()

    setPosition(null); setReadingOffset(0); setSessionChunks(null); sessionRef.current = null; pendingSeekRef.current = null
    setPdf(document)
    setUploadError('')
    setUploadFailure(null)
    setCurrentPage(Math.min(Math.max(record.reader.currentPage, 1), document.numPages))
    setSpokenPage(Math.min(document.numPages, Math.max(1, record.reader.readingPage ?? record.reader.currentPage)))
    followingRef.current = true
    setFollowing(true)
    setZoom(record.reader.zoom)
    // A newly opened document starts from the stored setting again, so the mobile fit applies.
    setFitZoom(null)
    setManualZoom(false)
    setFitRequested(false)
    setSpeed(record.reader.speed)
    setDefaultVoiceKey(record.reader.voiceKey)
    setVoiceFallback(false)
    setReadScope(record.reader.readScope)
    resetVoicesRef.current = false
    setVoicePlan(null) // Reanalyze stored text with current extraction before speaking.
    setAnalysisMessage(record.voicePlan
      ? 'Restored the saved local voice plan for this document.'
      : 'Find character labels and dialogue in this PDF.')

    const state = emptyDocumentState()
    state.name = record.name
    state.size = record.size
    state.id = record.id
    state.pageCount = document.numPages
    state.pages = Array(document.numPages).fill('')
    state.extraction = 'extracting'
    setDocumentState(state)

    const extractedText: string[] = []
    const extractionStart = performance.now()
    recordEvent('extraction.start', { count: document.numPages })
    try {
      const workerBytes = record.bytes.slice(0)
      const progressTrack = { lastPage: 0 }
      const worker = new Worker(new URL('./workers/pdf.worker.ts', import.meta.url), { type: 'module' })
      extractionWorkerRef.current = worker
      const failExtraction = (errorCode: ExtractionErrorCode) => {
        if (extractionWorkerRef.current !== worker) return
        recordEvent('extraction.fail', { errorCode: 'worker', durationMs: performance.now() - extractionStart })
        setDocumentState(current => current?.id === record.id ? { ...current, extraction: 'error', errorCode, error: extractionErrorCopy[errorCode] } : current)
        worker.terminate()
      }
      worker.onmessage = (event: MessageEvent<ExtractionMessage>) => {
        if (extractionWorkerRef.current !== worker) return
        const message = event.data
        if (!isExtractionMessage(message, document.numPages)) { failExtraction('extract-protocol'); return }
        if (message.type === 'page') extractedText[message.pageNumber - 1] = message.text
        if (message.type === 'complete' && record.voicePlan) {
          const refreshed = retainVoiceChoices(analyzeDocument(record.id, record.name, extractedText), resetVoicesRef.current ? null : record.voicePlan)
          setVoicePlan(refreshed)
          void updateCurrentDocument({ voicePlan: refreshed })
        }
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
              pagesWithReadableText: current.pagesWithReadableText + Number(hasUsableText(message.text)),
              pagesWithoutReadableText: current.pagesWithoutReadableText + Number(!hasUsableText(message.text)),
              unmapped: current.unmapped + message.unmapped,
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
              pagesWithReadableText: message.pagesWithReadableText,
              pagesWithoutReadableText: message.pagesWithoutReadableText,
            }
          }
          return { ...current, extraction: 'error', errorCode: message.errorCode, error: extractionErrorCopy[message.errorCode] }
        })
        if (message.type === 'complete' || message.type === 'error') worker.terminate()
      }
      worker.onerror = () => failExtraction('extract-runtime')
      worker.onmessageerror = () => failExtraction('extract-protocol')
      worker.postMessage({ type: 'extract', bytes: workerBytes }, [workerBytes])
    } catch {
      recordEvent('extraction.fail', { errorCode: 'worker', durationMs: performance.now() - extractionStart })
      setDocumentState(current => current?.id === record.id ? { ...current, extraction: 'error', errorCode: 'extract-startup', error: extractionErrorCopy['extract-startup'] } : current)
    }
  }

  const loadPdf = async (file: File) => {
    setUploadError('')
    setUploadFailure(null)
    // One honest cause per failure. The flow keeps validation ahead of the replacement, so
    // only a failure before the replace may say the saved document was not changed.
    const failure = await uploadDocument<PDFDocumentProxy>(file, {
      readBytes: (target) => target.arrayBuffer(),
      buildRecord: (target, bytes) => ({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        id: `${target.name}:${target.size}:${target.lastModified}`,
        name: target.name,
        size: target.size,
        lastModified: target.lastModified,
        mimeType: target.type || 'application/pdf',
        bytes,
        reader: { currentPage: 1, zoom, speed, readScope },
        voicePlan: null,
      }),
      validate: async (bytes) => (await import('./pdf/loadPdf')).loadPdf(bytes),
      validateAndReplace: (record, validate) => validateAndReplaceCurrentDocument(record, validate),
      activate: activateDocument,
      numPages: (document) => document.numPages,
      record: recordEvent,
      classify: async (error, phase) => (await import('./pdf/loadPdf')).classifyUploadError(error, phase),
    })
    setUploadFailure(failure)
    if (failure) setUploadError(failure.message)
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
        if (!cancelled) { setUploadFailure(null); setUploadError('The saved PDF could not be restored. You can delete it and open another PDF.') }
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
      void updateCurrentDocument({ reader: { currentPage, readingPage: spokenPage, zoom, speed, readScope, voiceKey: defaultVoiceKey } }, documentState.id)
    }, 150)
    return () => window.clearTimeout(timeout)
  }, [currentPage, spokenPage, zoom, speed, readScope, defaultVoiceKey, documentState?.id])

  useEffect(() => {
    if (!documentState) return
    const save = () => { void updateCurrentDocument({ reader: { currentPage: currentPageRef.current, readingPage: readingPageRef.current || spokenPage, zoom, speed, readScope, voiceKey: defaultVoiceRef.current } }, documentState.id) }
    // Saving on hide does not pause or cancel the browser voice. No automatic restart.
    const hide = () => { if (document.visibilityState === 'hidden') save() }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', save)
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', save) }
  }, [documentState?.id, spokenPage, zoom, speed, readScope])

  const analyze = () => {
    if (!documentState || documentState.extraction !== 'complete') return
    const started = performance.now()
    recordEvent('analysis.start', { count: documentState.pageCount })
    try {
      const plan = retainVoiceChoices(analyzeDocument(documentState.id, documentState.name, documentState.pages), voicePlan)
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

  const chooseCharacterVoice = (id: string, key: string | undefined) => {
    if (!voicePlan || !documentState) return
    const updated = { ...voicePlan, profiles: voicePlan.profiles.map(p => p.id === id ? { ...p, voiceKey: key } : p) }
    setVoicePlan(updated)
    voicePlanRef.current = updated
    void updateCurrentDocument({ voicePlan: updated }, documentState.id)
  }

  const currentText = documentState?.pages[currentPage - 1] ?? ''
  const extractionPercent = documentState?.pageCount
    ? Math.round((documentState.extractedPages / documentState.pageCount) * 100)
    : 0
  // What is actually rendered: the mobile fit while it is active, otherwise the stored setting.
  const renderZoom = (isMobile || fitRequested) && !manualZoom && fitZoom !== null ? fitZoom : zoom
  const rotaryControls = <div className="rotary-rack" role="group" aria-label="Reading adjustments">
    <RotaryControl label="Speed" name="Reading speed" value={speed} min={0.5} max={2} step={0.05} format={value => `${value.toFixed(2)}x`} onChange={setSpeed} />
    <RotaryControl label="Zoom" name="Preview zoom" className="preview-zoom" value={renderZoom} min={MIN_PREVIEW_ZOOM} max={MAX_PREVIEW_ZOOM} step={1} format={value => `${value}%`} onChange={value => { setManualZoom(true); setZoom(value) }} />
  </div>

  const availableChunks = useMemo(() => sessionChunks ?? (documentState?.extraction === 'complete'
    ? planSpeechChunks(documentState.pages, readScope === 'page' ? currentPage : 1, readScope, voicePlan) : []),
    [sessionChunks, documentState?.pages, documentState?.extraction, readScope, currentPage, voicePlan])
  const timeline = useMemo(() => readingTimeline(availableChunks), [availableChunks])
  const launchReading = (allChunks: SpeechChunk[], offset: number, scope: ReadScope) => {
    const chunks = seekChunks(allChunks, offset)
    const remaining = readingTimeline(chunks)
    const full = readingTimeline(allChunks)
    // seekChunks can discard a separator; derive the actual surviving chunk's offset.
    const origin = full.text.length - remaining.text.length
    const page = chunks[0]?.spans[0]?.pageNumber ?? spokenPage
    if (!chunks.length) { completeRun(); return }
    runRef.current = { pages: new Set(chunks.flatMap(c => c.spans.map(s => s.pageNumber))).size, started: performance.now() }
    readingPageRef.current = page
    dispatchPlayback({ type: 'PLAY', scope, page })
    speechRef.current.speak({ text: '', chunks, rate: speedRef.current, voiceKey: defaultVoiceRef.current, onVoiceFallback: setVoiceFallback,
      onPosition: (chunk, char, evidence) => {
        const offset = origin + remaining.starts[chunk] + char
        setReadingOffset(offset)
        setPosition(sentencePosition(full, offset, evidence))
      },
      onPage: page => {
        readingPageRef.current = page; setSpokenPage(page)
        if (followingRef.current) setCurrentPage(page)
        dispatchPlayback({ type: 'ADVANCE', page, totalPages: documentRef.current?.pageCount ?? page })
      },
      onError: () => { setPosition(null); dispatchPlayback({ type: 'FAIL', display: 'Voice unavailable', message: 'Voice stopped. Play to retry from this page.' }) },
    })
  }
  const seekReading = (requested: number) => {
    if (!availableChunks.length || playback.scope === 'selection' && playback.status !== 'ready') return
    const offset = Math.min(timeline.text.length, Math.max(0, requested))
    clearWait(); speechRef.current.stop(); setPosition(null)
    sessionRef.current = availableChunks; setSessionChunks(availableChunks); setReadingOffset(offset)
    followingRef.current = true; setFollowing(true)
    const source = timeline.source.slice(offset).find(Boolean) ?? timeline.source.filter(Boolean).at(-1)
    if (source) {
      readingPageRef.current = source.pageNumber
      setSpokenPage(source.pageNumber); setCurrentPage(source.pageNumber)
      dispatchPlayback({ type: 'SEEK', page: source.pageNumber })
    }
    if (offset === timeline.text.length) { pendingSeekRef.current = null; completeRun(); return }
    const scope = sessionChunks ? sessionScopeRef.current : readScope
    sessionScopeRef.current = scope
    const launch = () => launchReading(availableChunks, offset, scope)
    if (playback.status === 'playing') { pendingSeekRef.current = null; launch() }
    else { pendingSeekRef.current = launch } // A stopped/paused seek never starts audio.
  }
  const readingStatus = documentState?.extraction === 'error' ? 'Text extraction error'
    : !speechRef.current.available ? 'Voice unavailable'
    : documentState?.extraction === 'complete' && !documentState.pagesWithReadableText ? 'No readable text'
    : playback.display ?? 'Ready'
  const progressControl = <ReadingProgress value={readingOffset} max={timeline.text.length} status={isMobile ? readingStatus : undefined}
    disabled={!timeline.text.length || documentState?.extraction !== 'complete' || playback.scope === 'selection' && playback.status !== 'ready'}
    onSeek={seekReading} onSkip={direction => seekReading(sentenceSkip(timeline, readingOffset, direction))} />

  const read = (fromVisiblePage = false) => {
    if (!documentState || !documentState.pagesWithReadableText || !speechRef.current.available) return
    if (!fromVisiblePage && playback.status === 'paused') {
      const pending = pendingSeekRef.current
      pendingSeekRef.current = null
      if (pending) pending(); else speechRef.current.resume()
      dispatchPlayback({ type: 'RESUME' })
      return
    }
    if (!fromVisiblePage && playback.status === 'playing') {
      speechRef.current.pause()
      dispatchPlayback({ type: 'PAUSE' })
      return
    }

    if (!fromVisiblePage && pendingSeekRef.current) {
      const pending = pendingSeekRef.current; pendingSeekRef.current = null; pending(); return
    }
    setPosition(null); pendingSeekRef.current = null
    clearWait()
    runRef.current = { pages: 0, started: performance.now() }

    followingRef.current = true
    setFollowing(true)
    setSpokenPage(currentPage)

    // Play retains selection-only semantics. Continuation has its own explicit action.
    const selected = fromVisiblePage ? null : sourceSelection(window.getSelection())
    if (selected) {
      readSelected(selected, false)
      return
    }

    const fromPage = currentPage
    const scope = readScope
    const start = () => {
      const document = documentRef.current
      if (!document) return
      const chunks = planSpeechChunks(document.pages, fromPage, scope, voicePlanRef.current)
      if (!chunks.length) { completeRun(); return }
      sessionRef.current = chunks; sessionScopeRef.current = scope; setSessionChunks(chunks); setReadingOffset(0)
      launchReading(chunks, 0, scope)
    }
    // An unavailable page is not a sentence end. Wait before continuous reading rather
    // than truncating the last available sentence; page and selection remain immediate.
    if (scope === 'document' && documentState.extraction !== 'complete') {
      dispatchPlayback({ type: 'WAIT', scope, page: fromPage })
      const started = performance.now()
      const tick = () => {
        if (playbackRef.current.status === 'ready') return
        if (playbackRef.current.status === 'paused') { waitTimerRef.current = window.setTimeout(tick, PENDING_TEXT_POLL_MS); return }
        if (documentRef.current?.extraction === 'complete') { start(); return }
        if (documentRef.current?.extraction === 'error' || performance.now() - started > PENDING_TEXT_TIMEOUT_MS) {
          dispatchPlayback({ type: 'FAIL', message: 'Text is not ready yet. Wait for extraction, then press Play.' }); return
        }
        waitTimerRef.current = window.setTimeout(tick, PENDING_TEXT_POLL_MS)
      }
      waitTimerRef.current = window.setTimeout(tick, PENDING_TEXT_POLL_MS)
    } else start()
  }

  const readSelected = (selected: SourceSelection, toEnd: boolean) => {
    if (!documentState || selected.pageNumber !== currentPage || !speechRef.current.available) return
    if (toEnd && documentState.extraction !== 'complete') return
    const chunks = selectionChunks(planSpeechChunks(documentState.pages, selected.pageNumber,
      toEnd ? 'document' : 'page', voicePlanRef.current), selected, toEnd)
    if (!chunks.length) return
    clearWait(); speechRef.current.stop(); pendingSeekRef.current = null; setPosition(null)
    followingRef.current = true; setFollowing(true)
    const scope = toEnd ? 'document' : 'selection'
    sessionRef.current = chunks; sessionScopeRef.current = scope; setSessionChunks(chunks); setReadingOffset(0)
    launchReading(chunks, 0, scope)
  }
  const selectionActions = <div className="selection-actions" role="group" aria-label="Selected text reading">
    <button type="button" className="secondary-button" disabled={!selectedRange || selectedRange.pageNumber !== currentPage || !speechRef.current.available} onClick={() => selectedRange && readSelected(selectedRange, false)}>Read selection only</button>
    <button type="button" className="secondary-button" disabled={!selectedRange || selectedRange.pageNumber !== currentPage || documentState?.extraction !== 'complete' || !speechRef.current.available} onClick={() => selectedRange && readSelected(selectedRange, true)}>Read from selection</button>
  </div>

  const stop = () => {
    setVoiceFallback(false)
    clearWait()
    runRef.current = { pages: 0, started: 0 }
    readingPageRef.current = 0
    speechRef.current.stop()
    setPosition(null); pendingSeekRef.current = null
    dispatchPlayback({ type: 'STOP' })
  }

  const restoreBrowserDefault = async () => {
    if (!documentState) return
    stop()
    resetVoicesRef.current = true
    setDefaultVoiceKey(undefined); defaultVoiceRef.current = undefined
    const cleared = voicePlan ? { ...voicePlan, profiles: voicePlan.profiles.map(profile => ({ ...profile, voiceKey: undefined })) } : null
    setVoicePlan(cleared); voicePlanRef.current = cleared
    setSessionChunks(null); sessionRef.current = null; pendingSeekRef.current = null
    setAnalysisMessage('Browser default restored for all speakers. Press Play to read with one voice.')
    try {
      await updateCurrentDocument({ reader: { currentPage, readingPage: spokenPage, zoom, speed, readScope, voiceKey: undefined }, voicePlan: cleared }, documentState.id)
    } catch {
      setAnalysisMessage('Browser default restored for this session, but could not be saved. Try again.')
    }
  }

  const navigate = (page: number) => {
    if (playbackRef.current.status !== 'ready') { followingRef.current = false; setFollowing(false) }
    if (playbackRef.current.status === 'ready') { setSessionChunks(null); sessionRef.current = null; setReadingOffset(0); pendingSeekRef.current = null; setPosition(null) }
    setCurrentPage(page)
    setActivePanel('read')
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
      setSpokenPage(0)
      setPosition(null); setSessionChunks(null); sessionRef.current = null; setReadingOffset(0); pendingSeekRef.current = null
      setZoom(100)
      setFitZoom(null)
      setManualZoom(false)
      setSpeed(1)
      setReadScope('document')
      setAnalysisMessage('Find character labels and dialogue in this PDF.')
      setUploadFailure(null)
      setUploadError('Saved PDF, voice plan, settings, and reading position deleted from this browser.')
      dispatchPlayback({ type: 'STOP' })
      recordEvent('delete.complete')
    } catch {
      recordEvent('delete.fail', { errorCode: 'storage' })
      setUploadFailure(null)
      setUploadError('Local data could not be deleted. Try again.')
    }
  }

  const extractionLabel = !documentState ? ''
    : documentState.extraction === 'complete' ? 'Extraction complete'
    : documentState.extraction === 'error' ? 'Extraction error'
    : `Extracting page ${documentState.extractedPages} of ${documentState.pageCount}`

  const playLabel = playback.status === 'playing' ? 'Pause reading' : playback.status === 'paused' ? 'Resume reading' : 'Start reading'
  const textWarning = documentState ? availabilityWarning(documentState) : ''

  return (
    <main className="ambient-shell">
      {documentState && <a className="skip-link" href="#panel-read" onClick={() => setActivePanel('read')}>Skip to reader</a>}
      <section className="reader-deck" data-panel={activePanel} aria-label="LatteReader PDF console">
        <header className="topbar" ref={topbarRef}>
          <div className="brand-lockup">
            <BrandMark />
            <span><strong>LatteReader</strong><small>Open a PDF · Extract · Listen</small></span>
          </div>
          <div className="topbar-actions">
            {documentState && (
              <div className="document-status" title={documentState.name}>
                <span className={`status-led ${playback.status}`} aria-hidden="true" />
                <span>{readingStatus}</span>
                <span className="filename">{documentState.name}</span>
              </div>
            )}
            <button className={documentState ? 'secondary-button' : 'primary-button'} onClick={openPicker}>{documentState ? 'Replace PDF' : 'Open PDF'}</button>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              tabIndex={-1}
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
            {uploadError.includes('could not be restored') && <button className="delete-button compact-delete" onClick={() => { if (window.confirm('Delete the saved PDF and all reader data from this browser?')) void deleteLocalData() }}>Clear saved reader data</button>}
            {uploadFailure?.code === 'document-open' && <button className="primary-button" onClick={openPicker}>Open the file again</button>}
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
                  <div className="file-facts"><span>{formatBytes(documentState.size)}</span><span>{extractionLabel}</span></div>
                  {documentState.extraction === 'extracting' && <progress aria-label="Text extraction progress" value={extractionPercent} max="100" />}
                  {documentState.error && <p className="error-copy">{documentState.error}</p>}
                  {textWarning && <p className="warning-copy">{textWarning}</p>}
                  <p className="panel-copy">Saved here, not uploaded.</p>
                  <details className="document-details">
                    <summary>File and storage details</summary>
                    <div tabIndex={0}>
                      <p className="full-filename">{documentState.name}</p>
                      <p className="panel-copy">This browser saves the PDF, voice plan, settings, and page position. Replacing it removes the previous document data.</p>
                      <button className="delete-button" onClick={() => {
                        if (window.confirm('Delete the current PDF and all saved reader data from this browser?')) void deleteLocalData()
                      }}>Delete local data</button>
                    </div>
                  </details>
                </section>

                <section className="bezel" id="panel-voices" data-panel="voices">
                  <h2>Voice engine</h2>
                  <div className="engine-readout"><span className="status-led ready" aria-hidden="true" /><strong>Browser voice</strong></div>
                  <p className="panel-copy voice-status" role="status">{voiceList.status === 'unsupported' ? 'Speech is not supported.' : voiceFallback ? 'The selected voice is unavailable. Using automatic.' : voiceList.status === 'loading' ? 'Loading voices. Browser default can read.' : voiceList.status === 'empty' ? 'No voices listed. Try browser default.' : `${voiceList.voices.length} browser voices available.`}</p>
                  <VoiceChooser label="Default reading voice" selected={defaultVoiceKey} voices={voiceList.voices} onChange={setDefaultVoiceKey} />
                  <button type="button" className="secondary-button restore-default" onClick={() => void restoreBrowserDefault()}>Restore browser default</button>
                  <p className="panel-copy">One voice by default. Uses the browser’s default English voice when listed; otherwise the system default. Character voice choices are optional.</p>
                  <details className="engine-details"><summary>About browser voices</summary><p className="panel-copy" tabIndex={0}>Uses voices provided by this browser. Automatic uses the default English voice when listed, otherwise the system default. Changes apply when you start reading again. If no voices are listed and reading is silent, install or enable a browser voice. Kokoro is not active.</p></details>
                </section>

                <section className="bezel" data-panel="voices">
                  <h2>Character voices</h2>
                  <button className="key-button secondary-button" onClick={analyze} disabled={!documentState.characterCount || documentState.extraction !== 'complete'}>Analyze Characters</button>
                  <p className={voicePlan && !isMobile && !analysisMessage.includes('failed') ? 'visually-hidden' : 'panel-copy'} aria-live="polite">{analysisMessage}</p>
                  {voicePlan && (
                    <div className="speaker-list" role="group" aria-label="Detected speakers">
                      <p><strong>{voicePlan.profiles.length}</strong> voices · <strong>{voicePlan.segments.length}</strong> segments</p>
                      <ul tabIndex={0}>{voicePlan.profiles.map((profile) => <li key={profile.id}><span className={profile.id === 'narrator' ? 'narrator-dot' : ''} /><strong title={profile.displayName}>{profile.displayName}</strong><small>{Math.round(profile.confidence * 100)}%</small><VoiceChooser label={`${profile.displayName} voice`} automaticLabel="Use default reading voice" selected={profile.voiceKey} voices={voiceList.voices} onChange={key => chooseCharacterVoice(profile.id, key)} /></li>)}</ul>
                    </div>
                  )}
                </section>
              </aside>

              <section className="preview" id="panel-read" aria-label="PDF reader" tabIndex={-1}>
                <h1 className="visually-hidden">PDF reader</h1>
                <header className="preview-header">
                  <span><strong>Read</strong> Page {currentPage}</span>
                  <div className="preview-zoom-controls">
                    <button type="button" className="fit-width-button" onClick={() => { setManualZoom(false); if (!isMobile) setFitRequested(true) }}>Fit width</button>
                  </div>
                  {isMobile ? <div className="lcd-panel">
                    <div className="page-stepper">
                      <button aria-label="Previous page" disabled={currentPage <= 1} onClick={() => navigate(currentPage - 1)}><Icon name="back" /></button>
                      <output aria-label="Current page"><strong>{currentPage}</strong><span>/</span>{documentState.pageCount}</output>
                      <button aria-label="Next page" disabled={currentPage >= documentState.pageCount} onClick={() => navigate(currentPage + 1)}><Icon name="next" /></button>
                    </div>
                    <progress aria-label="Document page progress" value={currentPage} max={documentState.pageCount || 1} />
                    <label className="page-jump">Go to page
                      <input
                        type="number"
                        min="1"
                        max={documentState.pageCount}
                        value={currentPage}
                        onChange={(event) => navigate(Math.min(documentState.pageCount, Math.max(1, Number(event.target.value))))}
                      />
                    </label>
                  </div> : <div className="page-navigation" role="group" aria-label="Page navigation">
                    <button aria-label="Previous page" disabled={currentPage <= 1} onClick={() => navigate(currentPage - 1)}><Icon name="back" /></button>
                    <label>Page <input aria-label="Go to page" type="number" inputMode="numeric" min="1" max={documentState.pageCount} value={currentPage} onChange={(event) => navigate(Math.min(documentState.pageCount, Math.max(1, Number(event.target.value))))} /></label>
                    <output aria-label="Current page"><span className="visually-hidden">{currentPage}</span><span aria-hidden="true"> / </span>{documentState.pageCount}</output>
                    <button aria-label="Next page" disabled={currentPage >= documentState.pageCount} onClick={() => navigate(currentPage + 1)}><Icon name="next" /></button>
                  </div>}
                  <fieldset className="segmented-control">
                    <legend>Reading scope</legend>
                    {(['page', 'document'] as ReadScope[]).map((scope) => (
                      <label key={scope}><input type="radio" name="scope" checked={readScope === scope} onChange={() => setReadScope(scope)} /><span>{scope === 'page' ? 'This page only' : 'To the end'}</span></label>
                    ))}
                  </fieldset>
                  <p className="panel-copy">Browse without interrupting reading. Read from this page starts here.</p>
                  {isMobile && rotaryControls}
                  {!following && playback.status !== 'ready' && <div className="reading-position">
                    <span>{readingStatus} page {playback.page || spokenPage}</span>
                    <button className="fit-width-button" onClick={() => { followingRef.current = true; setFollowing(true); setCurrentPage(readingPageRef.current || playback.page) }}>Follow reading</button>
                    <button className="fit-width-button" disabled={!documentState.pagesWithReadableText || !speechRef.current.available} onClick={() => { stop(); read(true) }}>Read from this page</button>
                  </div>}
                </header>
                <PageTurnViewer page={currentPage} pageCount={documentState.pageCount} allowSwipe={renderZoom <= 100 || (!manualZoom && fitZoom !== null)} onNavigate={navigate}>
                <div className="preview-scroll" ref={previewScrollRef} tabIndex={0} aria-label="PDF preview and selectable text">
                  {textWarning && <p className="warning-copy">{textWarning}</p>}
                  {documentState.error && <p className="error-copy" role="alert">{documentState.error}</p>}
                  <button type="button" className="secondary-button read-along-toggle" aria-pressed={readAlong} onClick={() => setReadAlong(value => !value)}>Read-along text</button>
                  {readAlong ? <ReadAlong text={currentText} page={currentPage} position={position} following={following} status={playback.status} />
                    : pdf ? <PdfCanvas document={pdf} pageNumber={currentPage} zoom={renderZoom} onNavigate={navigate} /> : <p>Loading preview...</p>}
                  {documentState.unmapped > 0 && <p className="warning-copy" role="alert">Some letters could not be extracted from this PDF. Reading may omit them. Try a text-exported PDF; local OCR is not available yet.</p>}
                  {readAlong && selectionActions}
                  <details className="page-text-disclosure">
                    <summary>Select text to read it</summary>
                    {!readAlong && selectionActions}
                    <div className="page-text" data-source-page={currentPage} aria-label={`Selectable text from page ${currentPage}`} tabIndex={0}>
                      <p>{hasUsableText(currentText) ? currentText : (documentState.extraction === 'complete' ? 'No readable text was found on this page.' : 'Extracting text...')}</p>
                    </div>
                  </details>
                </div>
                </PageTurnViewer>
              </section>
            </div>

            {!isMobile && (
              <footer className="transport" aria-label="Speech playback controls">
                <div className="transport-buttons">
                  <button aria-label="Stop reading" onClick={stop} disabled={playback.status === 'ready'}><Icon name="stop" /></button>
                  <button className="play-button" aria-label={playLabel} onClick={() => read()} disabled={!documentState.pagesWithReadableText || !speechRef.current.available}><Icon name={playback.status === 'playing' ? 'pause' : 'play'} /></button>
                </div>
                {progressControl}
                <div className="playback-readout"><strong>{readingStatus}</strong><span>{playback.message}</span></div>
                {rotaryControls}
              </footer>
            )}

            {isMobile && (
              <nav className="mobile-bar" ref={mobileBarRef} aria-label="Reader panels and playback">

                {progressControl}
                <div className="mobile-tabs" role="tablist" aria-label="Reader panels">
                  {MOBILE_PANELS.map((panel) => (
                    <button
                      key={panel.id}
                      type="button"
                      role="tab"
                      id={`tab-${panel.id}`}
                      aria-selected={activePanel === panel.id}
                      aria-controls={`panel-${panel.id}`}
                      tabIndex={activePanel === panel.id ? 0 : -1}
                      className={activePanel === panel.id ? 'active' : ''}
                      onClick={() => setActivePanel(panel.id)}
                      onKeyDown={(event) => {
                        const index = MOBILE_PANELS.findIndex(({ id }) => id === panel.id)
                        const next = event.key === 'ArrowRight' ? (index + 1) % MOBILE_PANELS.length
                          : event.key === 'ArrowLeft' ? (index + MOBILE_PANELS.length - 1) % MOBILE_PANELS.length
                          : event.key === 'Home' ? 0 : event.key === 'End' ? MOBILE_PANELS.length - 1 : null
                        if (next === null) return
                        event.preventDefault()
                        const target = MOBILE_PANELS[next].id
                        setActivePanel(target)
                        document.getElementById(`tab-${target}`)?.focus()
                      }}
                    >
                      <PanelIcon paths={panel.paths} />
                      <span>{panel.label}</span>
                    </button>
                  ))}
                </div>
                <div className="mobile-transport">
                  <span className="mobile-page" aria-live="polite">Page {currentPage}</span>
                  <button aria-label="Stop reading" onClick={stop} disabled={playback.status === 'ready'}><Icon name="stop" /></button>
                  <button className="play-button" aria-label={playLabel} onClick={() => read()} disabled={!documentState.pagesWithReadableText || !speechRef.current.available}><Icon name={playback.status === 'playing' ? 'pause' : 'play'} /></button>
                </div>
              </nav>
            )}
          </>
        )}
        <DiagnosticsStatus />
        <div className="visually-hidden" role="status" aria-live="polite">{documentState ? `${extractionLabel}. ${readingStatus}. ${playback.message}.` : 'No PDF open.'}</div>
      </section>
    </main>
  )
}

export default App
