import { useRef, type ReactNode, type TouchEvent } from 'react'

type Props = { children: ReactNode; page: number; pageCount: number; allowSwipe: boolean; onNavigate: (page: number) => void }

export function PageTurnViewer({ children, page, pageCount, allowSwipe, onNavigate }: Props) {
  const gesture = useRef<{ x: number; y: number; id: number; axis: 'pending' | 'horizontal' | 'vertical' } | null>(null)
  const eligible = (target: EventTarget) => {
    if (!allowSwipe || !(target instanceof HTMLCanvasElement)) return false
    const scroller = target.closest('.preview-scroll')
    return !!scroller && scroller.scrollWidth <= scroller.clientWidth + 1
  }
  const move = (event: TouchEvent<HTMLDivElement>) => {
    const start = gesture.current
    if (!start || event.touches.length !== 1) { gesture.current = null; return }
    const touch = event.touches[0]
    if (touch.identifier !== start.id) { gesture.current = null; return }
    const dx = Math.abs(touch.clientX - start.x), dy = Math.abs(touch.clientY - start.y)
    if (start.axis === 'pending' && Math.max(dx, dy) >= 12) start.axis = dx > dy * 1.5 ? 'horizontal' : 'vertical'
  }
  return <div className="page-turn-viewer"
    onTouchStart={event => {
      gesture.current = null
      if (event.touches.length !== 1 || !eligible(event.target)) return
      const touch = event.touches[0]
      // Leave OS/browser back gestures at both viewport edges entirely alone.
      if (touch.clientX < 24 || touch.clientX > window.innerWidth - 24) return
      gesture.current = { x: touch.clientX, y: touch.clientY, id: touch.identifier, axis: 'pending' }
    }}
    onTouchMove={move}
    onTouchEnd={event => {
      const start = gesture.current
      gesture.current = null
      if (!start || start.axis !== 'horizontal' || !eligible(event.target)) return
      const touch = Array.from(event.changedTouches).find(touch => touch.identifier === start.id)
      if (!touch) return
      const dx = touch.clientX - start.x, dy = touch.clientY - start.y
      if (Math.abs(dx) < 60 || Math.abs(dx) <= Math.abs(dy) * 1.5) return
      const next = page + (dx < 0 ? 1 : -1)
      if (next >= 1 && next <= pageCount) onNavigate(next)
    }}
    onTouchCancel={() => { gesture.current = null }}>
    <button className="viewer-page-arrow viewer-previous" aria-label="Previous PDF page" disabled={page <= 1} onClick={() => onNavigate(page - 1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button>
    {children}
    <button className="viewer-page-arrow viewer-next" aria-label="Next PDF page" disabled={page >= pageCount} onClick={() => onNavigate(page + 1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button>
  </div>
}
