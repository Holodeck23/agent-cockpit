import { memo } from 'react'

const LAMPS = Array.from({ length: 10 }, (_, lamp) => lamp)

/**
 * D12: KITT's scanner, a row of ten lamps in a recess along the composer's bottom edge. Every lamp
 * is still; the sweep is each lamp's own brightness (styles/scanner.css). Static markup, memoised so
 * typing in the composer never touches it.
 */
export const Scanner = memo(function Scanner() {
  return (
    <div className="scanner" aria-hidden="true">
      {LAMPS.map((lamp) => <i key={lamp} className="scanner-lamp" />)}
    </div>
  )
})
