import type { DocumentVoicePlan } from '../domain/analysis'

export interface SpeechRequest {
  text: string
  rate: number
  plan?: DocumentVoicePlan | null
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

  get available(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
  }

  onEnd(callback: () => void): void {
    this.ended = callback
  }

  speak({ text, rate, plan }: SpeechRequest): void {
    this.stop()
    const generation = this.generation
    const segments = plan?.segments.length
      ? plan.segments.map((segment) => ({
          text: segment.text,
          voiceIndex: plan.profiles.find((profile) => profile.id === segment.speakerId)?.voiceIndex ?? 0,
        }))
      : [{ text, voiceIndex: 0 }]
    const voices = window.speechSynthesis.getVoices()
    let index = 0
    const next = () => {
      if (generation !== this.generation || index >= segments.length) {
        if (generation === this.generation) this.ended()
        return
      }
      const segment = segments[index++]
      const utterance = new SpeechSynthesisUtterance(segment.text)
      utterance.rate = rate
      utterance.voice = voices[segment.voiceIndex % Math.max(voices.length, 1)] ?? null
      utterance.onend = next
      utterance.onerror = next
      window.speechSynthesis.speak(utterance)
    }
    next()
  }

  pause(): void { window.speechSynthesis.pause() }
  resume(): void { window.speechSynthesis.resume() }
  stop(): void {
    this.generation += 1
    if (this.available) window.speechSynthesis.cancel()
  }
}
