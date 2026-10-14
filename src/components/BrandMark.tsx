/** Crema Waves logo mark: latte cup, open-book latte art and steam curls. Colours follow theme CSS variables. */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <g transform="translate(-3 0)">
        <path d="M24 50 H72 V58 C72 74 61 84 48 84 C35 84 24 74 24 58 Z" fill="var(--cream)" />
        <path d="M71.5 57 h3.5 a8.5 8.5 0 0 1 0 17 h-6" fill="none" stroke="var(--cream)" strokeWidth="5.5" strokeLinecap="round" />
        <path d="M31 57.5 Q39.5 53.5 48 58 Q56.5 53.5 65 57.5 L64 62.5 Q56 59.5 48 64 Q40 59.5 32 62.5 Z" fill="var(--espresso)" />
        <path d="M48 58 V64" stroke="var(--cream)" strokeWidth="1.8" strokeLinecap="round" />
        <g fill="none" stroke="var(--butter)" strokeWidth="4.6" strokeLinecap="round">
          <path d="M37 44 c-5 -2.5 -5 -7.5 0 -10 s5 -7.5 0 -10" />
          <path d="M48 44 c-6 -3.75 -6 -11.25 0 -15 s6 -11.25 0 -15" />
          <path d="M59 44 c-5 -2.5 -5 -7.5 0 -10 s5 -7.5 0 -10" />
        </g>
      </g>
    </svg>
  )
}
