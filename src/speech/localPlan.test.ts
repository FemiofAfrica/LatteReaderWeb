import { describe, expect, it } from 'vitest'
import { localParts } from './localPlan'
import { planSpeechChunks } from '../domain/speechPlan'

describe('private narrator source bounds', () => {
  it('covers long words and repeated contractions without truncation', () => {
    const chunks = planSpeechChunks(["Don't repeat ﬁne. Don't repeat ﬁne. " + 'x'.repeat(900)], 1, 'document')
    const parts = localParts(chunks)
    for (let i = 0; i < chunks.length; i++) expect(parts.filter(p => p.chunk === i).map(p => p.text).join('')).toBe(chunks[i].text)
    expect(parts.every(p => p.text.length <= 250)).toBe(true)
    for (const p of parts) expect(chunks[p.chunk].text.slice(p.start,p.end)).toBe(p.text)
  })
  it('splits astral characters safely and keeps cross-page offsets', () => {
    const chunks = planSpeechChunks(['a'.repeat(249)+'😀 follows', 'next page.'],1,'document')
    const parts = localParts(chunks)
    expect(parts.map(p => p.text).join('')).toBe(chunks.map(c=>c.text).join(''))
    expect(parts.every(p=>!/[\uD800-\uDBFF]$/.test(p.text))).toBe(true)
    expect(parts.at(-1)?.pageEnd).toBe(2)
  })
})
