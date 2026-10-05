// Opening a file that can run asks first (PR #15), run against the packaged app. The native dialog
// and shell.openPath are replaced in the main process, so nothing is ever really opened or run:
// the proof records what Cockpit would show and whether it would open the file.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:open-file
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, launchPackagedApp } from './lib/launch-app.ts'
import { openProject } from './lib/ui.ts'

const dir = mkdtempSync(join(tmpdir(), 'cockpit-open-file-proof-'))
writeFileSync(join(dir, 'notes.md'), '# Notes\n')
// Reads as "Invoice-dnammoc.pdf" when the right-to-left override is rendered.
const spoofed = 'Invoice-‮fdp.command'
writeFileSync(join(dir, spoofed), '#!/bin/sh\necho never run\n')
chmodSync(join(dir, spoofed), 0o755)
writeFileSync(join(dir, 'setup.terminal'), '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n')
symlinkSync('setup.terminal', join(dir, 'README.md'))

const { check, finish } = checker()
const app = await launchPackagedApp()
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

interface Seen { dialogs: Array<{ message: string; detail: string; buttons: string[] }>; opened: string[]; answer: number }
const seen = (): Promise<Seen> => app.evaluate(() => (globalThis as unknown as { proofSeen: Seen }).proofSeen)
const answer = (response: number): Promise<void> => app.evaluate((_e, r) => { (globalThis as unknown as { proofSeen: Seen }).proofSeen.answer = r }, response)
const open = (path: string): Promise<string | undefined> => page.evaluate(({ projectPath, path }) =>
  (window as unknown as { cockpit: { fileAction(r: object): Promise<string | undefined> } }).cockpit.fileAction({ projectPath, space: 'project', path, action: 'open' }), { projectPath: dir, path })

try {
  await openProject(page, dir, 'Open file demo')
  await app.evaluate(({ dialog, shell }) => {
    const g = globalThis as unknown as { proofSeen: Seen }
    g.proofSeen = { dialogs: [], opened: [], answer: 0 }
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail: string; buttons: string[] }
      g.proofSeen.dialogs.push({ message: options.message, detail: options.detail, buttons: options.buttons })
      return { response: g.proofSeen.answer, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
    shell.openPath = (async (path: string) => { g.proofSeen.opened.push(path); return '' }) as typeof shell.openPath
  })

  await open('notes.md')
  let now = await seen()
  check('a document opens without asking', now.dialogs.length === 0 && now.opened.length === 1 && now.opened[0]!.endsWith('/notes.md'), now.opened.join(', '))

  await answer(0)
  await open(spoofed)
  now = await seen()
  const asked = now.dialogs.at(-1)
  check('a runnable file asks first', now.dialogs.length === 1 && asked?.buttons.join('/') === 'Cancel/Open', asked?.detail)
  check('the dialog shows the hidden character instead of obeying it', Boolean(asked?.message.includes('⟨U+202E⟩')) && !asked?.message.includes('‮'), asked?.message)
  check('Cancel leaves it unopened', now.opened.length === 1)

  await answer(1)
  await open(spoofed)
  now = await seen()
  check('Open opens it after you confirm', now.opened.length === 2 && now.opened[1]!.includes('.command'))

  await answer(0)
  await open('README.md')
  now = await seen()
  const linked = now.dialogs.at(-1)
  check('a link named like a document asks with the real file’s name', now.dialogs.length === 3 && Boolean(linked?.message.includes('setup.terminal')), linked?.message)
  check('and stays unopened on Cancel', now.opened.length === 2)
} finally {
  await app.close()
}
finish('PROOF OPEN-FILE')
