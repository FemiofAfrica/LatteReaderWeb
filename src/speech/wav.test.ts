import { describe, expect, it } from 'vitest'
import { concatWav, encodeWav, padWav, WAV_HEADER_BYTES, wavDataBytes, wavDuration } from './wav'

const readString = (view: DataView, offset: number, length: number) =>
  String.fromCharCode(...new Uint8Array(view.buffer, offset, length))

describe('WAV encoding', () => {
  it('writes a 16-bit mono header and the real duration of the samples', () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1])
    const wav = encodeWav(pcm, 24000)
    const view = new DataView(wav)
    expect(readString(view, 0, 4)).toBe('RIFF')
    expect(readString(view, 8, 4)).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(24000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + pcm.length * 2)
    expect(wavDuration(pcm.length, 24000)).toBeCloseTo(4 / 24000)
  })

  it('pads a short file so Chrome Android will show a media notification', () => {
    const short = encodeWav(new Float32Array(24000), 24000)
    const padded = padWav(short, 5)
    expect(wavDataBytes(padded)).toBe(5 * 24000 * 2)
    expect(padWav(padded, 5).byteLength).toBe(padded.byteLength)
  })

  it('joins files so a locked screen can play a longer current track', () => {
    const first = encodeWav(new Float32Array(24000), 24000)
    const second = encodeWav(new Float32Array(12000), 24000)
    const joined = concatWav([first, second])
    expect(new DataView(joined).getUint32(40, true)).toBe(36000 * 2)
    expect(joined.byteLength).toBe(WAV_HEADER_BYTES + 36000 * 2)
  })
})
