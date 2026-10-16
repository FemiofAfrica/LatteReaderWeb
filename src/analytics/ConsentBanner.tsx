import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CONSENT_OPEN_EVENT, readConsent, setConsent, type ConsentChoice } from './analytics'

/** The page reserves exactly this much room at the bottom while the banner is open. */
export const CONSENT_SPACE_VAR = '--consent-space'

export function ConsentBanner() {
  const [open, setOpen] = useState(() => readConsent() === null)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(CONSENT_OPEN_EVENT, show)
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, show)
  }, [])
  // Publish the banner's measured height so the layout makes room for it instead of
  // letting it float over the reader's controls. Removed again once a choice is made.
  useLayoutEffect(() => {
    const node = ref.current
    const root = document.documentElement
    if (!open || !node) return
    const apply = () => root.style.setProperty(CONSENT_SPACE_VAR, `${Math.ceil(node.getBoundingClientRect().height)}px`)
    apply()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
    observer?.observe(node)
    window.addEventListener('resize', apply)
    return () => { observer?.disconnect(); window.removeEventListener('resize', apply); root.style.removeProperty(CONSENT_SPACE_VAR) }
  }, [open])
  if (!open) return null
  const choose = (choice: ConsentChoice) => { setConsent(choice); setOpen(false) }
  return (
    <section ref={ref} className="consent-banner" role="region" aria-label="Analytics consent" data-consent-banner>
      <p>We use Google Analytics to understand how LatteReader is used. No PDF content is ever sent.</p>
      <div className="consent-actions">
        <button type="button" className="secondary-button" onClick={() => choose('denied')}>Reject</button>
        <button type="button" className="secondary-button consent-accept" onClick={() => choose('granted')}>Accept</button>
      </div>
    </section>
  )
}
