import { readFileSync, existsSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright-core'

// The iframe preview pane sits in a two-column grid beside the conversation (preview.css). Its width
// comes from the inline style, restored from localStorage with no upper clamp, so a wide saved width
// must still leave the pane inside the workspace: otherwise .workspace's overflow:hidden clips the
// right edge, which is where Reload / Browser / close sit. Laid out in a real Chromium; skipped when
// none can be launched here.
const css = readFileSync(new URL('../../web/src/styles/preview.css', import.meta.url), 'utf8')

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

interface Rects { workspaceRight: number; paneLeft: number; paneRight: number; closeRight: number }

async function layout(windowWidth: number, listWidth: number, paneWidth: number): Promise<Rects> {
  const page = await browser!.newPage({ viewport: { width: windowWidth, height: 700 } })
  try {
    await page.setContent(`<!doctype html><style>
      *{box-sizing:border-box} body{margin:0}
      .layout{position:relative;display:grid;grid-template-columns:var(--list-width,312px) minmax(0,1fr);min-height:0}
      .workspace{height:700px}
      ${css}
    </style>
    <div class="workspace has-preview" id="ws">
      <div class="workspace-main"><div class="layout" style="--list-width:${listWidth}px"><div class="list">list</div><div class="thread">chat</div></div></div>
      <aside class="preview-pane" id="pane" style="width:${paneWidth}px">
        <button type="button" class="preview-resizer"></button>
        <header class="preview-toolbar"><div class="preview-heading"><strong>Preview</strong></div>
          <div class="preview-actions"><button type="button">Reload</button><a href="#">Browser</a><button type="button" class="preview-close" id="close">x</button></div></header>
        <div class="preview-address"><span>Local</span><code>http://localhost:3000</code></div>
        <iframe></iframe>
      </aside>
    </div>`)
    return await page.evaluate(() => {
      const rect = (selector: string): DOMRect => document.querySelector(selector)!.getBoundingClientRect()
      return { workspaceRight: rect('#ws').right, paneLeft: rect('#pane').left, paneRight: rect('#pane').right, closeRight: rect('#close').right }
    })
  } finally { await page.close() }
}

describe.skipIf(!browser)('u32-1: the preview pane stays inside the workspace', () => {
  it('keeps a pane at its own width when there is room (nothing is over-capped)', async () => {
    const r = await layout(1360, 415, 520)
    expect(r.paneRight - r.paneLeft).toBe(520)
    expect(r.paneRight).toBe(r.workspaceRight)
  })

  it.each<[string, number, number, number]>([
    ['a saved width wider than the room, in the default 1360 window', 1360, 415, 1100],
    ['a saved width wider than the room, in a 1280 window', 1280, 312, 1100],
    ['a saved width wider than the room, just above the 1120 breakpoint', 1121, 260, 1100],
    ['a saved width wider than the room, below the 1120 breakpoint', 1110, 260, 900],
  ])('%s: the pane and its close button are not clipped', async (_name, windowWidth, listWidth, paneWidth) => {
    const r = await layout(windowWidth, listWidth, paneWidth)
    expect(r.paneRight).toBeLessThanOrEqual(r.workspaceRight)
    expect(r.closeRight).toBeLessThanOrEqual(r.workspaceRight)
    // The conversation column keeps the minimum the grid reserves for it.
    expect(r.paneLeft).toBeGreaterThanOrEqual(360)
  })
})
