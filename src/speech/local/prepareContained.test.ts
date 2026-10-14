import {describe,expect,it,vi} from 'vitest'
import {containedPrepare,MAX_REPAIR_ATTEMPTS,type PreparedText} from './prepareContained'

/** A stand-in frontend that refuses exactly the units it is told to refuse, with the
 * accepted scanner's unit shape: punctuation stands alone, words are word units. */
function frontend({ refuses = [] as string[], throwsOn = [] as string[], length = 400 } = {}) {
  const SCANNER = /[;:,.!?¡¿—–…"«»“”(){}[\]-]|\d+|[A-Za-z]+(?:['’][A-Za-z]+)*|\S/g
  return vi.fn((text: string): PreparedText => {
    if (throwsOn.some(token => text.includes(token))) throw Error('UNSUPPORTED_TEXT')
    const units: PreparedText['units'] = []
    const unknown: PreparedText['unknown'] = []
    const unsupported: string[] = []
    for (const match of text.matchAll(SCANNER)) {
      const raw = match[0]
      const start = match.index!
      const unit = { raw, start, end: start + raw.length }
      if (refuses.includes(raw)) {
        unknown.push(unit)
        units.push({ ...unit, kind: 'lexical', phones: [''] })
      } else if (/[()]/.test(raw)) {
        unsupported.push(raw)
        units.push({ ...unit, kind: 'punctuation', phones: [raw] })
      } else {
        units.push({ ...unit, kind: /^[A-Za-z]/.test(raw) ? 'lexical' : 'punctuation', phones: ['x'] })
      }
    }
    return { ok: unknown.length === 0 && unsupported.length === 0, tokenLimitExceeded: text.length > length, ids: [0, 1, 10, 0],
      styleRow: Math.min([...text].length, 399), units, unknown, unsupported, sourceUnits: units.length, coveredUnits: units.length - unknown.length }
  })
}

describe('a part is never refused because of one unit',()=>{
  it('keeps the passage when a bracket the model cannot say appears in it',()=>{
    const prep = frontend()
    const result = containedPrepare(' (Wrong way round, wrong way round, there!', prep)
    expect(result.ok).toBe(true)
    expect(result.contained).toBe(true)
    expect(result.dropped).toBe(0)
    expect(prep.mock.calls.at(-1)![0]).toBe(' Wrong way round, wrong way round, there!')
    expect(result.omissions.map(o=>[o.raw,o.kind])).toEqual([['(','silent-punctuation']])
  })
  it('keeps the accepted style rule: the style row follows the original text, not the repair',()=>{
    // The repair is two characters shorter here; a style row taken from it would move the voice.
    const long = 'x'.repeat(398)
    const result = containedPrepare(`(${long})`, frontend())
    expect(result.styleRow).toBe(399)
  })
  it('reports what it dropped so nothing is lost silently',()=>{
    const result = containedPrepare('police o\uFFFdcers arrived', frontend({ refuses: ['\uFFFD'] }))
    expect(result.contained).toBe(true)
    expect(result.dropped).toBe(1)
    expect(result.omissions[0]).toMatchObject({kind:'dropped',raw:'\uFFFD'})
  })
  it('answers a token-budget refusal with TOKEN_LIMIT, which the engine splits at a word boundary',()=>{
    const result = containedPrepare('short text here', frontend({ length: 5 }))
    expect(result.tokenLimitExceeded).toBe(true)
  })
  it('finds the offending token when the frontend refuses the whole text before naming a unit',()=>{
    const prep = frontend({ throwsOn: ['9/11'] })
    const result = containedPrepare('It happened on 9/11 that year.', prep)
    expect(result.ok).toBe(true)
    expect(result.omissions[0]).toMatchObject({raw:'9/11',kind:'spelling',spokenAs:'nine slash one one'})
  })
  it('reports a part it cannot repair at all as refused, so the engine skips only that part',()=>{
    const result = containedPrepare('\uFFFD\uFFFD\uFFFD', frontend({ refuses: ['\uFFFD'] }))
    expect(result.ok).toBe(false)
    expect(result.tokenLimitExceeded).toBe(false)
    // Adjacent identical refusals are one span; the engine still refuses the part.
    expect(result.dropped).toBe(1)
    expect(result.omissions[0].raw).toBe('\uFFFD\uFFFD\uFFFD')
  })
  it('stops re-checking after the documented bound instead of spending the run on one part',()=>{
    const prep = frontend({ throwsOn: ['9/11'] })
    containedPrepare('9/11 and 9/11 and 9/11', prep)
    expect(prep.mock.calls.length).toBeLessThanOrEqual(MAX_REPAIR_ATTEMPTS + 1 + 3)
  })
  it('leaves a readable passage exactly as it was',()=>{
    const result = containedPrepare('Nothing odd here at all.', frontend())
    expect(result.ok).toBe(true)
    expect(result.contained).toBe(false)
    expect(result.omissions).toEqual([])
  })
})
