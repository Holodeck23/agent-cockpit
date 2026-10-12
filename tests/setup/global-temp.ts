// Vitest globalSetup: every test file's temp dirs land in one short folder that is removed when
// the run ends, passed or failed. Tests and the code they exercise call os.tmpdir() / mkdtemp,
// which read TMPDIR on every call; vitest starts its workers after this runs, so they inherit it.
// Nothing here is read by a test; tests/temp-run.test.ts proves the redirect reaches the workers.
import { createRunFolder, removeRunFolder } from '../../scripts/lib/temp-run.ts'

export default function setup(): () => void {
  const before = process.env.TMPDIR
  const dir = createRunFolder()
  process.env.TMPDIR = dir
  let done = false
  const teardown = (): void => {
    if (done) return
    done = true
    if (before === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = before
    removeRunFolder(dir)
  }
  // Vitest calls the returned teardown, including after failures. The exit hook covers a run that
  // is stopped without reaching it; only SIGKILL leaves the folder, and scripts/clean.ts sweeps that.
  process.once('exit', teardown)
  return teardown
}
