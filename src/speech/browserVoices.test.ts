import { afterEach, expect, it, vi } from 'vitest'
import { resolveVoice, voiceKey, watchBrowserVoices } from './browserVoices'
const voice = (name: string, lang = 'en-US', uri = name, localService = true) => ({ name, lang, voiceURI: uri, localService, default: false }) as SpeechSynthesisVoice
afterEach(() => vi.useRealTimers())
it('handles delayed, reordered, removed and duplicate URI voices without losing identity', () => {
  vi.useFakeTimers()
  const target = new EventTarget(), update = vi.fn()
  let voices: SpeechSynthesisVoice[] = []
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: Object.assign(target, { getVoices: () => voices }) })
  const dispose = watchBrowserVoices(update)
  expect(update.mock.calls.at(-1)?.[0].status).toBe('loading')
  vi.advanceTimersByTime(3000)
  expect(update.mock.calls.at(-1)?.[0].status).toBe('empty')
  const a = voice('One', 'en-US', 'shared'), b = voice('Two', 'fr-FR', 'shared')
  const c = voice('One', 'en-US', 'shared', false)
  voices = [b, a, c, a]; target.dispatchEvent(new Event('voiceschanged'))
  expect(update.mock.calls.at(-1)?.[0].voices).toHaveLength(3)
  expect(resolveVoice(voices, voiceKey(a), 'fr-FR').voice).toBe(a)
  voices = [c, b, a]; target.dispatchEvent(new Event('voiceschanged'))
  expect(resolveVoice(voices, voiceKey(a), 'fr-FR').voice).toBe(a)
  voices = [b]; target.dispatchEvent(new Event('voiceschanged'))
  expect(resolveVoice(voices, voiceKey(a), 'en-US')).toEqual({ voice: null, fallback: true, language: 'en-US' })
  dispose(); const count = update.mock.calls.length
  target.dispatchEvent(new Event('voiceschanged')); vi.advanceTimersByTime(10000)
  expect(update).toHaveBeenCalledTimes(count)
})
it('falls back in the missing selected voice language rather than the UI language', () => {
  const chosen = voice('French missing', 'fr-FR')
  const french = voice('French replacement', 'fr-CA'), english = voice('English')
  expect(resolveVoice([english, french], voiceKey(chosen), 'en-US').voice).toBe(french)
})
it('chooses the same automatic voice when a same-language list is reordered', () => {
  const a = voice('Alpha'), b = voice('Beta')
  expect(resolveVoice([b, a], undefined, 'en-US').voice).toBe(resolveVoice([a, b], undefined, 'en-US').voice)
})
it('uses a matching language and never arbitrary unrelated character voices', () => {
  const french = voice('French', 'fr-FR'), english = voice('English')
  expect(resolveVoice([french, english], undefined, 'en-GB').voice).toBe(english)
  expect(resolveVoice([french], undefined, 'en-GB').voice).toBeNull()
  expect(resolveVoice([], undefined, 'en-US')).toEqual({ voice: null, fallback: false, language: 'en-US' })
})
