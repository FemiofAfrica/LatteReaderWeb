import { voiceKey } from '../speech/browserVoices'
export function VoiceChooser({ label, selected, voices, onChange, automaticLabel = 'Automatic (browser language)' }: { label: string; selected?: string; voices: SpeechSynthesisVoice[]; automaticLabel?: string; onChange: (key: string | undefined) => void }) {
  const missing = Boolean(selected) && !voices.some(v => voiceKey(v) === selected)
  return <label className="voice-choice">{label}
    <select aria-label={label} value={selected ?? ''} onChange={event => onChange(event.target.value || undefined)}>
      <option value="">{automaticLabel}</option>
      {missing && <option value={selected}>Selected voice unavailable</option>}
      {voices.map(voice => <option key={voiceKey(voice)} value={voiceKey(voice)}>{voice.name} ({voice.lang}){voice.localService ? ' · device' : ' · browser service'}</option>)}
    </select>
    {missing && <small>Your choice is not available. Reading uses the automatic voice until it returns.</small>}
  </label>
}
