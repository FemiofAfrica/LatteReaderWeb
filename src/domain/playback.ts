export type PlaybackStatus = 'ready' | 'playing' | 'paused'
export type ReadScope = 'selection' | 'page' | 'document'

export interface PlaybackState {
  status: PlaybackStatus
  scope: ReadScope
  message: string
}

export type PlaybackAction =
  | { type: 'PLAY'; scope: ReadScope }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'STOP' }
  | { type: 'END' }

export const initialPlaybackState: PlaybackState = {
  status: 'ready',
  scope: 'page',
  message: 'Ready to read',
}

export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'PLAY': return { status: 'playing', scope: action.scope, message: `Reading ${action.scope}` }
    case 'PAUSE': return { ...state, status: 'paused', message: 'Playback paused' }
    case 'RESUME': return { ...state, status: 'playing', message: `Reading ${state.scope}` }
    case 'END': return { ...state, status: 'ready', message: 'Reading complete' }
    case 'STOP': return initialPlaybackState
  }
}
