import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { recordEvent } from '../diagnostics/diagnostics'

interface PdfCanvasProps {
  document: PDFDocumentProxy
  pageNumber: number
  zoom: number
  onRendered?: () => void
  onNavigate?: (page: number) => void
}

export function PdfCanvas({ document, pageNumber, zoom, onRendered, onNavigate }: PdfCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    let page: PDFPageProxy | undefined
    let renderTask: ReturnType<PDFPageProxy['render']> | undefined

    const render = async () => {
      const started = performance.now()
      recordEvent('renderer.start', { page: pageNumber, zoom })
      try {
        page = await document.getPage(pageNumber)
        if (cancelled || !canvasRef.current) return
        const viewport = page.getViewport({ scale: zoom / 100 })
        const canvas = canvasRef.current
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas is unavailable in this browser.')
        const ratio = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * ratio)
        canvas.height = Math.floor(viewport.height * ratio)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        })
        await renderTask.promise
        if (!cancelled) {
          recordEvent('renderer.complete', { page: pageNumber, zoom, durationMs: performance.now() - started })
          setError('')
          onRendered?.()
        }
      } catch (reason) {
        if (!cancelled && (reason as { name?: string } | null)?.name !== 'RenderingCancelledException') {
          recordEvent('renderer.fail', { page: pageNumber, zoom, errorCode: 'render', durationMs: performance.now() - started })
          setError('Page rendering failed. Try another page or zoom level.')
        }
      }
    }

    void render()
    return () => {
      cancelled = true
      renderTask?.cancel()
      page?.cleanup()
    }
  }, [document, pageNumber, zoom, onRendered])

  return (
    <div className="page-stage" role="group" aria-label={`Rendered PDF page ${pageNumber}`}>
      {error && <p className="error-copy">{error}</p>}
      <div className="canvas-surface" hidden={Boolean(error)}>
        <canvas ref={canvasRef} />
        {onNavigate && <>
          <button className="canvas-edge-arrow canvas-edge-previous" aria-label="Previous PDF page" disabled={pageNumber <= 1} onClick={() => onNavigate(pageNumber - 1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button>
          <button className="canvas-edge-arrow canvas-edge-next" aria-label="Next PDF page" disabled={pageNumber >= document.numPages} onClick={() => onNavigate(pageNumber + 1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button>
        </>}
      </div>
    </div>
  )
}
