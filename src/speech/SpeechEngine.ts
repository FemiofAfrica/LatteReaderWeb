import type { SpeechChunk } from '../domain/speechPlan'
import { planSpeechChunks } from '../domain/speechPlan'
import { recordEvent } from '../diagnostics/diagnostics'

export interface SpeechRequest {
  text: string
  rate: number
  chunks?: SpeechChunk[]
  onPage?: (page: number) => void
  onError?: () => void
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

  speak({ text, rate, chunks, onPage, onError }: SpeechRequest): void {
    this.stop() // once per user run, never between normal chunks
    const started = performance.now()
    recordEvent('speech.start')
    const generation = this.generation
    const segments = chunks ?? planSpeechChunks([text], 1, 'page')
    const voices = window.speechSynthesis.getVoices()
    let index = 0
    const next = () => {
      if (generation !== this.generation) return
      if (this.paused) { this.pendingNext = next; return }
      if (index >= segments.length) { this.generation += 1; recordEvent('speech.end', { durationMs: performance.now() - started }); this.ended(); return }
      const segment = segments[index++]
      const utterance = new SpeechSynthesisUtterance(segment.text)
      utterance.rate = rate
      utterance.voice = voices[segment.voiceIndex % Math.max(voices.length, 1)] ?? null
      let completed = false
      const follow = (offset: number) => {
        if (generation !== this.generation || completed) return
        const span = segment.spans.find(s => offset >= s.start && offset < s.end)
        if (span) onPage?.(span.pageNumber)
      }
      utterance.onstart = () => follow(0)
      utterance.onboundary = event => follow(event.charIndex)
      utterance.onend = () => {
        if (generation !== this.generation || completed) return
        // Voices without boundary events follow at completion, never while merely buffered.
        follow(Math.max(0, segment.text.length - 1)); completed = true; next()
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
