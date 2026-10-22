import type { PackedSegment, PackedSlice } from './audioPack'
import { encodeWav } from './wav'
import { MEDIA_NOTIFICATION_SECONDS } from './chunkProducer'

export interface HtmlAudioHooks {
  onSlice: (slice: PackedSlice) => void
  onSegmentEnd?: (segment: PackedSegment) => void
  onIdle: () => void
  onError: () => void
  onTime?: (position: number, slice: PackedSlice | null) => void
}

let cachedSilence = ''

function silenceUrl(): string {
  if (cachedSilence) return cachedSilence
  try {
    const wav = encodeWav(new Float32Array(24000 * MEDIA_NOTIFICATION_SECONDS), 24000)
    cachedSilence = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
    return cachedSilence
  } catch {
    return ''
  }
}

export function createPlaybackAudio(): HTMLAudioElement {
  const audio = document.createElement('audio')
  audio.setAttribute('playsinline', '')
  audio.setAttribute('webkit-playsinline', '')
  audio.preload = 'auto'
  audio.controls = false
  audio.muted = false
  audio.defaultMuted = false
  audio.setAttribute('aria-hidden', 'true')
  audio.className = 'playback-audio'
  document.body.appendChild(audio)
  return audio
}

/**
 * Plays packed WAV blobs through one HTMLAudioElement so Android Chrome and
 * iOS Safari can keep speech going after the tab is hidden. WebAudio is not used
 * for output: Chrome Android does not take audio focus or show a media
 * notification for WebAudio, so a hidden tab is frozen.
 */
export class HtmlAudioQueue {
  private current: PackedSegment | null = null
  private upcoming: PackedSegment[] = []
  private sliceIndex = 0
  private paused = true
  private generation = 0
  private loadSerial = 0
  private loading = false
  private activeSlice: PackedSlice | null = null

  constructor(private audio: HTMLAudioElement, private hooks: HtmlAudioHooks) {
    audio.addEventListener('ended', () => this.advance())
    audio.addEventListener('timeupdate', () => this.syncSlice())
    audio.addEventListener('pause', () => this.recoverIfBackgroundPaused())
    audio.addEventListener('error', () => {
      if (this.current && this.audio.src === this.current.url) this.hooks.onError()
    })
  }

  get remaining(): number {
    const playing = this.current ? Math.max(0, this.current.contentDuration - (this.audio.currentTime || 0)) : 0
    return playing + this.upcoming.reduce((total, segment) => total + segment.contentDuration, 0)
  }

  get fileRemaining(): number {
    const playing = this.current ? Math.max(0, this.current.duration - (this.audio.currentTime || 0)) : 0
    return playing + this.upcoming.reduce((total, segment) => total + segment.duration, 0)
  }

  get position(): number {
    return this.audio.currentTime || 0
  }

  get hasNext(): boolean { return this.upcoming.length > 0 }
  get isEmpty(): boolean { return !this.current && !this.upcoming.length }
  get isPaused(): boolean { return this.paused }
  get currentSegment(): PackedSegment | null { return this.current }
  get upcomingSegments(): readonly PackedSegment[] { return this.upcoming }
  get element(): HTMLAudioElement { return this.audio }

  enqueue(segment: PackedSegment): void {
    if (!this.current) this.current = segment
    else this.upcoming.push(segment)
  }

  /** Rebuild the not-yet-playing file so a hidden tab does not need JS between sentences. */
  replaceUpcoming(segment: PackedSegment): void {
    for (const old of this.upcoming) this.revoke(old)
    this.upcoming = [segment]
  }

  /** Lengthen the playing file while visible, keeping the current offset. */
  async replaceCurrent(segment: PackedSegment): Promise<void> {
    const offset = this.audio.currentTime || 0
    const previous = this.current
    this.current = segment
    if (!this.paused && this.audio.src) await this.load(segment, offset)
    else if (!this.paused) await this.load(segment, 0)
    this.revoke(previous)
  }

  seekInCurrent(time: number): void {
    if (!this.current) return
    this.audio.currentTime = Math.max(0, Math.min(this.current.duration - 0.05, time))
    this.syncSlice(true)
  }

  seekBy(delta: number): void {
    this.seekInCurrent((this.audio.currentTime || 0) + delta)
  }

