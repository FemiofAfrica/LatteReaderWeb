/**
 * The reader's voice choice, kept on this device until they change it.
 *
 * Stored in localStorage, never sent anywhere. Only the mode, the Natural voice id
 * and the reading speed: no document text, no file names.
 */
export const VOICE_PREFERENCE_KEY = 'latte-voice-preference'
export type VoiceMode = 'browser' | 'local'
export interface VoicePreference {
  engine: VoiceMode
  /** The on-device voice used in Natural mode (there is one today). */
  naturalVoice: string
  speed?: number
}
export const DEFAULT_NATURAL_VOICE = 'kitten-micro-jasper'
const DEFAULT: VoicePreference = { engine: 'browser', naturalVoice: DEFAULT_NATURAL_VOICE }

export function readVoicePreference(): VoicePreference {
  try {
    const raw = JSON.parse(window.localStorage.getItem(VOICE_PREFERENCE_KEY) ?? 'null')
    if (!raw || typeof raw !== 'object') return { ...DEFAULT }
    const speed = typeof raw.speed === 'number' && Number.isFinite(raw.speed) && raw.speed >= 0.5 && raw.speed <= 2 ? raw.speed : undefined
    return {
      engine: raw.engine === 'local' ? 'local' : 'browser',
      naturalVoice: typeof raw.naturalVoice === 'string' && raw.naturalVoice ? raw.naturalVoice : DEFAULT_NATURAL_VOICE,
      ...(speed === undefined ? {} : { speed }),
    }
  } catch { return { ...DEFAULT } }
}

export function saveVoicePreference(change: Partial<VoicePreference>): void {
  try {
    window.localStorage.setItem(VOICE_PREFERENCE_KEY, JSON.stringify({ ...readVoicePreference(), ...change }))
  } catch { /* storage blocked: the choice lasts for this visit only */ }
}
