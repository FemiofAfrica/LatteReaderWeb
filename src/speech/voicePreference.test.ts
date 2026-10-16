import { beforeEach, describe, expect, it } from 'vitest'
import { readVoicePreference, saveVoicePreference, VOICE_PREFERENCE_KEY } from './voicePreference'

describe('voice preference', () => {
  beforeEach(() => window.localStorage.clear())
  it('defaults to the browser voice', () => {
    expect(readVoicePreference()).toEqual({ engine: 'browser', naturalVoice: 'kitten-micro-jasper' })
  })
  it('keeps Natural voice and speed until changed', () => {
    saveVoicePreference({ engine: 'local' })
    saveVoicePreference({ speed: 1.25 })
    expect(readVoicePreference()).toEqual({ engine: 'local', naturalVoice: 'kitten-micro-jasper', speed: 1.25 })
    saveVoicePreference({ engine: 'browser' })
    expect(readVoicePreference().engine).toBe('browser')
    expect(readVoicePreference().speed).toBe(1.25)
  })
  it('ignores damaged or out-of-range values', () => {
    window.localStorage.setItem(VOICE_PREFERENCE_KEY, '{not json')
    expect(readVoicePreference().engine).toBe('browser')
    window.localStorage.setItem(VOICE_PREFERENCE_KEY, JSON.stringify({ engine: 'robot', speed: 9 }))
    expect(readVoicePreference()).toEqual({ engine: 'browser', naturalVoice: 'kitten-micro-jasper' })
  })
})
