import type { PackedSegment, PackedSlice } from './audioPack'

export interface HtmlAudioHooks {
  onSlice: (slice: PackedSlice) => void
  onSegmentEnd?: (segment: PackedSegment) => void
  onIdle: () => void
  onError: () => void
  onTime?: (position: number, slice: PackedSlice | null) => void
}

export function createPlaybackAudio(): HTMLAudioElement {
  const audio = document.createElement('audio')
  audio.setAttribute('playsinline', '')
  audio.setAttribute('webkit-playsinline', '')
  audio.preload = 'auto'
  audio.controls = false
  audio.muted = false
  audio.defaultMuted = false
  audio.loop = false
  audio.setAttribute('aria-hidden', 'true')
  audio.className = 'playback-audio'
  document.body.appendChild(audio)
  return audio
}

/**
 * One HTMLAudioElement, one src at a time. Packs never overlap. The next file
 * loads only after the native `ended` of the current src. No looping silence,
 * no padding skip, no pause-handler that restarts a finished clip.
 */
export class HtmlAudioQueue {
  private current: PackedSegment | null = null
  private upcoming: PackedSegment[] = []
  private sliceIndex = 0
  private paused = true
  private generation = 0
  private live = false
  private loading = false
  private activeSlice: PackedSlice | null = null
  private finishedIds = new Set<number>()

  constructor(private audio: HTMLAudioElement, private hooks: HtmlAudioHooks) {
    audio.loop = false
    audio.addEventListener('ended', () => this.onEnded())
    audio.addEventListener('timeupdate', () => this.syncSlice())
    audio.addEventListener('pause', () => this.recoverIfInterrupted())
    audio.addEventListener('error', () => {
      if (this.current && this.audio.src === this.current.url) this.hooks.onError()
    })
  }

  get remaining(): number {
    const playing = this.current ? Math.max(0, this.current.contentDuration - (this.audio.currentTime || 0)) : 0
    return playing + this.upcoming.reduce((total, segment) => total + segment.contentDuration, 0)
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

  replaceUpcoming(segment: PackedSegment): void {
    for (const old of this.upcoming) this.revoke(old)
    this.upcoming = [segment]
  }

  seekInCurrent(time: number): void {
    if (!this.current || !this.live) return
    this.audio.currentTime = Math.max(0, Math.min(this.current.duration - 0.05, time))
    this.syncSlice(true)
  }

  seekBy(delta: number): void {
    this.seekInCurrent((this.audio.currentTime || 0) + delta)
  }

  async unlock(): Promise<void> {
    this.paused = false
    this.audio.loop = false
    try { await this.audio.play() } catch { /* real src play() follows from the same element */ }
  }

  async play(): Promise<void> {
    this.paused = false
    this.audio.loop = false
    if (this.loading) return
    if (!this.current && this.upcoming.length) this.current = this.upcoming.shift() ?? null
    if (!this.current) return
    if (this.audio.src !== this.current.url) await this.load(this.current)
    else if (this.live && this.audio.paused) await this.audio.play()
  }

  ensurePlaying(): void {
    if (this.paused || this.loading || !this.current || !this.live) return
    if (this.audio.src !== this.current.url) return
    if (this.audio.ended) return
    const time = this.audio.currentTime || 0
    if (time < 0.05) return
    if (this.audio.paused) void this.audio.play().catch(() => { /* already ended or gesture */ })
  }

  pause(): void {
    this.paused = true
    this.audio.pause()
  }

  async resume(): Promise<void> {
    this.paused = false
    if (!this.current || this.audio.ended) return
    await this.audio.play()
  }

  stop(): void {
    this.generation += 1
    this.paused = true
    this.live = false
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
    this.finishedIds.clear()
  }

  dispose(): void {
    this.stop()
    this.audio.remove()
  }

  private recoverIfInterrupted(): void {
    if (this.paused || this.loading || !this.live || !this.current) return
    if (this.audio.src !== this.current.url || this.audio.ended) return
    const time = this.audio.currentTime || 0
    if (time < 0.05 || time + 0.25 >= this.current.duration) return
    void this.audio.play().catch(() => { /* ended or gesture */ })
  }

  private onEnded(): void {
    if (this.paused || this.loading || !this.live) return
    if (!this.current) return
    if (this.audio.src && this.audio.src !== this.current.url) return
    const time = this.audio.currentTime || 0
    const spoken = this.current.contentDuration
    if (time > 0.15 && time + 0.25 < spoken) return
    this.advance()
  }

  private advance(): void {
    const finished = this.current
    if (!finished || this.finishedIds.has(finished.id)) return
    this.finishedIds.add(finished.id)
    this.live = false
    this.hooks.onSegmentEnd?.(finished)
    this.revoke(finished)
    this.current = this.upcoming.shift() ?? null
    this.sliceIndex = 0
    this.activeSlice = null
    if (!this.current) {
      this.hooks.onIdle()
      return
    }
    void this.load(this.current).catch(() => this.hooks.onError())
  }

  private async load(segment: PackedSegment): Promise<void> {
    const generation = this.generation
    this.loading = true
    this.live = false
    this.audio.loop = false
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        if (this.audio.src !== segment.url) return
        this.audio.removeEventListener('loadedmetadata', ready)
        this.audio.removeEventListener('error', fail)
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
    if (generation !== this.generation || this.current?.id !== segment.id) {
      this.loading = false
      return
    }
    this.loading = false
    try { this.audio.currentTime = 0 } catch { /* jsdom */ }
    this.sliceIndex = 0
    this.syncSlice(true)
    if (this.paused) return
    await this.audio.play()
    if (generation !== this.generation || this.current?.id !== segment.id) return
    this.live = true
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

  private revoke(segment: PackedSegment | null): void {
    if (segment?.url.startsWith('blob:')) URL.revokeObjectURL(segment.url)
  }
}
