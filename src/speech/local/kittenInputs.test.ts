import { describe, expect, it, vi } from 'vitest'
import { MAX_INPUT_IDS, SYMBOL_TABLE, kittenInputs, tokenizePhonemes } from './kittenInputs'

/** A stand-in for the pinned eSpeak-NG adapter: canned IPA, recorded input. */
const adapter = (ipa: Record<string, string> | string = {}) => {
  const calls: string[] = []
  const phonemize = vi.fn(async (text: string) => {
    calls.push(text)
    const line = typeof ipa === 'string' ? ipa : ipa[text] ?? 'həloʊ'
    return [line]
  })
  return { phonemize, calls }
}

describe('kitten micro inputs', () => {
  it('prefixes 0 and suffixes [10, 0] around the mapped symbols', async () => {
    const { phonemize } = adapter({ Hello: 'h' })
    const { ids } = await kittenInputs('Hello', phonemize)
    expect(ids[0]).toBe(0)
    expect(ids.slice(-2)).toEqual([10, 0])
    expect(ids.slice(1, -2)).toEqual([SYMBOL_TABLE.h])
  })

  it('keeps punctuation in the input instead of letting the phonemizer drop it', async () => {
    const { phonemize, calls } = adapter({ Hello: 'h', ' world': 'w' })
    const { ids } = await kittenInputs('Hello, world.', phonemize)
    // Punctuation is never sent to the phonemizer, and is re-inserted after it.
    // The tokeniser joins its tokens with a space, and the shipped table maps a
    // space to its own id, exactly as the audited pipeline did.
    expect(calls).toEqual(['Hello', ' world'])
    const space = SYMBOL_TABLE[' ']
    expect(ids.slice(1, -2)).toEqual([SYMBOL_TABLE.h, space, SYMBOL_TABLE[','], space, SYMBOL_TABLE.w, space, SYMBOL_TABLE['.']])
  })

  it('maps curly apostrophes to a straight one the model can represent', async () => {
    const { phonemize, calls } = adapter({ "don't": "d'nt" })
    const { ids } = await kittenInputs('don’t', phonemize)
    // The phonemizer sees a straight apostrophe, and the table has an id for it.
    expect(calls).toEqual(["don't"])
    expect(ids.slice(1, -2)).toEqual([SYMBOL_TABLE.d, SYMBOL_TABLE[' '], SYMBOL_TABLE["'"], SYMBOL_TABLE[' '], SYMBOL_TABLE.n, SYMBOL_TABLE.t])
  })

  it('keeps a decimal separator between digits and re-inserts straight quotes it strips for phonemisation', async () => {
    const { phonemize, calls } = adapter({ '3.14': 'θ' })
    await kittenInputs('3.14', phonemize)
    expect(calls).toEqual(['3.14'])
    // A curly quote is straightened for the phonemizer, kept as punctuation, and
    // re-inserted around the phonemes so nothing is silently dropped.
    const { phonemize: second, calls: secondCalls } = adapter({ Hi: 'h' })
    const { ids } = await kittenInputs('“Hi”', second)
    expect(secondCalls).toEqual(['Hi'])
    const space = SYMBOL_TABLE[' ']
    expect(ids.slice(1, -2)).toEqual([SYMBOL_TABLE['"'], space, SYMBOL_TABLE.h, space, SYMBOL_TABLE['"']])
  })

  it('tokenises runs, punctuation and spaces the way the audited pipeline does', () => {
    // Letters in a run stay together (as Python's `\w+` does); punctuation and
    // whitespace separate tokens, which is what the model was trained on.
    expect(tokenizePhonemes('həˈloʊ')).toBe('həˈloʊ')
    expect(tokenizePhonemes('həˈloʊ, wɜːld!')).toBe('həˈloʊ , wɜːld !')
    expect(tokenizePhonemes('a  b')).toBe('a b')
  })

  it('refuses an unknown phoneme rather than dropping the word', async () => {
    const { phonemize } = adapter('⚡')
    await expect(kittenInputs('Hello', phonemize)).rejects.toThrow('UNKNOWN_PHONEMES')
  })

  it('refuses a request over the policy bound so the caller can split it', async () => {
    const { phonemize } = adapter('h'.repeat(MAX_INPUT_IDS + 10))
    await expect(kittenInputs('x'.repeat(MAX_INPUT_IDS), phonemize)).rejects.toThrow('TOKEN_LIMIT')
  })

  it('chooses the style row by code points, not by UTF-16 length', async () => {
    const { phonemize } = adapter('h')
    // 300 code points, 350 UTF-16 units: the pinned rule uses the code points.
    const astral = '😀'.repeat(50) + 'a'.repeat(250)
    expect(astral.length).toBe(350)
    expect((await kittenInputs(astral, phonemize)).styleRow).toBe(300)
    // Above 399 rows the pinned pipeline clamps to the last row it has.
    const { phonemize: long } = adapter('h')
    expect((await kittenInputs('a'.repeat(1200), long)).styleRow).toBe(399)
  })

  it('ships the audited symbol table, duplicates included', () => {
    // Last occurrence wins in the shipped table, so a repeated key resolves to
    // one id rather than an accidental second mapping.
    expect(SYMBOL_TABLE['h']).toBeGreaterThanOrEqual(0)
    expect(SYMBOL_TABLE['.']).toBe(4)
    expect(SYMBOL_TABLE['—']).toBe(9)
    expect(Object.keys(SYMBOL_TABLE).length).toBeGreaterThan(100)
  })
})
