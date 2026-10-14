import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NARRATOR_PINS } from '../speech/local/narratorAssets'
import { LocalNarratorNotices } from './LocalNarratorNotices'

describe('local narrator notices', () => {
  it('shows the licence, the modification record and a reachable source offer, without a request', () => {
    // No fetch is stubbed: rendering the notice must not need the network,
    // because choosing the local engine happens before any consent.
    render(<LocalNarratorNotices />)
    const notices = screen.getByText(/Speech component: eSpeak-NG 1\.52\.0/)
    expect(notices).toHaveAttribute('data-local-notices', 'ready')
    expect(notices).toHaveTextContent('GPL-3.0-or-later, no warranty')
    expect(notices).toHaveTextContent('Built from commit 4870adfa')
    expect(screen.getByRole('link', { name: 'Licences and notices' })).toHaveAttribute('href', 'http://localhost/voice/notices/README.md')
    expect(screen.getByRole('link', { name: 'Corresponding source' })).toHaveAttribute('href', 'http://localhost/voice/source/SOURCE-OFFER.md')
    expect(screen.getByRole('link', { name: /Source archive \(17\.2 MB\)/ })).toHaveAttribute('href', 'http://localhost/voice/source/espeak-ng-1.52.0-corresponding-source.tar.gz')
  })

  it('keeps the notice equal to what we serve, so it cannot be stale', () => {
    // The notice shown before consent is read from the narrator pins; if those
    // drifted from the component we actually serve, the notice would be wrong.
    const { phonemizer } = NARRATOR_PINS
    expect(phonemizer.commit).toBe('4870adfa25b1a32b4361592f1be8a40337c58d6c')
    expect(phonemizer.tag).toBe('1.52.0')
    expect(phonemizer.modified).toBe('2026-10-14')
    expect(phonemizer.noticeIndex).toBe('../notices/README.md')
    expect(phonemizer.source.offer).toBe('../source/SOURCE-OFFER.md')
    expect(phonemizer.source.bytes).toBe(18001299)
    expect(phonemizer.source.sha256).toBe('92a53e12260ad748cb80131b420ab73a4bc3c589296e6dbabd1195aee29a9ca1')
  })
})
