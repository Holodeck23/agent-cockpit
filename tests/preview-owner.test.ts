import { describe, expect, it } from 'vitest'
import type { ProcessInfo } from '../server/processes/runner.ts'
import { forgetPreview, previewKey, previewUrl, processPreview, rememberPreview } from '../web/src/preview-owner.ts'

const process = (id: string, projectPath: string, threadId: string, url: string): ProcessInfo => ({
  id, projectPath, cwd: projectPath, command: 'npm run dev', name: 'site', status: 'running', pid: 1, exitCode: null, signal: null,
  startedAt: '2026-10-05T10:00:00.000Z', url, owner: { kind: 'conversation', threadId, title: threadId },
})

describe('owned previews (W7.3)', () => {
  it('keeps unrelated conversation and workspace previews in independent slots', () => {
    const a = processPreview(process('a', '/project', 'thread-a', 'http://127.0.0.1:3001/'))!
    const b = processPreview(process('b', '/project', 'thread-b', 'http://127.0.0.1:3002/'))!
    const workspace = { url: 'http://127.0.0.1:3003/', projectPath: '/project' }
    const previews = rememberPreview(rememberPreview(rememberPreview({}, a), b), workspace)

    expect(previewKey(a)).toBe('thread:thread-a')
    expect(previewUrl(previews, a)).toBe(a.url)
    expect(previewUrl(previews, b)).toBe(b.url)
    expect(previewUrl(previews, workspace)).toBe(workspace.url)
    expect(previewUrl(forgetPreview(previews, b), a)).toBe(a.url)

    const updatedB = { ...b, url: 'http://127.0.0.1:3004/new' }
    const whileViewingA = rememberPreview(previews, updatedB)
    expect(previewUrl(whileViewingA, a)).toBe(a.url)
    expect(previewUrl(whileViewingA, b)).toBe(updatedB.url)
  })

  it('routes conversation-owned processes to their owner and project processes to the workspace', () => {
    expect(processPreview(process('a', '/one', 'thread-a', 'http://localhost:4000/'))).toMatchObject({ projectPath: '/one', threadId: 'thread-a' })
    expect(processPreview({ ...process('p', '/one', 'thread-a', 'http://localhost:4001/'), owner: { kind: 'project' } })).toEqual({ projectPath: '/one', url: 'http://localhost:4001/' })
    expect(processPreview({ ...process('x', '/one', 'thread-a', 'http://localhost:4002/'), status: 'exited' })).toBeUndefined()
  })

  it('gives a worktree its own project page, so its website data stays with its folder', () => {
    const wt = processPreview({ ...process('w', '/one', 'thread-a', 'http://localhost:4003/'), cwd: '/one-worktree-ab12cd', owner: { kind: 'project' } })!
    expect(wt).toMatchObject({ projectPath: '/one', cwd: '/one-worktree-ab12cd' })
    expect(previewKey(wt)).toBe('project:/one-worktree-ab12cd')
    expect(previewKey({ projectPath: '/one' })).toBe('project:/one')
    // A conversation's page is the conversation's whichever folder it works in.
    expect(previewKey({ projectPath: '/one', cwd: '/one-worktree-ab12cd', threadId: 't' })).toBe('thread:t')
  })
})
