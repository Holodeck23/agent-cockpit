import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { CockpitBridge } from './native.ts'
import type { PreviewOpen } from '../../server/preview/types.ts'

// The bridge inside the WebKit shell (src-tauri/src/lib.rs). Same contract as electron/preload.ts;
// what the shell does not offer yet resolves to "not available" rather than failing, and the
// in-app browser is absent, so the page falls back as it does in a plain browser.

const UNAVAILABLE = 'Not available in this build yet'

function subscribe<T>(event: string, accept: (value: unknown) => value is T, listener: (value: T) => void): () => void {
  let unlisten: UnlistenFn | undefined
  let cancelled = false
  void listen(event, ({ payload }) => { if (accept(payload)) listener(payload) }).then((stop) => {
    if (cancelled) stop()
    else unlisten = stop
  })
  return () => { cancelled = true; unlisten?.() }
}

const isPreview = (value: unknown): value is PreviewOpen => {
  const preview = value as Partial<PreviewOpen> | null
  return Boolean(preview) && typeof preview!.url === 'string' && typeof preview!.projectPath === 'string' &&
    (preview!.threadId === undefined || typeof preview!.threadId === 'string')
}

export function webkitBridge(): CockpitBridge {
  return {
    platform: 'darwin',
    pickFolder: () => invoke<string | null>('pick_folder').then((path) => path ?? undefined).catch(() => undefined),
    newProject: async () => undefined,
    setTheme: (mode) => { void invoke('set_theme', { mode }) },
    revealTranscript: () => undefined,
    openFolder: () => undefined,
    copyInto: async () => ({ error: UNAVAILABLE }),
    pathForFile: () => '',
    fileAction: async () => UNAVAILABLE,
    setActivity: () => undefined,
    onPreviewOpen: (listener) => subscribe('cockpit:preview-open', isPreview, listener),
    copyText: (text) => { void invoke('copy_text', { text }) },
    notify: () => undefined,
    onOpenThread: () => () => undefined,
    appVersion: () => invoke<string>('app_version').catch(() => undefined),
    releaseNotes: async () => ({ state: 'unavailable', reason: UNAVAILABLE }),
    onShowReleaseNotes: () => () => undefined,
    onFullScreen: (listener) => subscribe('cockpit:full-screen', (v): v is boolean => typeof v === 'boolean', listener),
  }
}
