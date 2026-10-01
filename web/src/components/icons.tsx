// Our own line icons: 24px grid, 1.8 stroke, currentColor. Sized by the caller via CSS.
import type { ReactNode } from 'react'

interface IconProps {
  className?: string
  title?: string
}

function Svg({ className, title, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  )
}

/** The Cockpit mark: three gauge bars on a blue tile. */
export function Mark({ className }: IconProps) {
  return (
    <svg className={className ? `mark ${className}` : 'mark'} viewBox="0 0 24 24" role="img" aria-label="Cockpit">
      <rect width="24" height="24" rx="6" fill="var(--blue)" />
      <g fill="#fff">
        <rect x="6" y="11.5" width="2.8" height="6.5" rx="1.4" />
        <rect x="10.6" y="6" width="2.8" height="12" rx="1.4" />
        <rect x="15.2" y="9" width="2.8" height="9" rx="1.4" />
      </g>
    </svg>
  )
}

/** Working indicator: the mark's three bars; they move while `live`. */
export function Bars({ className, live = false }: IconProps & { live?: boolean }) {
  return (
    <svg className={`bars${live ? ' live' : ''}${className ? ` ${className}` : ''}`} viewBox="0 0 12 12" aria-hidden>
      <rect className="bar b1" x="1" y="5" width="2.4" height="6" rx="1.2" />
      <rect className="bar b2" x="4.8" y="1" width="2.4" height="10" rx="1.2" />
      <rect className="bar b3" x="8.6" y="3.5" width="2.4" height="7.5" rx="1.2" />
    </svg>
  )
}

export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-7.5L7 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5Z" />
  </Svg>
)
export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18Z" />
  </Svg>
)
export const WorkflowIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="6.5" width="14" height="13" rx="2" />
    <path d="M7 3.5h11.5a2 2 0 0 1 2 2V17" />
    <path d="m9 10.5 4.5 2.5L9 15.5Z" />
  </Svg>
)
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </Svg>
)
export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </Svg>
)
export const PinIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4h6M10 4v5.5L7 13h10l-3-3.5V4M12 13v7" />
  </Svg>
)
export const SunIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Svg>
)
export const MoonIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z" />
  </Svg>
)
export const MonitorIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="12" rx="2" />
    <path d="M9 20h6M12 16.5V20" />
  </Svg>
)
export const ChevronLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m14.5 6-6 6 6 6" />
  </Svg>
)
export const BellIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </Svg>
)
export const PhoneIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M10.5 18.5h3" />
  </Svg>
)
export const StopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
  </Svg>
)
export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
)
export const MoreIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={3} />
  </Svg>
)
export const ArrowUpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
)
export const FileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3.5h7l4.5 4.5v12a.5.5 0 0 1-.5.5H7a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 7 3.5Z" />
    <path d="M14 3.5V8h4.5M9 13h6M9 16.5h6" />
  </Svg>
)
export const ActivityIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12h4l2.5-6 4 12 2.5-6h4" />
  </Svg>
)
export const BranchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="5.5" r="2" />
    <circle cx="7" cy="18.5" r="2" />
    <circle cx="17" cy="8" r="2" />
    <path d="M7 7.5v9M17 10c0 4-10 2.5-10 6.5" />
  </Svg>
)
export const TerminalIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" />
  </Svg>
)
export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5.5M14 11v5.5" />
  </Svg>
)
export const SlidersIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h9M17.5 7h2M4.5 17h3M11.5 17h8" />
    <circle cx="15.5" cy="7" r="2" />
    <circle cx="9.5" cy="17" r="2" />
  </Svg>
)
