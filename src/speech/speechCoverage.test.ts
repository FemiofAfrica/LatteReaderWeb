import { describe, expect, it } from 'vitest'
import { planSpeechChunks } from '../domain/speechPlan'
import { localParts } from './localPlan'
import { readingTimeline } from '../domain/readingPosition'

function joinPages(pages: readonly string[]): string {
  return pages.filter(page => page.trim()).join(' ')
}

function plannedCoversSource(pages: readonly string[]) {
  const chunks = planSpeechChunks(pages, 1, 'document')
  const planned = chunks.map(chunk => chunk.text).join(' ')
  const source = joinPages(pages.map(page => page.replace(/\s+/g, ' ').trim()))
  const parts = localParts(chunks)
  const spoken = parts.map(part => part.text).join('')
  return { chunks, parts, planned, source, spoken, timeline: readingTimeline(chunks) }
}

describe('planned speech covers the source', () => {
  it('concatenated chunk texts cover the source document and local parts cover each chunk', () => {
    const pages = [
      'Hello world. This is a longer sentence that should stay intact.',
      'Second page continues the thought without dropping words.',
      'A final paragraph sits here.',
    ]
    const { chunks, parts, planned, source, spoken, timeline } = plannedCoversSource(pages)
    expect(planned.replace(/\s+/g, ' ').trim()).toBe(source.replace(/\s+/g, ' ').trim())
    expect(spoken).toBe(chunks.map(chunk => chunk.text).join(''))
    expect(timeline.text.replace(/\s+/g, ' ').trim()).toBe(planned.replace(/\s+/g, ' ').trim())
    for (let index = 0; index < chunks.length; index += 1) {
      const ofChunk = parts.filter(part => part.chunk === index)
      expect(ofChunk.map(part => part.text).join('')).toBe(chunks[index]!.text)
      for (let i = 1; i < ofChunk.length; i += 1) {
        expect(ofChunk[i]!.start).toBe(ofChunk[i - 1]!.end)
      }
      expect(ofChunk[0]?.start).toBe(0)
      expect(ofChunk.at(-1)?.end).toBe(chunks[index]!.text.length)
    }
  })

  it('keeps sentence halves adjacent when a long sentence is split at a word boundary', () => {
    const long = `${'word '.repeat(80)}end.`
    const { chunks, parts } = plannedCoversSource([long])
    const ofChunk = parts.filter(part => part.chunk === 0)
    expect(ofChunk.length).toBeGreaterThan(1)
    expect(ofChunk.map(part => part.text).join('')).toBe(chunks[0]!.text)
    for (let i = 1; i < ofChunk.length; i += 1) expect(ofChunk[i]!.start).toBe(ofChunk[i - 1]!.end)
  })

  it('does not drop punctuation, quotes or hyphenated wraps at chunk boundaries', () => {
    const { planned, parts, chunks } = plannedCoversSource(['“Fine.” A well-\nknown difference.', 'Next page starts here.'])
    expect(planned).toContain('“Fine.”')
    expect(planned).toContain('well-')
    expect(planned).toContain('Next page starts here.')
    expect(parts.map(part => part.text).join('')).toBe(chunks.map(chunk => chunk.text).join(''))
  })
})
