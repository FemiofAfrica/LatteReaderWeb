import { resolveVoice } from './browserVoices'
import type { SpeechChunk } from '../domain/speechPlan'
import { planSpeechChunks } from '../domain/speechPlan'
import { recordEvent } from '../diagnostics/diagnostics'

export interface SpeechRequest {
  text: string
  rate: number
  voiceKey?: string
  language?: string
  onVoiceFallback?: (fallback: boolean) => void
  chunks?: SpeechChunk[]
  onPosition?: (chunk: number, offset: number, evidence: 'boundary' | 'utterance' | 'audio-chunk', end?: number) => void
  onPage?: (page: number) => void
  onError?: () => void
}
/** One spoken utterance: a slice of a planned chunk, with spans relative to the slice. */
export interface PageUtterance { chunk: number; base: number; segment: SpeechChunk }

/**
 * Split each planned chunk where its page changes, so every utterance starts on the page
 * it reads. Many browser voices (Chrome's online Google voices, Android) send no word
 * boundary events, only start and end; with one 1,200-character utterance running across
 * a page break, the visible page could only change when that whole utterance ended, long
 * after the narration had moved on. A sentence that runs over the break stays whole and
 * the next utterance starts after it, the same rule the Natural voice follows.
 */
export function pageUtterances(chunks: readonly SpeechChunk[], sentenceSlack = 300): PageUtterance[] {
  return chunks.flatMap((chunk, index) => {
    const cuts: number[] = []
    let last = 0
    chunk.spans.forEach((span, i) => {
      if (i === 0 || span.pageNumber === chunk.spans[i - 1].pageNumber) return
      let cut = span.start
      if (!/[.!?][”’"')\]]*\s*$/.test(chunk.text.slice(0, cut))) {
        const end = /[.!?][”’"')\]]*(?=\s|$)/.exec(chunk.text.slice(cut, cut + sentenceSlack))
        if (end) cut += end.index + end[0].length
      }
      while (chunk.text[cut] === ' ') cut++
      if (cut > last && cut < chunk.text.length) { cuts.push(cut); last = cut }
    })
    if (!cuts.length) return [{ chunk: index, base: 0, segment: chunk }]
    return [0, ...cuts].map((start, i) => {
      const end = cuts[i] ?? chunk.text.length
      let textEnd = end
      while (textEnd > start && chunk.text[textEnd - 1] === ' ') textEnd--
      return { chunk: index, base: start, segment: { ...chunk, text: chunk.text.slice(start, textEnd), source: chunk.source?.slice(start, textEnd),
        spans: chunk.spans.filter(s => s.end > start && s.start < textEnd).map(s => ({ pageNumber: s.pageNumber, start: Math.max(s.start, start) - start, end: Math.min(s.end, textEnd) - start })) } }
    })
  })
}

export interface SpeechEngine {
  readonly id: string
  readonly label: string
  readonly available: boolean
  speak(request: SpeechRequest): void
  pause(): void
  resume(): void
  stop(): void
  onEnd(callback: () => void): void
}

export class BrowserSpeechEngine implements SpeechEngine {
  readonly id = 'browser-speech'
  readonly label = 'Browser voice'
  private ended: () => void = () => undefined
  private generation = 0
  private paused = false
  private pendingNext: (() => void) | null = null
  get available(): boolean { return typeof window !== 'undefined' && 'speechSynthesis' in window }
  onEnd(callback: () => void): void { this.ended = callback }

  speak({ text, rate, chunks, onPage, onPosition, onError, voiceKey, language = navigator.language, onVoiceFallback }: SpeechRequest): void {
    this.stop() // once per user run, never between normal chunks
    const started = performance.now()
    recordEvent('speech.start')
    const generation = this.generation
    const segments = pageUtterances(chunks ?? planSpeechChunks([text], 1, 'page'))
    let index = 0
    const next = () => {
      if (generation !== this.generation) return
      if (this.paused) { this.pendingNext = next; return }
      if (index >= segments.length) { this.generation += 1; recordEvent('speech.end', { durationMs: performance.now() - started }); this.ended(); return }
      const { chunk: chunkIndex, base, segment } = segments[index++]
      const utterance = new SpeechSynthesisUtterance(segment.text)
      utterance.rate = rate
      const choice = resolveVoice(window.speechSynthesis.getVoices(), segment.voiceKey ?? voiceKey, language)
      utterance.voice = choice.voice
      utterance.lang = choice.voice?.lang || choice.language
      onVoiceFallback?.(choice.fallback)
      let completed = false
      const follow = (offset: number, evidence: 'boundary' | 'utterance') => {
        if (generation !== this.generation || completed) return
        if (!Number.isFinite(offset) || offset < 0 || offset >= segment.text.length) return
        if (!this.paused) onPosition?.(chunkIndex, base + offset, evidence)
        const span = segment.spans.find(s => offset >= s.start && offset < s.end)
        if (span && !this.paused) onPage?.(span.pageNumber)
      }
      utterance.onstart = () => follow(0, 'utterance')
      utterance.onboundary = event => follow(event.charIndex, 'boundary')
      utterance.onend = () => {
        if (generation !== this.generation || completed) return
        // Voices without boundary events follow at completion, never while merely buffered.
        follow(Math.max(0, segment.text.length - 1), 'utterance'); completed = true; next()
      }
      const fail = () => {
        if (generation !== this.generation || completed) return
        completed = true
        recordEvent('speech.error', { errorCode: 'speech' })
        this.stop(); onError?.()
      }
      utterance.onerror = fail
      try { window.speechSynthesis.speak(utterance) } catch { fail() }
    }
    next()
  }
  pause(): void { this.paused = true; recordEvent('speech.pause'); window.speechSynthesis.pause() }
  resume(): void {
    this.paused = false; recordEvent('speech.resume'); window.speechSynthesis.resume()
    const next = this.pendingNext; this.pendingNext = null; next?.()
  }
  stop(): void {
    recordEvent('speech.stop'); this.generation += 1; this.paused = false; this.pendingNext = null
    if (this.available) window.speechSynthesis.cancel()
  }
}
