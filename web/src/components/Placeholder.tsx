import type { ReactNode } from 'react'

interface PlaceholderProps {
  icon: ReactNode
  title: string
  children: ReactNode
}

/** Empty panel for sections that arrive in a later phase (Files, Workflows). */
export function Placeholder({ icon, title, children }: PlaceholderProps) {
  return (
    <section className="placeholder">
      <span className="placeholder-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{children}</p>
    </section>
  )
}
