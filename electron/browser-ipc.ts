import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { pageKeyOk } from './browser-policy.ts'
import type { BrowserService, NavAction } from './browser-service.ts'

// The page's side of the in-app browser. Only Cockpit's own page in the main window may drive it;
// every value is checked here before it reaches the service.

const ACTIONS: readonly NavAction[] = ['back', 'forward', 'reload', 'stop']

export function registerBrowserIpc(origin: string, service: BrowserService, isProject: (path: string) => boolean, isMainWindow: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean): void {
  const fromCockpit = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    try {
      return Boolean(event.senderFrame) && new URL(event.senderFrame!.url).origin === origin && isMainWindow(event)
    } catch {
      return false
    }
  }
  ipcMain.handle('cockpit:browser-open', (event, request: unknown) => {
    if (!fromCockpit(event)) return { error: 'Not allowed' }
    const { key, projectPath, url } = (request ?? {}) as Record<string, unknown>
    if (!pageKeyOk(key) || typeof projectPath !== 'string' || !isProject(projectPath) || typeof url !== 'string' || url.length > 8192) return { error: 'Not a page Cockpit can open' }
    return service.open(key, projectPath, url)
  })
  ipcMain.on('cockpit:browser-place', (event, request: unknown) => {
    if (!fromCockpit(event)) return
    const { key, rect } = (request ?? {}) as Record<string, unknown>
    if (pageKeyOk(key)) service.place(key, rect ?? null)
  })
  ipcMain.on('cockpit:browser-nav', (event, request: unknown) => {
    if (!fromCockpit(event)) return
    const { key, action } = (request ?? {}) as Record<string, unknown>
    if (pageKeyOk(key) && ACTIONS.includes(action as NavAction)) service.navigate(key, action as NavAction)
  })
  ipcMain.handle('cockpit:browser-state', (event, key: unknown) => (fromCockpit(event) && pageKeyOk(key) ? service.state(key) : undefined))
  ipcMain.on('cockpit:browser-external', (event, key: unknown) => { if (fromCockpit(event) && pageKeyOk(key)) service.openExternal(key) })
  ipcMain.on('cockpit:browser-close', (event, key: unknown) => { if (fromCockpit(event) && pageKeyOk(key)) service.close(key) })
  ipcMain.handle('cockpit:browser-clear', async (event, projectPath: unknown) => {
    if (!fromCockpit(event) || typeof projectPath !== 'string' || !isProject(projectPath)) return 'Not a project'
    return service.clearData(projectPath)
  })
}
