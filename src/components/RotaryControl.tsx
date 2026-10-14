import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react'

export function rotaryValue(value: number, min: number, max: number, step: number) {
  return Math.min(max, Math.max(min, Number((min + Math.round((value - min) / step) * step).toFixed(4))))
}

type Props = {
  label: string
  name: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  onChange: (value: number) => void
  disabled?: boolean
  className?: string
}

// Native range semantics and keyboard behavior, with a relative vertical pointer gesture.
// The separate numeric editor is a precise, non-dragging path for touch and assistive tech.
export function RotaryControl({ label, name, value, min, max, step, format, onChange, disabled = false, className = '' }: Props) {
  const id = useId()
  const sliderRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const slider = sliderRef.current
    if (!slider) return
    // Chromium's range touch default can jump to the touched X even when pointerdown
    // was cancelled. React touch listeners are passive, so cancel that native default here.
    const preventRangeTouch = (event: TouchEvent) => event.preventDefault()
    slider.addEventListener('touchstart', preventRangeTouch, { passive: false })
    return () => slider.removeEventListener('touchstart', preventRangeTouch)
  }, [])
  const gesture = useRef<{ id: number; y: number; value: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const cancelEdit = useRef(false)
  const proportion = Math.min(1, Math.max(0, (value - min) / (max - min)))
  const finish = (event: PointerEvent<HTMLInputElement>) => {
    if (gesture.current?.id !== event.pointerId) return
    gesture.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const commit = () => {
    if (!cancelEdit.current && draft !== null && draft.trim() && Number.isFinite(Number(draft))) onChange(rotaryValue(Number(draft), min, max, step))
    cancelEdit.current = false
    setDraft(null)
  }
  return <div className={`rotary-control ${className}`} data-dragging={dragging} data-disabled={disabled}>
    <div className="rotary-dial" style={{ '--dial-angle': `${-135 + proportion * 270}deg`, '--dial-sweep': `${proportion * 270}deg` } as CSSProperties}>
      <div className="rotary-track" aria-hidden="true" />
      <div className="rotary-face" aria-hidden="true"><span className="rotary-pointer" /></div>
      <input ref={sliderRef} id={id} aria-label={name} aria-valuetext={format(value)} aria-describedby={`${id}-hint`} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={event => onChange(Number(event.target.value))}
        onPointerDown={event => {
          if (disabled || !event.isPrimary || event.button !== 0) return
          event.preventDefault()
          event.currentTarget.focus()
          gesture.current = { id: event.pointerId, y: event.clientY, value }
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={event => {
          const start = gesture.current
          if (!start || start.id !== event.pointerId) return
          event.preventDefault()
          onChange(rotaryValue(start.value + (start.y - event.clientY) / 160 * (max - min), min, max, step))
        }}
        onPointerUp={finish} onPointerCancel={finish}
        onLostPointerCapture={() => { gesture.current = null; setDragging(false) }} />
    </div>
    <div className="rotary-caption">
      <label htmlFor={id}>{label}</label>
      <div className="rotary-value" title="Enter a number">
      <output htmlFor={id} className={label === 'Zoom' ? 'zoom-readout' : 'speed-readout'}>{format(value)}</output>
      <input aria-label={`${label} ${label === 'Zoom' ? 'percentage' : 'multiplier'}`} type="number" inputMode="decimal" min={min} max={max} step={step} disabled={disabled} value={draft ?? value}
        onChange={event => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') { cancelEdit.current = true; event.currentTarget.blur() }
        }} />
      </div>
    </div>
    <span className="visually-hidden" id={`${id}-hint`}>Drag up or down, use arrow keys, or enter a number. Home sets the minimum; End sets the maximum.</span>
  </div>
}
