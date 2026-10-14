import {describe,expect,it} from 'vitest'
import {countDropped,planRepair,spellUnit,SPELL_MAX,type Refusal} from './containment'

const unit=(text:string,raw:string)=>({start:text.indexOf(raw),end:text.indexOf(raw)+raw.length,raw})
const refusal=(text:string,unknown:string[],symbols:string[]=[]):Refusal=>({
  text,wholeText:false,unknown:unknown.map(raw=>unit(text,raw)),symbolUnits:symbols.map(raw=>unit(text,raw)),
})

describe('smallest-unit repair for a refused part',()=>{
  it('keeps every other word when one bracket is unsupported by the model',()=>{
    // The observed defect: "(" is forwarded as a phone the model has no symbol for, and the
    // whole 54-character part used to be refused because of it.
    const text=' (Wrong way round, wrong way round, wrong way round, there!'
    const repair=planRepair(refusal(text,[],['(']))!
    expect(repair.text.replace(/\s+/g,' ').trim()).toBe('Wrong way round, wrong way round, wrong way round, there!')
    expect(repair.omissions).toHaveLength(1)
    expect(repair.omissions[0]).toMatchObject({raw:'(',kind:'silent-punctuation'})
    expect(countDropped(repair.omissions)).toBe(0)
  })
  it('removes both brackets of a parenthetical without touching the words between them',()=>{
    const text='Then the negotiator (who had been dispatched) arrived.'
    const repair=planRepair(refusal(text,[],['(',')']))!
    expect(repair.text).toBe('Then the negotiator who had been dispatched arrived.')
    expect(repair.omissions.map(o=>[o.raw,o.kind])).toEqual([['(','silent-punctuation'],[')','silent-punctuation']])
  })
  it('reads an ellipsis as a pause instead of refusing the passage that contains it',()=>{
    const text='But now I need to ask… well, a few questions.'
    const repair=planRepair(refusal(text,['…']))!
    expect(repair.text).toBe('But now I need to ask\u2014 well, a few questions.')
    expect(repair.omissions[0]).toMatchObject({raw:'…',kind:'pause-mark'})
    expect(countDropped(repair.omissions)).toBe(0)
  })
  it('reads a standalone quotation mark as no sound at all, not as a dropped word',()=>{
    const text='She said ‘hello’ and left.'
    const repair=planRepair(refusal(text,['‘','’']))!
    expect(repair.text).toBe('She said hello and left.')
    expect(countDropped(repair.omissions)).toBe(0)
  })
  it('reads a symbol by its conventional spoken form and reports the substitution',()=>{
    const repair=planRepair(refusal('Simon & Schuster',['&']))!
    expect(repair.text).toBe('Simon and Schuster')
    expect(repair.omissions[0]).toMatchObject({raw:'&',kind:'spoken-form',spokenAs:'and'})
  })
  it('reads an ambiguous numeric token by its characters rather than refusing the passage',()=>{
    const text='The score was 1/2 at 3:30.'
    const repair=planRepair(refusal(text,['1/2','3:30']))!
    expect(repair.text).toBe('The score was one slash two at three colon three zero.')
    expect(repair.omissions.map(o=>o.kind)).toEqual(['spelling','spelling'])
  })
  it('spells a word the learned fallback gave up on',()=>{
    const repair=planRepair(refusal('a Schusssschfnurschulle appears',['Schusssschfnurschulle']))!
    expect(repair.text).toContain('S C H U S S S S C H F N U R S C H U L L E')
    expect(repair.omissions[0]).toMatchObject({kind:'spelling'})
    expect(countDropped(repair.omissions)).toBe(0)
  })
  it('drops only the character with no spoken form inside a word, and reports it',()=>{
    const text='police o\uFFFdcers arrived'
    const repair=planRepair(refusal(text,['\uFFFD']))!
    expect(repair.text).toBe('police ocers arrived')
    expect(repair.omissions[0]).toMatchObject({raw:'\uFFFD',kind:'dropped'})
    expect(countDropped(repair.omissions)).toBe(1)
  })
  it('never glues two words together when it removes punctuation between them',()=>{
    const repair=planRepair(refusal('negotiator(who arrived',[],['(']))!
    expect(repair.text).toBe('negotiator who arrived')
  })
  it('refuses nothing when the text was perfectly readable',()=>{
    expect(planRepair({text:'All fine here.',unknown:[],symbolUnits:[],wholeText:false})).toBeNull()
  })
})

describe('spelled readings stay bounded and honest',()=>{
  it('spells digits, letters and named symbols',()=>{
    expect(spellUnit('12:30')).toBe('one two colon three zero')
    expect(spellUnit('A9')).toBe('A nine')
    expect(spellUnit('©')).toBe('copyright')
  })
  it('returns null rather than inventing a sound for a character with no name',()=>{
    expect(spellUnit('\uFFFD')).toBeNull()
    expect(spellUnit('東京')).toBeNull()
  })
  it('refuses to spell a token longer than the documented bound',()=>{
    expect(spellUnit('x'.repeat(SPELL_MAX))).toBe('X '.repeat(SPELL_MAX-1).trim()+' X')
    expect(spellUnit('x'.repeat(SPELL_MAX+1))).toBeNull()
  })
})
