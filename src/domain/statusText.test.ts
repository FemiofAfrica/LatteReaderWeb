import { describe, expect, it } from 'vitest'
import { readingStatusText, localVoiceCopy, narratorNoticeCopy, type ReadingStatusInput } from './statusText'

const base: ReadingStatusInput = {
  extraction: 'complete',
  pagesWithReadableText: 12,
  engine: 'local',
  localStatus: 'off',
  voiceAvailable: false,
  playback: { status: 'ready', display: 'Ready' },
}

const input = (overrides: Partial<ReadingStatusInput>): ReadingStatusInput => ({ ...base, ...overrides })

describe('reading status', () => {
  it('reports the local model load as loading, never as unavailable', () => {
    const status = readingStatusText(input({ localStatus: 'preparing', voiceAvailable: false }))
    expect(status).toBe('Preparing voice…')
    expect(status).not.toBe('Voice unavailable')
  })

  it('keeps buffering ahead of the preparing copy', () => {
    expect(readingStatusText(input({ localStatus: 'buffering', voiceAvailable: true }))).toBe('Preparing reading…')
  })

  it('reports Voice unavailable for a failed local voice and for the browser with no usable voice', () => {
    expect(readingStatusText(input({ localStatus: 'error', voiceAvailable: false }))).toBe('Voice unavailable')
    expect(readingStatusText(input({ engine: 'browser', localStatus: 'off', voiceAvailable: false }))).toBe('Voice unavailable')
  })

  it('never says Voice unavailable while the local voice is loading, in any playback state', () => {
    for (const playback of [
      { status: 'ready' as const, display: 'Ready' as const },
      { status: 'ready' as const, display: 'Stopped' as const },
      { status: 'playing' as const, display: 'Reading' as const },
      { status: 'ready' as const, display: 'Finished' as const },
    ]) {
      expect(readingStatusText(input({ localStatus: 'preparing', voiceAvailable: false, playback }))).toBe('Preparing voice…')
      expect(readingStatusText(input({ localStatus: 'buffering', voiceAvailable: false, playback }))).toBe('Preparing reading…')
    }
  })

  it('invites playback once a loaded local voice sits idle', () => {
    expect(readingStatusText(input({ localStatus: 'ready', voiceAvailable: true }))).toBe('Press play to begin')
    expect(readingStatusText(input({ localStatus: 'ready', voiceAvailable: true, playback: { status: 'ready', display: 'Stopped' } }))).toBe('Press play to begin')
  })

  it('never replaces a real playback status with the invitation', () => {
    expect(readingStatusText(input({ localStatus: 'ready', voiceAvailable: true, playback: { status: 'playing', display: 'Reading' } }))).toBe('Reading')
    expect(readingStatusText(input({ localStatus: 'ready', voiceAvailable: true, playback: { status: 'paused', display: 'Paused' } }))).toBe('Paused')
    expect(readingStatusText(input({ localStatus: 'ready', voiceAvailable: true, playback: { status: 'ready', display: 'Finished' } }))).toBe('Finished')
    expect(readingStatusText(input({ localStatus: 'preparing', voiceAvailable: false }))).not.toBe('Press play to begin')
  })

  it('leaves the browser engine on its own idle wording', () => {
    expect(readingStatusText(input({ engine: 'browser', voiceAvailable: true, playback: { status: 'ready', display: 'Ready' } }))).toBe('Ready')
    expect(readingStatusText(input({ engine: 'browser', voiceAvailable: true, playback: { status: 'ready', display: 'Stopped' } }))).toBe('Stopped')
  })

  it('lets a failed extraction outrank the voice state', () => {
    expect(readingStatusText(input({ extraction: 'error', localStatus: 'preparing' }))).toBe('Could not read the text')
  })

  it('keeps the browser engine reading from the playback display', () => {
    expect(readingStatusText(input({ engine: 'browser', voiceAvailable: true }))).toBe('Ready')
    expect(readingStatusText(input({ engine: 'browser', voiceAvailable: true, playback: { status: 'playing', display: 'Reading' } }))).toBe('Reading')
    expect(readingStatusText(input({ engine: 'browser', voiceAvailable: true, playback: { status: 'ready', display: 'Stopped' } }))).toBe('Stopped')
  })

  it('reports a document with no readable text', () => {
    expect(readingStatusText(input({ pagesWithReadableText: 0, voiceAvailable: true }))).toBe('No readable text')
  })
})

describe('local narrator panel copy', () => {
  it('explains the model load in plain words', () => {
    expect(localVoiceCopy('preparing')).toBe('Preparing voice… This may take a minute.')
  })

  it('keeps the existing ready and error copy', () => {
    expect(localVoiceCopy('ready')).toBe('Press play to begin')
    expect(localVoiceCopy('error')).toBe('Could not use this voice. Try again or choose Browser voice.')
    expect(localVoiceCopy('off')).toBe('Download the voice to begin')
    for (const status of ['off','preparing','ready','buffering','playing','paused','error'] as const) expect(localVoiceCopy(status)).not.toMatch(/Local|buffer|engine|chunk|Jasper/i)
  })

  it('tells the reader a passage continued without naming the engine', () => {
    expect(narratorNoticeCopy()).toBe('Some of this passage could not be spoken. Reading continued. Switch to Browser voice if you need it read.')
    expect(narratorNoticeCopy()).not.toMatch(/Local|buffer|engine|chunk|Jasper|Misaki|token|unsupported/i)
  })
})
