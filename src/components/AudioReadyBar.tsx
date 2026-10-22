import { audioReadyCopy, listenedPercent, type AudioReadyProgress } from '../speech/audioReady'

export function AudioReadyBar({
  progress,
  compact = false,
  canPrepare = false,
  onPrepare,
  onCancel,
  needsVoice = false,
  voiceActionLabel = 'Use Natural voice',
  onVoiceAction,
  voiceActionDisabled = false,
}: {
  progress: AudioReadyProgress | null
  compact?: boolean
  canPrepare?: boolean
  onPrepare?: () => void
  onCancel?: () => void
  needsVoice?: boolean
  voiceActionLabel?: string
  onVoiceAction?: () => void
  voiceActionDisabled?: boolean
}) {
  if (needsVoice) {
    const copy = 'Background play needs the Natural voice.'
    return (
      <div className={compact ? 'audio-ready compact' : 'audio-ready'} data-audio-ready={compact ? 'compact' : 'needs-voice'}>
        {!compact && <h3 className="audio-ready-heading">Audio ready</h3>}
        <p className="audio-ready-copy">{copy}</p>
        {!compact && onVoiceAction && (
          <button type="button" className="secondary-button" onClick={onVoiceAction} disabled={voiceActionDisabled}>{voiceActionLabel}</button>
        )}
      </div>
    )
  }
  if (!progress && !canPrepare && !onPrepare && !compact) return null
  const value = progress
  const generated = value?.generatedPercent ?? 0
  const listened = value ? listenedPercent(value) : 0
  const copy = value ? audioReadyCopy(value) : 'Prepare audio to keep playing after you leave this page.'
  return (
    <div className={compact ? 'audio-ready compact' : 'audio-ready'} data-audio-ready={compact ? 'compact' : 'full'}>
      {!compact && <h3 className="audio-ready-heading">Audio ready</h3>}
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
