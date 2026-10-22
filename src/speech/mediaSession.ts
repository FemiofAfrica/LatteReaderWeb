export interface MediaSessionHandlers {
  title: string
  artist?: string
  onPlay: () => void
  onPause: () => void
  onStop?: () => void
  onNext?: () => void
  onPrevious?: () => void
  onSeek?: (time: number) => void
  onSeekBy?: (delta: number) => void
}

function media(): MediaSession | null {
  try { return navigator.mediaSession ?? null } catch { return null }
}

export function bindMediaSession(handlers: MediaSessionHandlers): () => void {
  const session = media()
  if (!session) return () => undefined
  try {
    session.metadata = new MediaMetadata({ title: handlers.title, artist: handlers.artist ?? 'LatteReader' })
    session.playbackState = 'playing'
    const bind = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { session.setActionHandler(action, handler) } catch { /* not all browsers implement every action */ }
    }
    bind('play', () => handlers.onPlay())
    bind('pause', () => handlers.onPause())
    bind('stop', handlers.onStop ? () => handlers.onStop?.() : null)
    bind('nexttrack', handlers.onNext ? () => handlers.onNext?.() : null)
    bind('previoustrack', handlers.onPrevious ? () => handlers.onPrevious?.() : null)
    bind('seekto', details => {
      if (details.seekTime == null) return
      handlers.onSeek?.(details.seekTime)
    })
    bind('seekbackward', details => handlers.onSeekBy?.(-(details.seekOffset ?? 10)))
    bind('seekforward', details => handlers.onSeekBy?.(details.seekOffset ?? 10))
  } catch {
    return () => undefined
  }
  return () => {
    try {
      session.metadata = null
      session.playbackState = 'none'
      for (const action of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack', 'seekto', 'seekbackward', 'seekforward'] as MediaSessionAction[]) {
        session.setActionHandler(action, null)
      }
    } catch { /* closing the page */ }
  }
}

export function updateMediaPosition(state: { duration: number; position: number; playbackRate?: number; paused?: boolean }): void {
  const session = media()
  if (!session) return
  try {
    if (state.paused != null) session.playbackState = state.paused ? 'paused' : 'playing'
    if (state.duration > 0 && Number.isFinite(state.position)) {
      session.setPositionState({
        duration: state.duration,
        position: Math.max(0, Math.min(state.duration, state.position)),
        playbackRate: state.playbackRate ?? 1,
      })
    }
  } catch { /* some browsers reject incomplete position state */ }
}
