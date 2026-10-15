import { useEffect, useState } from 'react'
import { CONSENT_OPEN_EVENT, readConsent, setConsent, type ConsentChoice } from './analytics'

export function ConsentBanner() {
  const [open, setOpen] = useState(() => readConsent() === null)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(CONSENT_OPEN_EVENT, show)
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, show)
  }, [])
  if (!open) return null
  const choose = (choice: ConsentChoice) => { setConsent(choice); setOpen(false) }
  return (
    <section className="consent-banner" role="region" aria-label="Analytics consent" data-consent-banner>
      <p>We use Google Analytics to understand how LatteReader is used. No PDF content is ever sent.</p>
      <div className="consent-actions">
        <button type="button" className="secondary-button" onClick={() => choose('denied')}>Reject</button>
        <button type="button" className="secondary-button consent-accept" onClick={() => choose('granted')}>Accept</button>
      </div>
    </section>
  )
}
