import { useState } from 'react'
import type { Project } from '../api.ts'
import { projectImageUrl } from '../project-image.ts'

interface ProjectAvatarProps {
  project: Project
  /** Solid fill for the active project, a soft tint otherwise. */
  solid?: boolean
  /** Larger, for the project settings header. */
  large?: boolean
}

export function ProjectAvatar({ project, solid = false, large = false }: ProjectAvatarProps) {
  const letter = [...project.name.trim()][0]?.toUpperCase() ?? '?'
  // A picture that fails to load (e.g. on the phone) falls back to the letter.
  const [broken, setBroken] = useState<string>()
  const classes = `avatar avatar-${project.color}${solid ? ' solid' : ''}${large ? ' large' : ''}`
  if (project.image && broken !== project.image) {
    return (
      <span className={`${classes} has-image`} aria-hidden>
        <img src={projectImageUrl(project.path, project.image)} alt="" onError={() => setBroken(project.image)} />
      </span>
    )
  }
  return (
    <span className={classes} aria-hidden>
      {letter}
    </span>
  )
}
