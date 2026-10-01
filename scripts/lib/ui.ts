// Shared UI steps for the proof scripts, so every proof drives the page the way a person would.
import type { Locator, Page } from 'playwright-core'

/** Same-origin POST from inside the page, so it passes the loopback guard like the UI does. */
export async function apiPost(page: Page, path: string, body: unknown): Promise<unknown> {
  return page.evaluate(
    async ([p, b]) => {
      const res = await fetch(p as string, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
      return res.json() as Promise<unknown>
    },
    [path, body] as const,
  )
}

/** Registers and pins a folder, makes it the active project, and reloads onto it. */
export async function openProject(page: Page, dir: string, name?: string): Promise<void> {
  await apiPost(page, '/api/projects', { path: dir, pinned: true, ...(name ? { name } : {}) })
  await page.evaluate((path) => localStorage.setItem('cockpit:active-project', path), dir)
  await page.reload()
  await page.getByRole('tab', { selected: true }).first().waitFor()
}

/** Sets the new-conversation agent picker (remembered for later conversations). */
export async function chooseAgent(page: Page, choice: { agent?: 'claude' | 'codex' | 'antigravity' | 'opencode'; model?: string; permissions?: string }): Promise<void> {
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const panel = page.getByRole('dialog', { name: 'Agent settings' })
  if (choice.agent) await panel.getByRole('radio', { name: { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' }[choice.agent], exact: true }).click()
  if (choice.model !== undefined) await panel.getByLabel('Model').fill(choice.model)
  if (choice.permissions) await panel.getByLabel('Permissions').selectOption(choice.permissions)
  await page.keyboard.press('Escape')
}

export function messageBox(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Message' })
}

/** New conversation in the active project; waits until the conversation is open. */
export async function startConversation(page: Page, prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).fill(prompt)
  await messageBox(page).press('Enter')
  await page.getByRole('heading', { level: 1, name: prompt.slice(0, 20) }).waitFor({ timeout: 15_000 })
}

/** The coloured status word under the conversation title. */
export function headStatus(page: Page): Locator {
  return page.locator('.thread-status .status-text')
}

/** Picks a theme in the top bar's Appearance popover, then closes it. */
export async function setTheme(page: Page, theme: 'System' | 'Light' | 'Dark'): Promise<void> {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.getByRole('dialog', { name: 'Appearance' }).getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: theme, exact: true }).click()
  await page.keyboard.press('Escape')
}
