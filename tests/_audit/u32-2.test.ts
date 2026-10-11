import { readFileSync, existsSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright-core'

// "Why this may not be exact" (ChangesView.tsx) is a <ul class="changes-uncertain"> inside
// <section class="changes">. git.css gives it padding that leaves room for list markers, but the
// section's `.changes ul` reset is more specific, so the cascade must still give the caveat its
// padding and its markers. Computed in a real Chromium; skipped when none can be launched here.
const css = readFileSync(new URL('../../web/src/styles/git.css', import.meta.url), 'utf8')

async function launch(): Promise<Browser | undefined> {
  const candidates = [undefined, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
  for (const executablePath of candidates) {
    if (executablePath !== undefined && !existsSync(executablePath)) continue
    try { return await chromium.launch(executablePath ? { executablePath } : {}) } catch { /* try the next */ }
  }
  return undefined
}
const browser = await launch()
afterAll(async () => { await browser?.close() })

interface Style { paddingLeft: string; paddingTop: string; listStyleType: string }

async function computed(): Promise<{ uncertain: Style; files: Style }> {
  const page = await browser!.newPage()
  try {
    await page.setContent(`<!doctype html><style>${css}</style>
      <section class="changes">
        <div class="changes-run">
          <ul class="changes-uncertain" id="uncertain"><li>A file changed while the run was working.</li><li>The folder could not be read afterwards.</li></ul>
          <div class="changes-files"><ul id="files"><li>a.ts</li><li>b.ts</li></ul></div>
        </div>
      </section>`)
    return await page.evaluate(() => {
      const pick = (id: string): Style => {
        const style = getComputedStyle(document.getElementById(id)!)
        return { paddingLeft: style.paddingLeft, paddingTop: style.paddingTop, listStyleType: style.listStyleType }
      }
      return { uncertain: pick('uncertain'), files: pick('files') }
    })
  } finally { await page.close() }
}

describe.skipIf(!browser)('u32-2: the uncertainty caveat keeps its padding and list markers', () => {
  it('pads the caveat as .changes-uncertain asks and shows its markers', async () => {
    const { uncertain } = await computed()
    expect(uncertain.paddingLeft).toBe('26px')
    expect(uncertain.paddingTop).toBe('6px')
    expect(uncertain.listStyleType).not.toBe('none')
  })

  it('still strips the markers and padding from the changed-files list', async () => {
    const { files } = await computed()
    expect(files.paddingLeft).toBe('0px')
    expect(files.listStyleType).toBe('none')
  })
})
