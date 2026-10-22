import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

/** Parse a typed page number. Empty or non-numeric input is not a jump. */
export function parsePageJump(raw: string, pageCount: number): number | null {
  const trimmed = raw.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return null
  const last = Math.max(1, Math.floor(pageCount) || 1)
  return Math.min(last, Math.max(1, Math.floor(value)))
}

export function PageJump({
  page,
  pageCount,
  onNavigate,
  label = 'Go to page',
  showGoButton = false,
  className,
}: {
  page: number
  pageCount: number
  onNavigate: (page: number) => void
  label?: string
  showGoButton?: boolean
  className?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const focused = useRef(false)
  const shown = draft ?? String(page)

  useEffect(() => {
    if (!focused.current) setDraft(null)
  }, [page])

  const commit = () => {
    if (draft === null) return
    const next = parsePageJump(draft, pageCount)
    setDraft(null)
    if (next === null || next === page) return
    onNavigate(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setDraft(null)
    }
  }

  return (
    <label className={className ?? 'page-jump'}>
      {label}
      <input
        aria-label="Go to page"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        enterKeyHint="go"
        autoComplete="off"
        min={1}
        max={pageCount}
        value={shown}
        onChange={event => setDraft(event.target.value.replace(/[^\d]/g, ''))}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; commit() }}
        onKeyDown={onKeyDown}
      />
      {showGoButton && <button type="button" className="go-page" onClick={commit}>Go</button>}
    </label>
  )
}
