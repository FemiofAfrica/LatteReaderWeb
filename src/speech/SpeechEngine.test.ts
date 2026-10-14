import { describe, expect, it, vi, beforeEach } from 'vitest'
import { BrowserSpeechEngine } from './SpeechEngine'
import { planSpeechChunks } from '../domain/speechPlan'
import { analyzeDocument } from '../domain/analysis'

let utterances: SpeechSynthesisUtterance[]
let cancel: ReturnType<typeof vi.fn>
beforeEach(() => {
  utterances = []; cancel = vi.fn()
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices: () => [{ name: 'Narrator' }, { name: 'Alice' }], cancel,
    speak: (u: SpeechSynthesisUtterance) => { utterances.push(u); u.onstart?.({} as SpeechSynthesisEvent) },
    pause: vi.fn(), resume: vi.fn(),
  } })
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class {
    text: string
    constructor(text: string) { this.text = text }
  } })
})
const end = () => utterances.at(-1)?.onend?.({} as SpeechSynthesisEvent)
describe('source-aware browser transport', () => {
  it('follows entered spans, not buffered pages, and cancels only once per run', () => {
    const engine = new BrowserSpeechEngine(); const onPage = vi.fn(); const done = vi.fn()
    engine.onEnd(done)
    engine.speak({ text: '', rate: 1, chunks: planSpeechChunks(['Five fine', 'friends find coffee.'], 1, 'document'), onPage })
    expect(utterances.map(u => u.text)).toEqual(['Five fine friends find coffee.'])
    expect(onPage.mock.calls).toEqual([[1]])
    utterances[0].onboundary?.({ charIndex: 10 } as SpeechSynthesisEvent)
    expect(onPage.mock.calls).toEqual([[1], [2]])
    end(); expect(done).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce()
    const followed = onPage.mock.calls.length
    end(); utterances[0].onboundary?.({ charIndex: 0 } as SpeechSynthesisEvent)
    expect(done).toHaveBeenCalledOnce(); expect(onPage.mock.calls).toHaveLength(followed)
  })
  it('bounds actual API inputs and waits at pause, resumes in place, rejects stale callbacks after stop', () => {
    const engine = new BrowserSpeechEngine(); const done = vi.fn(); engine.onEnd(done)
    const chunks = planSpeechChunks([('fine friends. ').repeat(20)], 1, 'page', null, 80)
    engine.speak({ text: '', rate: 1, chunks })
    engine.pause(); end(); expect(utterances).toHaveLength(1)
    engine.resume(); expect(utterances).toHaveLength(2)
    expect(utterances.every(u => u.text.length <= 80)).toBe(true)
    engine.stop(); end(); expect(utterances).toHaveLength(2); expect(done).not.toHaveBeenCalled()
  })
  it('stops on error instead of skipping unread text', () => {
    const engine = new BrowserSpeechEngine(); const fail = vi.fn()
    engine.speak({ text: 'fine', rate: 1, onError: fail })
    utterances[0].onerror?.({} as SpeechSynthesisErrorEvent)
    expect(fail).toHaveBeenCalledOnce(); expect(utterances).toHaveLength(1)
  })
  it('keeps real dialogue voice changes and page provenance', () => {
    const pages = ['ALICE: Fine.\nALICE: Five friends.', 'Narration follows.']
    const chunks = planSpeechChunks(pages, 1, 'document', analyzeDocument('fixture', 'fixture', pages))
    expect(chunks.map(c => c.text)).toEqual(['ALICE: Fine. ALICE: Five friends.', 'Narration follows.'])
    expect(chunks.map(c => c.voiceIndex)).toEqual([1, 0])
    expect(chunks[1].spans[0].pageNumber).toBe(2)
  })
  it('reports real boundaries, ignores invalid and stale positions after replacement and pause', () => {
    const engine = new BrowserSpeechEngine(); const position = vi.fn(); const onPage = vi.fn()
    engine.speak({ text: 'Same. Same.', rate: 1, onPosition: position, onPage })
    const old = utterances[0]
    expect(position.mock.calls).toEqual([[0, 0, 'utterance']])
    old.onboundary?.({ charIndex: 6 } as SpeechSynthesisEvent)
    expect(position.mock.calls.at(-1)).toEqual([0, 6, 'boundary'])
    engine.pause()
    const count = position.mock.calls.length, pages = onPage.mock.calls.length
    old.onboundary?.({ charIndex: 8 } as SpeechSynthesisEvent)
    expect(position).toHaveBeenCalledTimes(count); expect(onPage).toHaveBeenCalledTimes(pages)
    engine.resume()
    old.onboundary?.({ charIndex: NaN } as SpeechSynthesisEvent)
    old.onboundary?.({ charIndex: 100 } as SpeechSynthesisEvent)
    expect(position).toHaveBeenCalledTimes(count)
    engine.speak({ text: 'New.', rate: 1, onPosition: position })
    const replaced = position.mock.calls.length
    old.onboundary?.({ charIndex: 0 } as SpeechSynthesisEvent); old.onend?.({} as SpeechSynthesisEvent)
    expect(position).toHaveBeenCalledTimes(replaced)
    expect(utterances).toHaveLength(2)
  })
  it('selection preserves punctuation and ordinary f exactly', () => {
    const engine = new BrowserSpeechEngine()
    engine.speak({ text: '“Five fine friends.”', rate: 1 })
    expect(utterances[0].text).toBe('“Five fine friends.”')
  })
})
