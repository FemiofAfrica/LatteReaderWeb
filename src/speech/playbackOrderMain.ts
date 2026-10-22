import { planSpeechChunks } from '../domain/speechPlan'
import { localParts } from './localPlan'
import { AudioCache } from './audioCache'
import { createPlaybackAudio } from './htmlAudioQueue'
import { LocalNarratorEngine } from './LocalNarratorEngine'
import type { LoadableProducer, ProducedAudio } from './chunkProducer'

export const SENTENCE_COUNT = 90
export const SENTENCE_SECONDS = 1
export const SAMPLE_RATE = 24000

class ToneProducer implements LoadableProducer {
  readonly id = 'playback-order-stub'
  readonly label = 'Stub'
  downloadedFiles = 0
  prepared = true
  async prepare() { return 'ready' as const }
  dispose() {}
  async generate(text: string): Promise<ProducedAudio> {
    const match = /\b(\d{2})\b/.exec(text)
    const index = match ? Number(match[1]) : 0
    const samples = SENTENCE_SECONDS * SAMPLE_RATE
    const pcm = new Float32Array(samples)
    const freq = 220 + (index % 40) * 18
    for (let i = 0; i < samples; i += 1) pcm[i] = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 0.12
    return { pcm, sampleRate: SAMPLE_RATE }
  }
}

export interface PlaybackOrderLog {
  heard: number[]
  events: Array<{
    at: number
    currentTime: number
    loop: boolean
    paused: boolean
    ended: boolean
    hidden: boolean
    src: string
  }>
  startedAt: number | null
  finished: boolean
  error: string | null
}

function sentences(): string[] {
  return Array.from({ length: SENTENCE_COUNT }, (_, index) => `Sentence ${String(index).padStart(2, '0')} is unique.`)
}

function partIndex(parts: ReturnType<typeof localParts>, chunk: number, start: number): number {
  return parts.findIndex(part => part.chunk === chunk && part.start === start)
}

declare global {
  interface Window {
    __playback?: PlaybackOrderLog
    __playbackPlay?: () => void
    __playbackAudio?: HTMLAudioElement
    __playbackParts?: number
  }
}

export function installPlaybackOrderHarness(root: Document = document): PlaybackOrderLog {
  const log: PlaybackOrderLog = { heard: [], events: [], startedAt: null, finished: false, error: null }
  const pages = [sentences().join(' ')]
  const chunks = planSpeechChunks(pages, 1, 'document')
  const parts = localParts(chunks)
  const audio = createPlaybackAudio()
  const producer = new ToneProducer()
  const engine = new LocalNarratorEngine(() => { /* status */ }, {
    producer,
    cache: new AudioCache(),
    createAudio: () => audio,
    lookaheadSeconds: 300,
    maxBufferedSeconds: 400,
  })
  engine.onEnd(() => { log.finished = true })

  const sample = () => {
    log.events.push({
      at: Math.round(performance.now()),
      currentTime: audio.currentTime || 0,
      loop: audio.loop,
      paused: audio.paused,
      ended: audio.ended,
      hidden: document.hidden,
      src: audio.currentSrc || audio.src,
    })
  }

  const play = () => {
    log.heard.length = 0
    log.events.length = 0
    log.finished = false
    log.error = null
    log.startedAt = Math.round(performance.now())
    engine.speak({
      text: '',
      rate: 1,
      documentId: 'playback-order',
      title: 'Playback order',
      chunks,
      onPosition: (chunk, start, kind) => {
        if (kind !== 'audio-chunk') return
        const index = partIndex(parts, chunk, start)
        if (index < 0) return
        if (log.heard.at(-1) === index) return
        log.heard.push(index)
      },
      onPage: () => { /* unused */ },
      onError: () => { log.error = 'engine-error' },
    })
    sample()
  }

  const button = root.getElementById('play')
  button?.addEventListener('click', play)
  setInterval(sample, 250)
  Object.assign(window, { __playback: log, __playbackPlay: play, __playbackAudio: audio, __playbackParts: parts.length })
  const status = root.getElementById('status')
  if (status) setInterval(() => { status.textContent = JSON.stringify({ heard: log.heard, loop: audio.loop, hidden: document.hidden, time: audio.currentTime }) }, 500)
  return log
}

if (typeof document !== 'undefined' && document.getElementById('play')) installPlaybackOrderHarness()
