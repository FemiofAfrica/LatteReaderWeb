import type { PackedSegment, PackedSlice } from './audioPack'

export interface HtmlAudioHooks {
  onSlice: (slice: PackedSlice) => void
  onSegmentEnd?: (segment: PackedSegment) => void
  onIdle: () => void
  onError: () => void
  onTime?: (position: number, slice: PackedSlice | null) => void
}

function silenceUrl(): string {
  try {
    const bytes = new Uint8Array([
      82,73,70,70,46,0,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,128,62,0,0,0,125,0,0,2,0,16,0,100,97,116,97,10,0,0,0,0,0,0,0,0,0,0,0,0,0,
    ])
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
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
  audio.setAttribute('aria-hidden', 'true')
  audio.className = 'playback-audio'
  document.body.appendChild(audio)
  return audio
}

/**
 * Plays packed WAV blobs through one HTMLAudioElement so Android Chrome and
 * iOS Safari can keep speech going after the tab is hidden. WebAudio is not used
 * for output: a hidden tab suspends that graph.
 */
export class HtmlAudioQueue {
  private current: PackedSegment | null = null
  private upcoming: PackedSegment[] = []
  private sliceIndex = 0
  private paused = true
  private generation = 0
  private activeSlice: PackedSlice | null = null

  constructor(private audio: HTMLAudioElement, private hooks: HtmlAudioHooks) {
    audio.addEventListener('ended', () => this.advance())
    audio.addEventListener('timeupdate', () => this.syncSlice())
    audio.addEventListener('error', () => {
      if (this.current && this.audio.src === this.current.url) this.hooks.onError()
    })
  }

  get remaining(): number {
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

  enqueue(segment: PackedSegment): void {
    if (!this.current) this.current = segment
    else this.upcoming.push(segment)
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
    if (this.audio.src) {
      try { await this.audio.play() } catch { /* gesture may still be needed later */ }
      return
    }
    const silence = silenceUrl()
    if (!silence) return
    this.audio.src = silence
    try { await this.audio.play() } catch { /* first real src retries play */ }
  }

  async play(): Promise<void> {
    this.paused = false
    if (!this.current && this.upcoming.length) this.current = this.upcoming.shift() ?? null
    if (!this.current) return
    if (this.audio.src !== this.current.url) await this.load(this.current, this.audio.currentTime || 0)
    if (this.paused || !this.current) return
    await this.audio.play()
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
    this.paused = true
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

  private async load(segment: PackedSegment, offset: number): Promise<void> {
    const generation = this.generation
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        this.audio.removeEventListener('loadedmetadata', ready)
        this.audio.removeEventListener('error', fail)
        if (offset > 0 && Number.isFinite(offset)) this.audio.currentTime = offset
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
      try { this.audio.load() } catch { /* already loading */ }
    })
    if (generation !== this.generation) return
    this.sliceIndex = 0
    this.syncSlice(true)
    if (!this.paused) await this.audio.play()
  }

  private sliceAt(time: number): { slice: PackedSlice; index: number } | null {
    if (!this.current) return null
    for (let i = this.current.slices.length - 1; i >= 0; i -= 1) {
      const slice = this.current.slices[i]!
      if (time + 0.02 >= slice.start) return { slice, index: i }
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
    if (segment?.url.startsWith('blob:')) URL.revokeObjectURL(segment.url)
  }
}
