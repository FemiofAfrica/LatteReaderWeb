export const voiceKey = (voice: SpeechSynthesisVoice): string =>
  JSON.stringify([voice.voiceURI, voice.name, voice.lang, voice.localService])

export function selectedVoiceLanguage(key: string | undefined, fallback: string): string {
  try {
    const identity: unknown = JSON.parse(key ?? 'null')
    if (Array.isArray(identity) && identity.length === 4 && typeof identity[2] === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(identity[2])) return identity[2]
  } catch { /* Older numeric indices or malformed identities use the explicit default. */ }
  return fallback
}
export interface VoiceChoice { voice: SpeechSynthesisVoice | null; fallback: boolean; language: string }
export function resolveVoice(voices: readonly SpeechSynthesisVoice[], key: string | undefined, language: string): VoiceChoice {
  if (!key) {
    // Browser default means the actual default English voice, not the first sorted name.
    const voice = voices.find(v => v.default && /^en(?:-|$)/i.test(v.lang ?? '')) ?? null
    return { voice, fallback: false, language: voice?.lang || (/^en(?:-|$)/i.test(language) ? language : 'en-US') }
  }
  const selected = key ? voices.find(v => voiceKey(v) === key) : undefined
  if (selected) return { voice: selected, fallback: false, language: selected.lang || language }
  language = selectedVoiceLanguage(key, language)
  const lang = language.toLowerCase().replace(/_/g, '-')
  const matches = voices.filter(v => (v.lang ?? '').toLowerCase().replace(/_/g, '-').split('-')[0] === lang.split('-')[0])
    .sort((a, b) => voiceKey(a).localeCompare(voiceKey(b)))
  // Do not substitute an unrelated language merely because it occupies index zero.
  const voice = matches.find(v => v.lang.toLowerCase() === lang && v.default)
    ?? matches.find(v => v.lang.toLowerCase() === lang)
    ?? matches.find(v => v.default) ?? matches[0] ?? null
  return { voice, fallback: Boolean(key), language }
}

export interface VoiceListState { voices: SpeechSynthesisVoice[]; status: 'loading' | 'ready' | 'empty' | 'unsupported' }
/** One mounted subscriber owns its event listener and bounded loading timer.
 * Keep listening after timeout: mobile platforms can publish voices much later. */
export function watchBrowserVoices(update: (state: VoiceListState) => void): () => void {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    update({ voices: [], status: 'unsupported' }); return () => undefined
  }
  const synth = window.speechSynthesis
  let expired = false
  const refresh = () => {
    const voices = [...new Map(synth.getVoices().map(v => [voiceKey(v), v])).values()]
      .sort((a, b) => voiceKey(a).localeCompare(voiceKey(b)))
    update({ voices, status: voices.length ? 'ready' : expired ? 'empty' : 'loading' })
  }
  synth.addEventListener?.('voiceschanged', refresh)
  refresh()
  const poll = window.setInterval(refresh, 250)
  const timeout = window.setTimeout(() => { expired = true; window.clearInterval(poll); refresh() }, 3000)
  return () => { synth.removeEventListener?.('voiceschanged', refresh); window.clearInterval(poll); window.clearTimeout(timeout) }
}
