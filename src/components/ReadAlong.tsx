import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReadingPosition } from '../domain/readingPosition'

export function ReadAlong({ text, page, position, following, status }: {
  text: string; page: number; position: ReadingPosition | null; following: boolean; status: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const ranges = position?.ranges.filter(r => r.pageNumber === page) ?? []
  useLayoutEffect(() => {
    const container = scroller.current
    if (!container) return
    const apply = () => {
      const bar = document.querySelector('.mobile-bar') ?? document.querySelector('.transport')
      if (!bar || getComputedStyle(bar).display === 'none') { container.style.removeProperty('max-height'); return }
      const frame = container.parentElement
      const frameStyle = frame ? getComputedStyle(frame) : null
      const inset = frameStyle ? parseFloat(frameStyle.paddingBottom) + parseFloat(frameStyle.borderBottomWidth) : 0
      const available = bar.getBoundingClientRect().top - container.getBoundingClientRect().top - inset - 1
      // Include transcript padding in the bound; never force a 100px minimum beneath pinned chrome.
      container.style.boxSizing = 'border-box'
      container.style.maxHeight = `${Math.min(window.innerHeight / 2, Math.max(0, available))}px`
    }
    apply()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
    if (container.parentElement?.parentElement) observer?.observe(container.parentElement.parentElement)
    const bar = document.querySelector('.mobile-bar') ?? document.querySelector('.transport'); if (bar) observer?.observe(bar)
    window.addEventListener('resize', apply)
    return () => { observer?.disconnect(); window.removeEventListener('resize', apply) }
  }, [page, status, following])
  useEffect(() => {
    if (!following || status !== 'playing') return
    const container = scroller.current
    const mark = container?.querySelector('mark')
    if (!container || !mark) return
    // Scroll this transcript only, never the stationary console or mobile chrome.
    const box = container.getBoundingClientRect(), target = mark.getBoundingClientRect()
    if (target.top < box.top || target.bottom > box.bottom) container.scrollTop += target.top - box.top - box.height / 3
  }, [position, following, status, page])
  let cursor = 0
  const parts = ranges.flatMap((range, index) => {
    const result = [<span key={`before-${index}`}>{text.slice(cursor, range.start)}</span>,
      <mark key={`mark-${index}`} data-source-start={range.start} data-source-end={range.end} data-state={status}>{text.slice(range.start, range.end)}</mark>]
    cursor = range.end
    return result
  })
  return <section className="read-along" aria-label="Read-along text">
    <p className="panel-copy">Text from your PDF. {status === 'ready' ? 'Press Play to follow the reading.' : status === 'paused' ? position?.ranges.length ? 'Paused at this sentence.' : 'Paused. Your voice has not shared its reading place.' : position?.evidence === 'audio-chunk' ? 'Following short passages, not each word.' : position?.evidence === 'boundary' ? 'Following the sentence being read.' : 'Your voice shares its place only when a passage starts or ends.'}</p>
    <div className="transcript-frame"><div className="read-along-text page-text" data-source-page={page} ref={scroller} tabIndex={0}><p>{parts}{text.slice(cursor)}</p></div></div>
  </section>
}
