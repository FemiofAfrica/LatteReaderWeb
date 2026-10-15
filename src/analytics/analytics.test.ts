import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('analytics consent', () => {
  beforeEach(() => { vi.resetModules(); window.localStorage.clear(); delete window.dataLayer; document.head.querySelectorAll('script[src*="googletagmanager"]').forEach(s => s.remove()) })

  it('defaults every signal to denied and loads no tag before consent', async () => {
    const a = await import('./analytics')
    a.initAnalytics()
    const first = Array.from(window.dataLayer![0] as ArrayLike<unknown>)
    expect(first[0]).toBe('consent'); expect(first[1]).toBe('default')
    expect(first[2]).toEqual({ analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' })
    expect(document.querySelector('script[src*="googletagmanager"]')).toBeNull()
    a.track('pdf_opened')
    expect(window.dataLayer!.some(e => Array.from(e as ArrayLike<unknown>)[0] === 'event')).toBe(false)
  })

  it('loads the tag and sends events only after Accept, and remembers the choice', async () => {
    const a = await import('./analytics')
    a.initAnalytics(); a.setConsent('granted')
    expect(window.localStorage.getItem(a.CONSENT_KEY)).toBe('granted')
    expect(document.querySelector('script[src*="googletagmanager"]')?.getAttribute('src')).toContain(a.MEASUREMENT_ID)
    a.track('play_started', { voice_type: 'browser' })
    expect(window.dataLayer!.some(e => Array.from(e as ArrayLike<unknown>)[1] === 'play_started')).toBe(true)
    a.setConsent('denied')
    expect(window[`ga-disable-${a.MEASUREMENT_ID}`]).toBe(true)
    a.track('pdf_opened')
    expect(window.dataLayer!.some(e => Array.from(e as ArrayLike<unknown>)[1] === 'pdf_opened')).toBe(false)
  })
})
