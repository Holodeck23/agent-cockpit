import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { findCommit, remoteWebUrl } from '../server/git/commits.ts'
import { startServer } from '../server/start.ts'
import { TURN_GUIDANCE } from '../server/threads/turns.ts'
import { ReplyContext, ReplyMarkdown } from '../web/src/markdown/reply.tsx'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' }).trim()
function repo(remote?: string): { root: string; sha: string } {
  const root = join(mkdtempSync(join(tmpdir(), 'cockpit-commit-')), 'project')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'first')
  if (remote) git(root, 'remote', 'add', 'origin', remote)
  return { root, sha: git(root, 'rev-parse', 'HEAD') }
}

describe('a commit\'s web page', () => {
  it('reads the common remote forms for GitHub, GitLab and Bitbucket', () => {
    expect(remoteWebUrl('git@github.com:acme/app.git')).toBe('https://github.com/acme/app')
    expect(remoteWebUrl('https://github.com/acme/app.git')).toBe('https://github.com/acme/app')
    expect(remoteWebUrl('https://user:token@github.com/acme/app')).toBe('https://github.com/acme/app')
    expect(remoteWebUrl('ssh://git@gitlab.com/group/sub/app.git')).toBe('https://gitlab.com/group/sub/app')
    expect(remoteWebUrl('git@bitbucket.org:team/app.git')).toBe('https://bitbucket.org/team/app')
  })
  it('has none for local or unknown hosts', () => {
    for (const url of ['/srv/git/app.git', 'file:///srv/app.git', 'git@git.internal:acme/app.git', 'https://evil.example/github.com/x', '']) expect(remoteWebUrl(url), url).toBeUndefined()
  })
  it('finds a real commit by its short hash and links it on the host', async () => {
    const { root, sha } = repo('git@github.com:acme/app.git')
    expect(await findCommit(root, sha.slice(0, 7))).toEqual({ hash: sha, url: `https://github.com/acme/app/commit/${sha}` })
    const gitlab = repo('https://gitlab.com/acme/app.git')
    expect((await findCommit(gitlab.root, gitlab.sha.slice(0, 9)))?.url).toBe(`https://gitlab.com/acme/app/-/commit/${gitlab.sha}`)
  })
  it('without a web remote there is a commit but no page; unknown or malformed hashes are not commits', async () => {
    const { root, sha } = repo()
    expect(await findCommit(root, sha.slice(0, 8))).toEqual({ hash: sha })
    expect(await findCommit(root, 'abc1234')).toBeUndefined()
    expect(await findCommit(root, 'HEAD')).toBeUndefined()
    expect(await findCommit(root, '--all')).toBeUndefined()
    expect(await findCommit(mkdtempSync(join(tmpdir(), 'cockpit-plain-')), sha.slice(0, 7))).toBeUndefined()
  })
  it('is served for open projects only', async () => {
    const { root, sha } = repo('git@github.com:acme/app.git')
    const server = await startServer({ port: 0, stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-commit-state-')), webDist: root })
    const get = (hash: string) => fetch(`${server.url}/api/git/commit?${new URLSearchParams({ projectPath: root, hash })}`)
    try {
      expect((await get(sha.slice(0, 7))).status).toBe(404)
      await fetch(`${server.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: root }) })
      expect((await (await get(sha.slice(0, 7))).json()).data).toEqual({ hash: sha, url: `https://github.com/acme/app/commit/${sha}` })
      expect((await get('abc1234')).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('commit hashes in replies', () => {
  const html = (text: string): string => renderToStaticMarkup(
    createElement(ReplyContext.Provider, { value: { projectPath: '/work/app', onOpenFile: () => {}, onOpenCommit: async () => 'opened' as const } }, createElement(ReplyMarkdown, { text })))
  it('links a code span that is a hash, and the hash after "commit" in prose', () => {
    const out = html('Committed as `3f9c2ab`. Also see commit 81e0d4cf9 and the fix in a1b2c3d.')
    expect(out).toContain('data-commit="3f9c2ab"')
    expect(out).toContain('data-commit="81e0d4cf9"')
    expect(out.match(/data-commit=/g)).toHaveLength(2)
  })
  it('leaves words, numbers and long code alone', () => {
    const out = html('`deadbeef` `1234567` `abc` `not-a-hash1` commit message and commit 12345')
    expect(out).not.toContain('data-commit')
  })
  it('asks agents to name their commits by short hash', () => {
    expect(TURN_GUIDANCE).toMatch(/short hash/)
  })
})
