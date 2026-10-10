import { memo } from 'react'

/**
 * Lumen's working light: one soft light that drifts along the composer's bottom edge while a turn
 * runs, and nothing at all while idle (styles/working-light.css). It replaces the D12 scanner.
 * Static markup, memoised so typing in the composer never touches it.
 */
export const WorkingLight = memo(function WorkingLight() {
  return (
    <div className="working-light" aria-hidden="true">
      <i />
    </div>
  )
})
