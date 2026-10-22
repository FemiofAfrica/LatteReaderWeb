import { audioReadyCopy, listenedPercent, type AudioReadyProgress } from '../speech/audioReady'

export function AudioReadyBar({
  progress,
  compact = false,
  canPrepare = false,
  onPrepare,
  onCancel,
}: {
  progress: AudioReadyProgress | null
  compact?: boolean
  canPrepare?: boolean
  onPrepare?: () => void
  onCancel?: () => void
}) {
  if (!progress && !canPrepare && !onPrepare) return null
  const value = progress
  const generated = value?.generatedPercent ?? 0
  const listened = value ? listenedPercent(value) : 0
  const copy = value ? audioReadyCopy(value) : 'Prepare audio to keep playing after you leave this page.'
  return (
    <div className={compact ? 'audio-ready compact' : 'audio-ready'} data-audio-ready={compact ? 'compact' : 'full'}>
      <div className="audio-ready-track" role="img" aria-label={value ? `${generated}% of the document has audio ready. ${copy}` : copy}>
        <span className="audio-ready-generated" style={{ width: `${generated}%` }} />
        <span className="audio-ready-listened" style={{ width: `${listened}%` }} />
      </div>
      {!compact && value && <p className="audio-ready-percent">{value.generatedPercent}% ready</p>}
      <p className="audio-ready-copy">{copy}</p>
      {!compact && (value?.preparing
        ? <button type="button" className="secondary-button" onClick={onCancel}>Cancel preparing</button>
        : canPrepare && onPrepare && <button type="button" className="secondary-button" onClick={onPrepare} disabled={!canPrepare}>Prepare whole document</button>
      )}
    </div>
  )
}
