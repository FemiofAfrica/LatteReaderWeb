/** 16-bit mono PCM WAV, so an HTMLAudioElement can play generated speech off the page. */

export const WAV_HEADER_BYTES = 44
export const WAV_BYTES_PER_SAMPLE = 2

export function wavDuration(pcmFrames: number, sampleRate: number): number {
  return sampleRate > 0 ? pcmFrames / sampleRate : 0
}

export function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const dataSize = pcm.length * WAV_BYTES_PER_SAMPLE
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * WAV_BYTES_PER_SAMPLE, true)
  view.setUint16(32, WAV_BYTES_PER_SAMPLE, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = WAV_HEADER_BYTES
  for (let i = 0; i < pcm.length; i += 1, offset += WAV_BYTES_PER_SAMPLE) {
    const sample = Math.max(-1, Math.min(1, pcm[i] ?? 0))
    view.setInt16(offset, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true)
  }
  return buffer
}

export function wavSampleRate(wav: ArrayBuffer): number {
  return wav.byteLength >= WAV_HEADER_BYTES ? new DataView(wav).getUint32(24, true) : 0
}

export function wavDataBytes(wav: ArrayBuffer): number {
  return wav.byteLength >= WAV_HEADER_BYTES ? new DataView(wav).getUint32(40, true) : 0
}

/** Trailing silence so Chrome Android sees a file long enough for a media notification. */
export function padWav(wav: ArrayBuffer, minSeconds: number): ArrayBuffer {
  const sampleRate = wavSampleRate(wav) || 24000
  const need = Math.ceil(Math.max(0, minSeconds) * sampleRate) * WAV_BYTES_PER_SAMPLE
  const have = wavDataBytes(wav)
  if (have >= need) return wav
  const frames = (need - have) / WAV_BYTES_PER_SAMPLE
  return concatWav([wav, encodeWav(new Float32Array(frames), sampleRate)])
}

/** Join same-format mono WAVs into one file for a longer HTMLAudioElement source. */
export function concatWav(parts: readonly ArrayBuffer[]): ArrayBuffer {
  const usable = parts.filter(part => part.byteLength > WAV_HEADER_BYTES)
  if (usable.length === 0) return encodeWav(new Float32Array(0), 24000)
  if (usable.length === 1) return usable[0]!.slice(0)
  const sampleRate = new DataView(usable[0]!).getUint32(24, true)
  const dataSize = usable.reduce((total, part) => total + part.byteLength - WAV_HEADER_BYTES, 0)
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * WAV_BYTES_PER_SAMPLE, true)
  view.setUint16(32, WAV_BYTES_PER_SAMPLE, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  const output = new Uint8Array(buffer)
  let offset = WAV_HEADER_BYTES
  for (const part of usable) {
    output.set(new Uint8Array(part, WAV_HEADER_BYTES), offset)
    offset += part.byteLength - WAV_HEADER_BYTES
  }
  return buffer
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
}
