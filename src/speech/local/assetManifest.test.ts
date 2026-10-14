import { createHash } from 'node:crypto'
import {readFileSync, statSync} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadVoiceManifest, manifestPath, VOICE_MANIFEST_URL, type VoiceBuildManifest } from './assetManifest'

// Vitest's jsdom environment resolves import.meta.url to an http URL, so the
// shipped files are read from the project root instead.
const file = (relative: string) => join(process.cwd(), relative)
const raw = readFileSync(file('compliance/espeak/voice/espeak/build-manifest.json'), 'utf8')

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const respond = (body: string, ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, json: async () => JSON.parse(body) }) as unknown as Response)

/** The manifest is only trustworthy if the files it names hash to what it claims. */
describe('speech component manifest', () => {
  it('matches the bytes of every file we ship', () => {
    const manifest = JSON.parse(raw) as VoiceBuildManifest
    expect(manifest.objectCode.map(entry => entry.role).sort()).toEqual(['data', 'wasm', 'worker-js'])
    for (const asset of manifest.objectCode) {
      const bytes = readFileSync(file(`compliance/espeak/voice/espeak/${asset.file}`))
      expect(bytes.length, asset.file).toBe(asset.bytes)
      expect(sha256(bytes), asset.file).toBe(asset.sha256)
    }
    const source = readFileSync(file(`compliance/espeak/voice/${manifest.correspondingSource.file.replace('../', '')}`))
    expect(source.length).toBe(manifest.correspondingSource.bytes)
    expect(sha256(source)).toBe(manifest.correspondingSource.sha256)
  })

  it('points at licence, modification and source files that are really there', () => {
    const manifest = JSON.parse(raw) as VoiceBuildManifest
    const paths = [manifest.noticeIndex, manifest.upstream.licenceText, manifest.correspondingSource.offer,
      ...manifest.notices.map(entry => entry.file)]
    for (const entry of paths) expect(statSync(file(`compliance/espeak/voice/${entry.replace('../', '')}`)).isFile(), entry).toBe(true)
    expect(manifest.modifications.status).toBe('modified')
    expect(manifest.modifications.patches.length).toBeGreaterThan(0)
    expect(manifest.upstream.licence).toBe('GPL-3.0-or-later')
  })

  it('loads the shipped manifest from the served path', async () => {
    const fetcher = respond(raw)
    const manifest = await loadVoiceManifest(fetcher)
    expect(fetcher).toHaveBeenCalledWith(VOICE_MANIFEST_URL, { credentials: 'omit' })
    expect(manifest.correspondingSource.files).toBe(2597)
  })

  it('fails closed on a missing, malformed or incomplete manifest', async () => {
    await expect(loadVoiceManifest(respond('{}', false, 404))).rejects.toThrow('MANIFEST_UNAVAILABLE')
    await expect(loadVoiceManifest(respond('not json'))).rejects.toThrow()
    const malformed = JSON.parse(raw) as VoiceBuildManifest
    malformed.correspondingSource.sha256 = 'not-a-hash'
    await expect(loadVoiceManifest(respond(JSON.stringify(malformed)))).rejects.toThrow('MANIFEST_INVALID:source-hash')
    const incomplete = JSON.parse(raw) as VoiceBuildManifest
    incomplete.objectCode = incomplete.objectCode.filter(entry => entry.role !== 'wasm')
    await expect(loadVoiceManifest(respond(JSON.stringify(incomplete)))).rejects.toThrow('MANIFEST_INVALID:object:wasm')
    const unnoted = JSON.parse(raw) as VoiceBuildManifest
    unnoted.notices = []
    await expect(loadVoiceManifest(respond(JSON.stringify(unnoted)))).rejects.toThrow('MANIFEST_INVALID:notices')
  })

  it('resolves manifest-relative paths against the manifest itself', () => {
    expect(manifestPath('../notices/README.md')).toBe('http://localhost/voice/notices/README.md')
    expect(manifestPath('../source/SOURCE-OFFER.md')).toBe('http://localhost/voice/source/SOURCE-OFFER.md')
  })
})
