import type { Project } from '../api.ts'

interface ProjectAvatarProps {
  project: Project
  /** Solid fill for the active project, a soft tint otherwise. */
  solid?: boolean
}

export function ProjectAvatar({ project, solid = false }: ProjectAvatarProps) {
  const letter = [...project.name.trim()][0]?.toUpperCase() ?? '?'
  return (
    <span className={`avatar avatar-${project.color}${solid ? ' solid' : ''}`} aria-hidden>
      {letter}
    </span>
  )
}
