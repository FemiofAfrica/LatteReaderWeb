import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalNarratorNotices } from './LocalNarratorNotices'

const raw = readFileSync(join(process.cwd(), 'public/voice/espeak/build-manifest.json'), 'utf8')

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('local narrator notices', () => {
  it('shows the licence, the modification record and a reachable source offer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => JSON.parse(raw) }) as unknown as Response))
    render(<LocalNarratorNotices />)
    const notices = await screen.findByText(/Speech component: eSpeak-NG 1\.52\.0/)
    expect(notices).toHaveAttribute('data-local-notices', 'ready')
    expect(notices).toHaveTextContent('GPL-3.0-or-later, no warranty')
    expect(notices).toHaveTextContent('Built from commit 4870adfa')
    expect(screen.getByRole('link', { name: 'Licences and notices' })).toHaveAttribute('href', 'http://localhost/voice/notices/README.md')
    expect(screen.getByRole('link', { name: 'Corresponding source' })).toHaveAttribute('href', 'http://localhost/voice/source/SOURCE-OFFER.md')
    expect(screen.getByRole('link', { name: /Source archive \(17\.2 MB\)/ })).toHaveAttribute('href', 'http://localhost/voice/source/espeak-ng-1.52.0-corresponding-source.tar.gz')
  })

  it('says so instead of inventing details when the manifest is not readable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response))
    render(<LocalNarratorNotices />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveAttribute('data-local-notices', 'unavailable'))
    expect(screen.queryByRole('link')).toBeNull()
  })
})
