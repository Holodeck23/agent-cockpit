import { NewThread } from './components/NewThread.tsx'
import { ThreadList } from './components/ThreadList.tsx'
import { ThreadView } from './components/ThreadView.tsx'
import { useCockpit } from './useCockpit.ts'

export function App() {
  const cockpit = useCockpit()
  const knownProjects = [...new Set(cockpit.threads.map((t) => t.meta.projectPath))]

  return (
    <div className="layout">
      <ThreadList threads={cockpit.threads} selectedId={cockpit.selectedId} onSelect={cockpit.select} />
      {cockpit.error ? (
        <div className="toast" role="alert">
          {cockpit.error}
          <button type="button" onClick={() => cockpit.reportError(undefined)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      {cockpit.selectedId && cockpit.detail ? (
        <ThreadView detail={cockpit.detail} streaming={cockpit.streaming} onError={cockpit.reportError} />
      ) : (
        <NewThread
          knownProjects={knownProjects}
          onError={cockpit.reportError}
          onCreated={(meta) => {
            cockpit.refresh()
            cockpit.select(meta.id)
          }}
        />
      )}
    </div>
  )
}
