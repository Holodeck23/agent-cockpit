// Lumen spot illustrations: the orbit, drawn in fine lines, holding still. Colours come from the
// tokens, so they follow the theme; the one warm point is the moon.

/** The conversation list's header mark. Hidden in the Lumen list (styles/list.css); kept small. */
export function ConversationsArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 56" aria-hidden>
      <ellipse cx="32" cy="29" rx="24" ry="9" transform="rotate(-16 32 29)" fill="none" stroke="var(--muted)" strokeOpacity="0.5" strokeWidth="1.5" />
      <circle cx="32" cy="29" r="8" fill="var(--lumen-soft)" stroke="var(--lumen)" strokeWidth="1.5" />
      <circle cx="51" cy="21" r="3" fill="var(--ember)" />
    </svg>
  )
}

/** The new-conversation empty state: an orbit with a few stars, quiet until you begin. */
export function StartArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 168 112" aria-hidden>
      <g fill="var(--muted)">
        <circle cx="22" cy="22" r="1.4" opacity="0.6" />
        <circle cx="140" cy="16" r="1.2" opacity="0.5" />
        <circle cx="154" cy="78" r="1.4" opacity="0.4" />
        <circle cx="16" cy="88" r="1.1" opacity="0.4" />
      </g>
      <circle cx="44" cy="30" r="1.8" fill="var(--ember)" opacity="0.7" />
      <circle cx="84" cy="58" r="34" fill="var(--lumen-soft)" />
      <ellipse cx="84" cy="58" rx="62" ry="20" transform="rotate(-16 84 58)" fill="none" stroke="var(--muted)" strokeOpacity="0.45" strokeWidth="1.5" />
      <circle cx="84" cy="58" r="17" fill="var(--panel)" stroke="var(--lumen)" strokeWidth="1.8" />
      <circle cx="84" cy="58" r="7" fill="var(--lumen)" opacity="0.85" />
      <path d="M22 58 A62 20 0 0 0 146 58" transform="rotate(-16 84 58)" fill="none" stroke="var(--muted)" strokeOpacity="0.8" strokeWidth="1.5" />
      <circle cx="138" cy="38" r="5.5" fill="var(--ember)" />
    </svg>
  )
}
