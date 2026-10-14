import { act, render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { VoiceChooser } from './VoiceChooser'
import { voiceKey } from '../speech/browserVoices'
afterEach(cleanup)
it('keeps a missing choice visible and restores it when delayed/reordered voices arrive', () => {
  const a = { voiceURI: 'same', name: 'English', lang: 'en-US', localService: true } as SpeechSynthesisVoice
  const b = { ...a, name: 'French', lang: 'fr-FR' } as SpeechSynthesisVoice
  const change = vi.fn()
  const { rerender } = render(<VoiceChooser label="Narrator voice" selected={voiceKey(a)} voices={[]} onChange={change} />)
  expect(screen.getByText(/Selected voice unavailable/)).toBeTruthy()
  rerender(<VoiceChooser label="Narrator voice" selected={voiceKey(a)} voices={[b, a]} onChange={change} />)
  expect((screen.getByLabelText('Narrator voice') as HTMLSelectElement).value).toBe(voiceKey(a))
  act(() => fireEvent.change(screen.getByLabelText('Narrator voice'), { target: { value: voiceKey(b) } }))
  expect(change).toHaveBeenCalledWith(voiceKey(b))
})