  async unlock(): Promise<void> {
    if (this.current) {
      this.paused = false
      try { await this.audio.play() } catch { /* real src retries */ }
      return
    }
    const silence = silenceUrl()
    if (!silence) return
    const serial = this.loadSerial
    this.audio.loop = true
    if (this.audio.src !== silence) this.audio.src = silence
    try { await this.audio.play() } catch { /* first real src retries play */ }
    if (serial !== this.loadSerial || this.current) this.audio.loop = false
  }

  async play(): Promise<void> {
    this.paused = false
    if (!this.current && this.upcoming.length) this.current = this.upcoming.shift() ?? null
    if (!this.current) return
    if (this.audio.src !== this.current.url) await this.load(this.current, 0)
    if (this.paused || !this.current) return
    await this.audio.play()
  }

  /** Keep the same element playing after a hide. Never pauses. */
  ensurePlaying(): void {
    if (this.paused || !this.current || this.loading) return
    if (this.audio.paused) void this.audio.play().catch(() => { /* gesture already used */ })
  }

  pause(): void {
    this.paused = true
    this.audio.pause()
  }

  async resume(): Promise<void> {
    this.paused = false
    if (!this.current) return
    await this.audio.play()
  }

  stop(): void {
    this.generation += 1
    this.loadSerial += 1
    this.paused = true
    this.loading = false
    this.audio.loop = false
    this.audio.pause()
    this.revoke(this.current)
    for (const segment of this.upcoming) this.revoke(segment)
    this.current = null
    this.audio.removeAttribute('src')
    try { this.audio.load() } catch { /* jsdom */ }
    this.upcoming = []
    this.sliceIndex = 0
    this.activeSlice = null
  }

  dispose(): void {
    this.stop()
    this.audio.remove()
  }

  private recoverIfBackgroundPaused(): void {
    if (this.paused || this.loading || !this.current) return
    void this.audio.play().catch(() => { /* stay on the element; Media Session play retries */ })
  }

  private async load(segment: PackedSegment, offset: number): Promise<void> {
    const generation = this.generation
    const serial = ++this.loadSerial
    this.loading = true
    this.audio.loop = false
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        this.audio.removeEventListener('loadedmetadata', ready)
        this.audio.removeEventListener('error', fail)
        const time = offset > 0 && Number.isFinite(offset)
          ? Math.max(0, Math.min(segment.duration - 0.05, offset))
          : 0
        this.audio.currentTime = time
        resolve()
      }
      const fail = () => {
        this.audio.removeEventListener('loadedmetadata', ready)
        this.audio.removeEventListener('error', fail)
        reject(new Error('AUDIO'))
      }
      this.audio.addEventListener('loadedmetadata', ready)
      this.audio.addEventListener('error', fail)
      this.audio.src = segment.url
      this.audio.currentTime = 0
      try { this.audio.load() } catch { /* already loading */ }
    })
    if (generation !== this.generation || serial !== this.loadSerial) return
    this.loading = false
    this.sliceIndex = 0
    this.syncSlice(true)
    if (!this.paused) await this.audio.play()
  }

  private sliceAt(time: number): { slice: PackedSlice; index: number } | null {
    if (!this.current) return null
    const spoken = Math.min(time, this.current.contentDuration)
    for (let i = this.current.slices.length - 1; i >= 0; i -= 1) {
      const slice = this.current.slices[i]!
      if (spoken + 0.02 >= slice.start) return { slice, index: i }
    }
    return this.current.slices[0] ? { slice: this.current.slices[0], index: 0 } : null
  }

  private syncSlice(force = false): void {
    if (!this.current || this.paused && !force) {
      this.hooks.onTime?.(this.position, this.activeSlice)
      return
    }
    const found = this.sliceAt(this.audio.currentTime || 0)
    if (!found) return
    if (force || found.index !== this.sliceIndex || found.slice !== this.activeSlice) {
      this.sliceIndex = found.index
      this.activeSlice = found.slice
      this.hooks.onSlice(found.slice)
    }
    this.hooks.onTime?.(this.position, found.slice)
  }

  private advance(): void {
    if (this.paused) return
    const finished = this.current
    if (finished) this.hooks.onSegmentEnd?.(finished)
    this.revoke(finished)
    this.current = this.upcoming.shift() ?? null
    this.sliceIndex = 0
    this.activeSlice = null
    if (!this.current) {
      this.hooks.onIdle()
      return
    }
    void this.load(this.current, 0).catch(() => this.hooks.onError())
  }

  private revoke(segment: PackedSegment | null): void {
    if (segment?.url && segment.url !== cachedSilence && segment.url.startsWith('blob:')) {
      URL.revokeObjectURL(segment.url)
    }
  }
}
