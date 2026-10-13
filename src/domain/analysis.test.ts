import { describe, expect, it } from 'vitest'
import { analyzeDocument, chunkText, segmentPages } from './analysis'

describe('document analysis', () => {
  it('segments blocks and classifies labels, dialogue, headings, and narration', () => {
    const segments = segmentPages([
      'CHAPTER ONE\nALICE: We should begin.\n"I agree," Alice said.\nThe room became quiet.',
    ])

    expect(segments.map(({ kind }) => kind)).toEqual([
      'heading',
      'explicitSpeaker',
      'dialogue',
      'narrator',
    ])
    expect(segments.every(({ pageNumber }) => pageNumber === 1)).toBe(true)
  })

  it('detects at most five speakers plus narrator and assigns explicit labels', () => {
    const pages = [
      'ALICE: One.\nALICE: Two.\nBOB: Three.\nBOB: Four.\nCAROL: Five.\nCAROL: Six.\nDAN: Seven.\nDAN: Eight.\nERIN: Nine.\nERIN: Ten.\nFRANK: Eleven.\nFRANK: Twelve.',
    ]
    const plan = analyzeDocument('fixture', 'fixture.pdf', pages)

    expect(plan.schemaVersion).toBe(1)
    expect(plan.profiles.map(({ displayName }) => displayName)).toEqual([
      'Narrator',
      'Alice',
      'Bob',
      'Carol',
      'Dan',
      'Erin',
    ])
    expect(plan.segments[0]).toMatchObject({ speakerId: 'alice', confidence: 0.95 })
  })

  it('falls back to narrator for weak or blocked names', () => {
    const plan = analyzeDocument('fixture', 'fixture.pdf', [
      'CHAPTER: A beginning.\n"Hello," she said.\nThe wind moved through the trees.',
    ])

    expect(plan.profiles).toHaveLength(1)
    expect(plan.segments.every(({ speakerId }) => speakerId === 'narrator')).toBe(true)
  })
})

describe('speech chunks', () => {
  it('normalizes PDF line wrapping and keeps chunks under the maximum', () => {
    expect(chunkText('A wrapped\nline. A second sentence!', 20)).toEqual([
      'A wrapped line.',
      'A second sentence!',
    ])
  })

  it('returns no chunks for blank text', () => {
    expect(chunkText(' \n ')).toEqual([])
  })
})
