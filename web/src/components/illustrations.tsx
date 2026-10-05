// Our own spot illustrations: a flight path from a start dot through a waypoint to a flag,
// flat shapes in the token palette.

/** The conversation list's header mark: a short flight path ending at a flag. */
export function ConversationsArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 56" aria-hidden>
      <path d="M10 46C22 46 21 28 33 28S46 14 52 14" fill="none" stroke="var(--muted)" strokeWidth="2" strokeDasharray="1 4.5" strokeLinecap="round" />
      <circle cx="10" cy="46" r="4.5" fill="var(--blue)" />
      <circle cx="33" cy="28" r="3" fill="var(--panel)" stroke="var(--orange)" strokeWidth="2" />
      <path d="M52 22V6" stroke="var(--strong)" strokeWidth="2" strokeLinecap="round" />
      <path d="M53 6h9l-2.5 3.5L62 13h-9z" fill="var(--p-pink)" />
    </svg>
  )
}

/** Larger version for the new-conversation empty state. */
export function StartArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 160 120" aria-hidden>
      <path d="M28 96C52 96 50 58 80 58S112 26 132 26" fill="none" stroke="var(--muted)" strokeWidth="3" strokeDasharray="2 8" strokeLinecap="round" />
      <circle cx="28" cy="96" r="7" fill="var(--blue)" />
      <circle cx="80" cy="58" r="5" fill="var(--panel)" stroke="var(--orange)" strokeWidth="3" />
      <path d="M132 40V12" stroke="var(--strong)" strokeWidth="3" strokeLinecap="round" />
      <path d="M133 12h18l-5 6 5 6h-18z" fill="var(--p-pink)" />
    </svg>
  )
}
