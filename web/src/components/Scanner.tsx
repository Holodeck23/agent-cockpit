import { memo, type CSSProperties } from 'react'
import { plan, type LampPlan } from '../scanner-model.ts'

const ROWS = [plan('fwd'), plan('rev')] as const

const lampStyle = (p: LampPlan): CSSProperties => ({ '--at': p.at, ...(p.cut === undefined ? {} : { '--cut': p.cut }) } as CSSProperties)
const lampClass = (p: LampPlan): string => `scanner-lamp${p.kind === 'flash' ? '' : ` ${p.kind}`}${p.cut === undefined ? '' : ' cut'}`

/**
 * D12: KITT's scanner, a long row of soft lights in a recess along the composer's bottom edge. Every
 * lamp is still; the sweep is each lamp's own brightness (styles/scanner.css, timed by
 * scanner-model.ts). One row of lamps lights going right, one going left, laid over each other.
 * Static markup, memoised so typing in the composer never touches it.
 */
export const Scanner = memo(function Scanner() {
  return (
    <div className="scanner" aria-hidden="true">
      {ROWS.map((row) => (
        <div key={row[0]!.row} className="scanner-row">
          {row.map((p) => <i key={p.lamp} className={lampClass(p)} style={lampStyle(p)}><b /></i>)}
        </div>
      ))}
    </div>
  )
})
