/**
 * Google Analytics 4 with Consent Mode v2.
 *
 * Every consent signal defaults to 'denied' and gtag.js is not even requested until the
 * visitor presses Accept, so nothing reaches Google before consent. Only analytics_storage
 * is ever granted; the ad signals stay denied. Events never carry PDF text, file names or
 * any personal data: only the event name and a coarse voice type.
 */
export const MEASUREMENT_ID = 'G-JSFSZH2GK5'
export const CONSENT_KEY = 'latte-analytics-consent'
export const CONSENT_OPEN_EVENT = 'latte-consent-open'
export type ConsentChoice = 'granted' | 'denied'

type Gtag = (...args: unknown[]) => void
declare global {
  interface Window { dataLayer?: unknown[]; gtag?: Gtag; [key: `ga-disable-${string}`]: boolean | undefined }
}

const gtag: Gtag = function () {
  // gtag.js only understands the Arguments object, not a copied array.
  // eslint-disable-next-line prefer-rest-params
  ;(window.dataLayer = window.dataLayer || []).push(arguments)
}

let initialised = false
let loaded = false

export function readConsent(): ConsentChoice | null {
  try {
    const value = window.localStorage.getItem(CONSENT_KEY)
    return value === 'granted' || value === 'denied' ? value : null
  } catch { return null }
}

function loadTag() {
  if (loaded) return
  loaded = true
  window[`ga-disable-${MEASUREMENT_ID}`] = false
  const script = document.createElement('script')
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`
  document.head.appendChild(script)
  gtag('js', new Date())
  gtag('config', MEASUREMENT_ID, { allow_google_signals: false, allow_ad_personalization_signals: false })
}

function clearGaCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim()
    if (!name || !name.startsWith('_ga')) continue
    const host = window.location.hostname
    for (const domain of ['', `; domain=${host}`, `; domain=.${host.split('.').slice(-2).join('.')}`]) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`
    }
  }
}

export function initAnalytics() {
  if (initialised || typeof window === 'undefined') return
  initialised = true
  window.gtag = gtag
  gtag('consent', 'default', {
    analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
  })
  gtag('set', 'ads_data_redaction', true)
  if (readConsent() === 'granted') {
    gtag('consent', 'update', { analytics_storage: 'granted' })
    loadTag()
  }
}

export function setConsent(choice: ConsentChoice) {
  try { window.localStorage.setItem(CONSENT_KEY, choice) } catch { /* private mode: choice lasts for this visit */ }
  if (choice === 'granted') {
    gtag('consent', 'update', { analytics_storage: 'granted' })
    loadTag()
  } else {
    gtag('consent', 'update', { analytics_storage: 'denied' })
    window[`ga-disable-${MEASUREMENT_ID}`] = true
    clearGaCookies()
  }
}

export function openConsentSettings() {
  window.dispatchEvent(new Event(CONSENT_OPEN_EVENT))
}

type EventParams = Record<string, string | number | boolean>
/** Sends a GA event only after consent. Never pass document text, file names or personal data. */
export function track(name: string, params: EventParams = {}) {
  if (typeof window === 'undefined' || readConsent() !== 'granted' || !loaded) return
  gtag('event', name, params)
}
