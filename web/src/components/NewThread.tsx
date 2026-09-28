import { useState } from 'react'
import { EFFORTS, PERMISSION_MODES } from '../../../server/agents/claude/flags.ts'
import { api, type ThreadMeta, type ThreadSettings } from '../api.ts'
import { native } from '../native.ts'
import { Composer } from './Composer.tsx'

interface NewThreadProps {
  knownProjects: string[]
  onCreated: (meta: ThreadMeta) => void
  onError: (message: string) => void
}

const LAST_SETUP_KEY = 'cockpit:last-setup'

interface Setup {
  agent: 'claude' | 'codex'
  projectPath: string
  model: string
  effort: string
  permissionMode: ThreadSettings['permissionMode']
}

function loadSetup(fallbackProject: string): Setup {
  const base: Setup = { agent: 'claude', projectPath: fallbackProject, model: '', effort: '', permissionMode: 'manual' }
  try {
    const raw = localStorage.getItem(LAST_SETUP_KEY)
    return raw ? { ...base, ...(JSON.parse(raw) as Partial<Setup>) } : base
  } catch {
    return base
  }
}

export function NewThread({ knownProjects, onCreated, onError }: NewThreadProps) {
  const [setup, setSetup] = useState<Setup>(() => loadSetup(knownProjects[0] ?? ''))

  const change = (patch: Partial<Setup>): void => {
    const next = { ...setup, ...patch }
    setSetup(next)
    try {
      localStorage.setItem(LAST_SETUP_KEY, JSON.stringify(next))
    } catch {
      // not persisted
    }
  }

  const start = async (text: string): Promise<void> => {
    try {
      const meta = await api.createThread({
        projectPath: setup.projectPath.trim(),
        text,
        settings: {
          agent: setup.agent,
          permissionMode: setup.permissionMode,
          ...(setup.model ? { model: setup.model } : {}),
          ...(setup.effort ? { effort: setup.effort as ThreadSettings['effort'] } : {}),
        },
      })
      onCreated(meta)
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  return (
    <main className="thread new-thread">
      <header className="thread-head">
        <h1>New thread</h1>
      </header>
      <div className="setup">
        <label>
          Project folder
          <input
            list="known-projects"
            value={setup.projectPath}
            placeholder="/Users/Shared/repos/tools/agent-cockpit"
            onChange={(e) => change({ projectPath: e.target.value })}
          />
          <datalist id="known-projects">
            {knownProjects.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        {native ? (
          <button
            type="button"
            className="browse"
            onClick={() => {
              void native?.pickFolder().then((path) => {
                if (path) change({ projectPath: path })
              })
            }}
          >
            Browse…
          </button>
        ) : null}
        <label>
          Agent
          <select value={setup.agent} onChange={(e) => change({ agent: e.target.value as Setup['agent'] })}>
            <option>claude</option>
            <option>codex</option>
          </select>
        </label>
        <label>
          Model
          <input value={setup.model} placeholder="default" onChange={(e) => change({ model: e.target.value })} />
        </label>
        <label>
          Effort
          <select value={setup.effort} onChange={(e) => change({ effort: e.target.value })}>
            <option value="">default</option>
            {EFFORTS.map((effort) => (
              <option key={effort}>{effort}</option>
            ))}
          </select>
        </label>
        <label>
          Permissions
          <select
            value={setup.permissionMode}
            onChange={(e) => change({ permissionMode: e.target.value as Setup['permissionMode'] })}
          >
            {PERMISSION_MODES.map((mode) => (
              <option key={mode}>{mode}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="events" />
      <Composer
        draftKey="new-thread"
        placeholder="What should the agent do?"
        disabled={!setup.projectPath.trim()}
        onSubmit={start}
      />
    </main>
  )
}
