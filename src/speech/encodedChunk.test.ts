import { describe, expect, it } from 'vitest'
import { cacheId, encodedKey, passageKey } from './encodedChunk'
import type { LocalPart } from './localPlan'

const part = (page: number, text: string, chunk = 0): LocalPart => ({
  text, chunk, start: 0, end: text.length, page, pageEnd: page,
})

describe('passage cache identity', () => {
  it('keys clips by document, page, text and voice, not the local chunk index', () => {
    const one = part(1, 'This is page one!!')
    const two = part(2, 'This is page two!!')
    expect(encodedKey(one)).toBe(encodedKey({ ...two, chunk: 0 }))
    expect(passageKey(one)).not.toBe(passageKey(two))
    expect(cacheId('doc', 'natural', 1, one)).not.toBe(cacheId('doc', 'natural', 1, two))
    expect(cacheId('doc', 'natural', 1, one)).not.toBe(cacheId('doc', 'other-voice', 1, one))
    expect(cacheId('doc', 'natural', 1, one)).not.toBe(cacheId('other-doc', 'natural', 1, one))
    expect(cacheId('doc', 'natural', 1, one)).not.toBe(cacheId('doc', 'natural', 1.25, one))
    expect(cacheId('doc', 'natural', 1, { page: one.page, text: one.text })).toBe(cacheId('doc', 'natural', 1, one))
  })
})
