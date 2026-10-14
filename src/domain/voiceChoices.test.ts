import { expect, it } from 'vitest'
import { analyzeDocument, retainVoiceChoices } from './analysis'
it('reanalyzes source without dropping saved per-character voice identities', () => {
  const pages = ['ALICE: One.\nALICE: Two.']
  const old = analyzeDocument('id', 'owned', pages)
  old.profiles[1].voiceKey = 'saved-stable-identity'
  old.profiles[1].enabled = false
  const refreshed = retainVoiceChoices(analyzeDocument('id', 'owned', pages), old)
  expect(refreshed.profiles[1].voiceKey).toBe('saved-stable-identity')
  expect(refreshed.profiles[1].enabled).toBe(false)
  expect(refreshed.segments).toEqual(analyzeDocument('id', 'owned', pages).segments)
})
