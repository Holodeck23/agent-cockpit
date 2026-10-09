import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type ResultRecord } from '../api.ts'

const outcomeLabel = (state: ResultRecord['provider']['state']): string =>
  state === 'working' ? 'Agent working' : state === 'ok' ? 'Agent turn ready' : state === 'stopped' ? 'Agent turn stopped' : state === 'interrupted' ? 'Agent turn interrupted' : 'Agent turn failed'

const checkLabel = (result: ResultRecord['checks'][number]): string => {
  if (result.phase !== 'terminal') return result.phase === 'prepared' ? 'Preparing' : 'Running'
  if (result.outcome === 'timed-out') return 'Timed out'
  if (result.outcome === 'interrupted') return 'Interrupted'
  return result.outcome ? `${result.outcome[0]!.toUpperCase()}${result.outcome.slice(1)}` : 'Ended'
}

export function ResultCard({ threadId, runId, onOpenChanges }: { threadId: string; runId: string; onOpenChanges?: (runId: string) => void }) {
  const [result, setResult] = useState<ResultRecord>()
  const [error, setError] = useState<string>()
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('.')
  const [requiredText, setRequiredText] = useState('')
  const [inputs, setInputs] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [working, setWorking] = useState(false)
  const remote = typeof document !== 'undefined' && document.documentElement.classList.contains('phone')
  const load = useCallback(async () => {
    const value = await api.result(threadId, runId)
    setResult(value)
    setError(undefined)
    return value
  }, [threadId, runId])

  useEffect(() => {
    let current = true
    load().catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { current = false }
  }, [load])
  useEffect(() => {
    if (!result || (result.changes.state !== 'running' && !result.checks.some((check) => check.phase !== 'terminal'))) return
    const timer = setInterval(() => { void load().catch(() => undefined) }, 500)
    return () => clearInterval(timer)
  }, [load, result])

  const runCheck = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setWorking(true); setError(undefined)
    try {
      await api.runCheck(threadId, runId, {
        command, cwd, env: [], timeoutSec: 120,
        criterion: requiredText.trim() ? { kind: 'output-includes', text: requiredText.trim() } : { kind: 'exit-zero' },
        inputs: inputs.split(',').map((path) => path.trim()).filter(Boolean),
      })
      setCommand(''); setRequiredText('')
      await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setWorking(false) }
  }
  const capture = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setWorking(true); setError(undefined)
    try { await api.captureResultPreview(threadId, runId, previewUrl); setPreviewUrl(''); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setWorking(false) }
  }
  const assess = async (evidenceId: string, verdict: 'looks-right' | 'looks-wrong'): Promise<void> => {
    setWorking(true); setError(undefined)
    try { await api.assessResultPreview(threadId, runId, evidenceId, verdict); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setWorking(false) }
  }

  if (error && !result) return <div className="result-card result-error" role="status"><strong>Result unavailable</strong><span>{error}</span></div>
  if (!result) return <div className="result-card" role="status">Recording result…</div>
  const changed = result.changes.comparison?.files.filter((file) => file.change !== 'unchanged') ?? []
  return (
    <details className="result-card">
      <summary><strong>{outcomeLabel(result.provider.state)}</strong><span>{result.complete ? 'Conversation complete' : 'Conversation open'} · {result.changes.state === 'running' ? 'Checking changes…' : result.changes.state !== 'recorded' ? 'Changes unavailable' : `${changed.length} changed path${changed.length === 1 ? '' : 's'}`}  · {result.checks.length} host check{result.checks.length === 1 ? '' : 's'}</span></summary>
      {error ? <p className="result-inline-error" role="status">{error}</p> : null}
      <div className="result-grid">
        <section><h4>Changes</h4>
          {changed.length ? <><ul>{changed.slice(0, 8).map((file) => <li key={file.path}><code>{file.path}</code> <small>{file.change}</small></li>)}</ul>
            {onOpenChanges ? <button type="button" className="button-soft" onClick={() => onOpenChanges(runId)}>Open changes</button> : null}</>
            : <p>{result.changes.state === 'recorded' ? 'No workspace changes observed.' : result.changes.state === 'running' ? 'Still observing this run.' : 'Workspace changes were not fully observed.'}</p>}
          {result.changes.comparison?.uncertain.map((reason) => <small key={reason} className="result-reason">{reason}</small>)}
        </section>
        <section><h4>Checks</h4>{result.checks.length ? <ul className="result-checks">{result.checks.map((check) => (
          <li key={check.id}>
            <div><strong>{checkLabel(check)}</strong>{check.freshness ? <span className={`freshness ${check.freshness.state}`}>{check.freshness.state}</span> : null}</div>
            <code>/bin/sh -c {check.definition.command}</code>
            <small>{check.reason}</small>
            <div className="result-actions">
              {check.output ? <a href={api.resultEvidence(threadId, runId, check.output.evidenceId)} target="_blank" rel="noreferrer">Open stored output{check.output.truncated ? ' (tail)' : ''}</a> : null}
              {check.phase !== 'terminal' && !remote ? <button type="button" className="button-soft" disabled={working} onClick={() => { setWorking(true); void api.cancelCheck(check.id).then(load).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setWorking(false)) }}>Cancel</button> : null}
            </div>
          </li>
        ))}</ul> : <p>No host checks were run. The agent saying “passed” does not count as a check.</p>}
          {!remote ? <form className="result-form" onSubmit={(event) => { void runCheck(event) }}>
            <label>Exact command<input value={command} onChange={(event) => setCommand(event.target.value)} required placeholder="npm test" /></label>
            <div><label>Folder<input value={cwd} onChange={(event) => setCwd(event.target.value)} /></label><label>Required output (optional)<input value={requiredText} onChange={(event) => setRequiredText(event.target.value)} placeholder="0 failed" /></label></div>
            <label>Freshness inputs (comma-separated)<input value={inputs} onChange={(event) => setInputs(event.target.value)} placeholder="src, package.json" /></label>
            <small>Runs once as <code>/bin/sh -c</code>, stops after 120 seconds, and stores a host receipt.</small>
            <button type="submit" className="button-soft" disabled={working || !command.trim()}>Run exactly this check</button>
          </form> : null}
        </section>
        <section><h4>Preview</h4>{result.previews.length ? <ul className="result-previews">{result.previews.map((preview) => (
          <li key={preview.id}>
            {preview.integrity === 'ok' ? <img src={api.resultEvidence(threadId, runId, preview.id)} alt={`Captured preview of ${preview.preview?.url ?? 'the app'}`} /> : <strong>Capture {preview.integrity}</strong>}
            <small>{preview.preview?.url}</small>
            <span>{preview.assessments.at(-1)?.verdict === 'looks-right' ? 'Marked as looking right by you' : preview.assessments.at(-1)?.verdict === 'looks-wrong' ? 'Marked as looking wrong by you' : 'Captured, not yet judged'}</span>
            {!remote && preview.integrity === 'ok' ? <div className="result-actions"><button type="button" className="button-soft" disabled={working} onClick={() => { void assess(preview.id, 'looks-right') }}>Looks right</button><button type="button" className="button-soft" disabled={working} onClick={() => { void assess(preview.id, 'looks-wrong') }}>Looks wrong</button></div> : null}
          </li>
        ))}</ul> : <p>No preview was captured. A capture alone would not prove the UI is correct.</p>}
          {!remote ? <form className="result-form" onSubmit={(event) => { void capture(event) }}><label>Local preview URL<input type="url" value={previewUrl} onChange={(event) => setPreviewUrl(event.target.value)} required placeholder="http://127.0.0.1:5173/" /></label><button type="submit" className="button-soft" disabled={working || !previewUrl}>Capture preview</button></form> : null}
        </section>
        <section><h4>Gaps</h4>{result.gaps.length ? <ul>{result.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul> : <p>No recorded gaps.</p>}</section>
        {result.agentReport ? <section className="result-agent-report"><h4>Agent report</h4><p>{result.agentReport}</p><small>The agent’s words are not a host check.</small></section> : null}
      </div>
    </details>
  )
}
