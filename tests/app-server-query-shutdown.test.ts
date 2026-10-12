import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAppServerQueryScope, queryAppServer } from '../server/agents/codex/app-server-query.ts'

function fixture(answer: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-query-shutdown-'))
  const executable = join(dir, 'codex')
  const pidFile = join(dir, 'pid')
  writeFileSync(executable, `#!/usr/bin/perl
use strict; use warnings; $| = 1;
open(my $f, '>', '${pidFile}'); print $f $$; close $f;
while (my $line = <STDIN>) {
  if ($line =~ /"id":1,/) { print qq({"id":1,"result":{}}\n) }
  elsif ($line =~ /"id":2,/ && ${answer ? '1' : '0'}) { print qq({"id":2,"result":{"ok":true}}\n) }
}
`)
  chmodSync(executable, 0o755)
  return { executable, pidFile }
}

const dead = (pid: number): boolean => {
  try { process.kill(pid, 0); return false } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    return true
  }
}

it('does not return a query answer before its helper has exited', async () => {
  const f = fixture(true)
  const answer = await queryAppServer(f.executable, 'account/read', {}, { timeoutMs: 5_000 })
  expect(answer.result).toEqual({ ok: true })
  expect(dead(Number(readFileSync(f.pidFile, 'utf8')))).toBe(true)
})

it('server shutdown closes a pending helper and prevents a late probe from spawning another', async () => {
  const f = fixture(false)
  const scope = createAppServerQueryScope()
  const waiting = scope.query(f.executable, 'account/read', {}, { timeoutMs: 20_000 })
  try {
    const deadline = Date.now() + 3_000
    while (!existsSync(f.pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(existsSync(f.pidFile)).toBe(true)
    const pid = Number(readFileSync(f.pidFile, 'utf8'))
    await scope.close()
    expect(dead(pid)).toBe(true)
    expect(await waiting).toEqual({ error: 'Cockpit is shutting down' })
    const late = fixture(false)
    expect(await scope.query(late.executable, 'model/list', {}, { timeoutMs: 20_000 })).toEqual({ error: 'Cockpit is shutting down' })
    expect(existsSync(late.pidFile)).toBe(false)
  } finally { await scope.close() }
})
