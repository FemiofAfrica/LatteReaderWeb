import { useState } from 'react'

export function ReadingProgress({ value, max, disabled, onSeek, onSkip, status }: {
  value: number; max: number; disabled: boolean; onSeek: (offset: number) => void; onSkip: (direction: -1 | 1) => void
  status?: string
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? value
  const commit = () => { if (draft !== null) { onSeek(draft); setDraft(null) } }
  return <div className="reading-progress" role="group" aria-label="Sentence navigation and reading progress">
    <button type="button" aria-label="Previous sentence" disabled={disabled || value <= 0} onClick={() => onSkip(-1)}>‹</button>
    <label><span className="reading-progress-label"><span><span className="progress-label-full">Reading position</span><span className="progress-label-short">Position</span> {max ? Math.round(shown / max * 100) : 0}%</span>{status && <span className="mobile-reading-status">{status}</span>}</span>
      <input aria-label="Reading progress" aria-valuetext={`${max ? Math.round(shown / max * 100) : 0}% of reading text`} type="range" min={0} max={max || 1} step={1} value={shown} disabled={disabled}
        onChange={event => setDraft(Number(event.target.value))} onPointerUp={commit} onPointerCancel={() => setDraft(null)} onKeyUp={commit} onBlur={commit} />
    </label>
    <button type="button" aria-label="Next sentence" disabled={disabled || value >= max} onClick={() => onSkip(1)}>›</button>
  </div>
}
