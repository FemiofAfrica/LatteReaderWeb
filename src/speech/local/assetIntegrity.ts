/**
 * Byte integrity for the assets the local narrator downloads.
 *
 * This is the same rule the pinned eSpeak-NG loader already applies to the
 * speech component (`public/voice/espeak/espeakng.bootstrap.js`): fetch, check
 * the length, check the SHA-256, and refuse the asset on any difference. It is
 * extended here to a file that arrives as several parts, because the Kitten
 * Micro graph is 41,384,970 bytes and the host caps one file at 26,214,400
 * bytes: the parts are fetched in the recorded order, concatenated, and the
 * whole-file hash is checked before the buffer is handed to the runtime.
 *
 * Nothing here falls back. A missing, short, reordered or altered asset raises
 * the same kind of error the eSpeak loader raises, so a failure reads the same
 * wherever it happens and the caller reports it instead of synthesising.
 */
export interface AssetPins {
  /** Expected byte length. */
  bytes: number
  /** Expected lowercase hex SHA-256. */
  sha256: string
}

export interface PartPins extends AssetPins {
  /** Path relative to the manifest's own directory. */
  path: string
}

export type Fetcher = (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'arrayBuffer'>>

/** Lowercase hex SHA-256 of the given bytes. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  // Cast: the DOM type wants an ArrayBuffer-backed view, and these are always
  // freshly fetched buffers, never a shared view over a larger one.
  const digest = await crypto.subtle.digest('SHA-256', view as unknown as BufferSource)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Last path segment, so a failure names the file rather than a full URL. */
export function assetName(url: string): string {
  return url.split('?')[0].split('/').filter(Boolean).at(-1) ?? url
}

/** Fetch one asset and return it only if it is exactly the pinned bytes. */
export async function fetchVerified(url: string, pins: AssetPins, fetcher: Fetcher = fetch): Promise<ArrayBuffer> {
  const response = await fetcher(url)
  if (!response.ok) throw Error(`ASSET_UNAVAILABLE:${assetName(url)}`)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength !== pins.bytes) throw Error(`SIZE_MISMATCH:${assetName(url)}`)
  if (await sha256Hex(buffer) !== pins.sha256) throw Error(`HASH_MISMATCH:${assetName(url)}`)
  return buffer
}

/**
 * Reassemble a split asset and verify the whole file before anyone uses it.
 *
 * Parts are fetched one at a time in the order recorded in the manifest, so a
 * part can never be placed at the wrong offset: an altered, truncated or
 * misordered set produces a size or hash mismatch on the part itself or on the
 * assembled file, and the buffer is never returned.
 */
export async function fetchPartsVerified(
  parts: readonly PartPins[],
  whole: AssetPins & { name: string },
  resolve: (path: string) => string,
  fetcher: Fetcher = fetch,
  /** How one verified part is obtained; defaults to a network fetch. The device cache plugs in here. */
  load: (url: string, pins: AssetPins) => Promise<ArrayBuffer> = (url, pins) => fetchVerified(url, pins, fetcher),
): Promise<ArrayBuffer> {
  if (!parts.length) throw Error(`PART_ORDER:${whole.name}`)
  const buffers: ArrayBuffer[] = []
  for (const part of parts) buffers.push(await load(resolve(part.path), part))
  const joined = new Uint8Array(whole.bytes)
  let at = 0
  for (const buffer of buffers) {
    joined.set(new Uint8Array(buffer), at)
    at += buffer.byteLength
  }
  if (at !== whole.bytes) throw Error(`SIZE_MISMATCH:${whole.name}`)
  if (await sha256Hex(joined) !== whole.sha256) throw Error(`HASH_MISMATCH:${whole.name}`)
  return joined.buffer
}
