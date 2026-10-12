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
export async function chooseAgent(page: Page, choice: { agent?: 'claude' | 'codex' | 'antigravity' | 'opencode'; model?: string; effort?: string; permissions?: string }): Promise<void> {
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const panel = page.getByRole('dialog', { name: 'Agent settings' })
  if (choice.agent) await panel.getByRole('radio', { name: { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' }[choice.agent], exact: true }).click()
  if (choice.model !== undefined) {
    // A menu once the agent has listed its models (Antigravity after a check), a text box otherwise.
    const model = panel.getByLabel('Model')
    // Claude Code's menu takes a full model id through Other.
    const listed = await model.evaluate((el, value) => el instanceof HTMLSelectElement && [...el.options].some((o) => o.value === value), choice.model)
    if (listed) await model.selectOption(choice.model)
    else if (await model.evaluate((el) => el.tagName === 'SELECT')) {
      await model.selectOption('__other__')
      await panel.getByLabel('Claude model id').fill(choice.model)
    } else await model.fill(choice.model)
  }
  if (choice.effort !== undefined) await panel.getByLabel('Effort').selectOption(choice.effort)
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

/**
 * Switches agents from an open picker the way a person does since D13: "Switch…" shows the
 * handoff, "Start handoff" sends exactly that. Resolves to the text that was shown.
 */
export async function switchWithHandoff(picker: Locator): Promise<string> {
  await picker.getByRole('button', { name: 'Switch…', exact: true }).click()
  const shown = picker.getByRole('group', { name: 'Handoff' }).getByLabel('Handoff text')
  await shown.waitFor()
  const text = (await shown.textContent()) ?? ''
  await picker.getByRole('button', { name: 'Start handoff', exact: true }).click()
  await picker.waitFor({ state: 'detached' })
  return text
}
