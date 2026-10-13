import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

interface PdfCanvasProps {
  document: PDFDocumentProxy
  pageNumber: number
  zoom: number
  onRendered?: () => void
}

export function PdfCanvas({ document, pageNumber, zoom, onRendered }: PdfCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    let page: PDFPageProxy | undefined
    let renderTask: ReturnType<PDFPageProxy['render']> | undefined

    const render = async () => {
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
          setError('')
          onRendered?.()
        }
      } catch (reason) {
        if (!cancelled && (reason as { name?: string }).name !== 'RenderingCancelledException') {
          setError(reason instanceof Error ? reason.message : 'Page rendering failed.')
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
    <div className="page-stage" aria-label={`Rendered PDF page ${pageNumber}`}>
      {error ? <p className="error-copy">{error}</p> : <canvas ref={canvasRef} />}
    </div>
  )
}
