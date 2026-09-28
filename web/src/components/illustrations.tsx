// Our own spot illustrations: flat shapes in the token palette, no outlines.

/** Two stacked conversation cards with the mark's bars on the front one. */
export function ConversationsArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 56" aria-hidden>
      <rect x="18" y="4" width="40" height="30" rx="8" fill="var(--p-pink)" opacity="0.28" transform="rotate(8 38 19)" />
      <rect x="6" y="16" width="42" height="30" rx="8" fill="var(--panel)" stroke="var(--border)" strokeWidth="1.5" />
      <path d="M16 46v7l7-7" fill="var(--panel)" stroke="var(--border)" strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="15" y="31" width="4" height="8" rx="2" fill="var(--blue)" />
      <rect x="22" y="25" width="4" height="14" rx="2" fill="var(--orange)" />
      <rect x="29" y="28" width="4" height="11" rx="2" fill="var(--p-pink)" />
      <path d="M52 6v6M49 9h6" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** Larger version for the new-conversation empty state. */
export function StartArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 160 120" aria-hidden>
      <rect x="62" y="10" width="78" height="56" rx="14" fill="var(--p-pink)" opacity="0.3" transform="rotate(7 101 38)" />
      <rect x="20" y="34" width="92" height="62" rx="14" fill="var(--panel)" stroke="var(--border)" strokeWidth="2" />
      <path d="M40 96v16l14-16" fill="var(--panel)" stroke="var(--border)" strokeWidth="2" strokeLinejoin="round" />
      <rect x="38" y="64" width="9" height="18" rx="4.5" fill="var(--blue)" />
      <rect x="54" y="50" width="9" height="32" rx="4.5" fill="var(--orange)" />
      <rect x="70" y="58" width="9" height="24" rx="4.5" fill="var(--p-pink)" />
      <path d="M26 14v12M20 20h12" stroke="var(--blue)" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="146" cy="84" r="4" fill="var(--orange)" opacity="0.7" />
    </svg>
  )
}
