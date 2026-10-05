import type { WebContents } from 'electron'
import type { ActOutcome, AgentInput, AgentPageInfo, BrowserHost, Capture, PageRead } from '../server/browser/agent.ts'
import { originOf } from '../server/browser/agent-policy.ts'
import { dragPath, insideViewport, KEY_EVENTS, refParts } from './browser-policy.ts'
import type { BrowserService } from './browser-service.ts'
import { withinTime } from './one-at-a-time.ts'

// The agent's hands on a conversation's page (H3, wave 9). server/browser/agent.ts has already
// decided the call may happen; this runs it against the page itself. Reads run in an isolated
// world (the page's own scripts cannot see or replace them); input is real Chromium input through
// sendInputEvent, which also reaches a page the person is not looking at (order 11 experiment).
// Input to one page runs one at a time, is checked against the expected revision and origin right
// before it is sent, and is never retried.

/** Cockpit's isolated world in every page: element refs live here and die with the document. */
const WORLD = 1717
const LOAD_WAIT_MS = 15_000
const SCRIPT_MS = 5_000
const CAPTURE_MS = 10_000
const SETTLE_MS = 150
const SCROLL_SETTLE_MS = 450
const MAX_ELEMENTS = 150
const MAX_TEXT = 6000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Lists the visible interactive elements and keeps them, under this revision, for later input. */
const readScript = (revision: number): string => `(() => {
  const vw = innerWidth, vh = innerHeight, list = [], elements = []
  const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"]),' +
    ['button','link','checkbox','radio','tab','menuitem','switch','textbox','combobox','option','slider'].map((r) => '[role=' + r + ']').join(',')
  const buttonTypes = ['button', 'submit', 'reset']
  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= ${MAX_ELEMENTS}) break
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    const tag = el.tagName
    const role = el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' })[tag]
      || (tag === 'INPUT' ? (el.type === 'checkbox' || el.type === 'radio' ? el.type : buttonTypes.includes(el.type) ? 'button' : 'textbox') : el.isContentEditable ? 'textbox' : 'generic')
    // Never a field's value: a button's label is the only value read.
    const name = el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '')
      || (tag === 'INPUT' && buttonTypes.includes(el.type) ? el.value : '') || (tag === 'INPUT' || tag === 'TEXTAREA' ? '' : el.innerText)
      || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || ''
    list.push(el)
    elements.push({ ref: 'e${revision}-' + (list.length - 1), role, name: String(name).replace(/\\s+/g, ' ').trim().slice(0, 100),
      x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) })
  }
  globalThis.__cockpitRefs = { revision: ${revision}, list }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n')
  return { text: text.slice(0, ${MAX_TEXT}), truncated: text.length > ${MAX_TEXT} || elements.length >= ${MAX_ELEMENTS}, elements,
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY) } }
})()`

/** Where an element from the last read is now: scrolled into view and not covered by something else. */
const pointScript = (revision: number, index: number): string => `(() => {
  const refs = globalThis.__cockpitRefs
  if (!refs || refs.revision !== ${revision}) return { result: 'stale' }
  const el = refs.list[${index}]
  if (!el || !el.isConnected) return { result: 'gone' }
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const b = el.getBoundingClientRect()
  const x = b.left + b.width / 2, y = b.top + b.height / 2
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { result: 'outside' }
  const hit = document.elementFromPoint(x, y)
  if (!hit || !(hit === el || el.contains(hit))) return { result: 'covered' }
  return { result: 'ok', x, y }
})()`

const SCROLL_SCRIPT = '({ x: Math.round(scrollX), y: Math.round(scrollY) })'

export function createBrowserAgentHost(service: BrowserService): BrowserHost {
  const queues = new Map<string, Promise<unknown>>()
  /** Input to one page runs one action at a time; a failed action never blocks the next. */
  const serial = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(run, run)
    queues.set(key, next.catch(() => undefined))
    return next
  }

  function info(key: string): AgentPageInfo | undefined {
    const page = service.agentPage(key)
    const state = service.state(key)
    if (!page || !state) return undefined
    return {
      pageId: key, revision: page.revision, url: state.url, origin: originOf(state.url) ?? 'null', title: state.title,
      loading: state.loading, viewport: page.viewport, timestamp: new Date().toISOString(), ...(state.error ? { error: state.error } : {}),
    }
  }
  const gone = (key: string): AgentPageInfo => ({ pageId: key, revision: -1, url: '', origin: 'null', title: '', loading: false, viewport: { width: 0, height: 0 }, timestamp: new Date().toISOString() })
  const contentsOf = (key: string): WebContents => {
    const page = service.agentPage(key)
    if (!page) throw new Error('This conversation’s page is gone. Open it again with browser_navigate.')
    return page.contents
  }
  const run = <T>(contents: WebContents, code: string): Promise<T> =>
    withinTime(contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) as Promise<T>, SCRIPT_MS, `The page did not answer within ${SCRIPT_MS / 1000} s`)

  /** Until the page stops loading, or a bounded wait passes; the result says if it is still loading. */
  async function settle(contents: WebContents): Promise<void> {
    const deadline = Date.now() + LOAD_WAIT_MS
    await sleep(50)
    while (!contents.isDestroyed() && contents.isLoading() && Date.now() < deadline) await sleep(100)
  }

  async function act(key: string, input: AgentInput, expect: { revision: number; origin: string }): Promise<ActOutcome> {
    const page = service.agentPage(key)
    if (!page) return { outcome: 'gone', detail: 'This conversation’s page is gone. Open it again with browser_navigate.', page: gone(key) }
    const contents = page.contents
    const now = (): AgentPageInfo => info(key) ?? gone(key)
    const changed = (): boolean => {
      const current = info(key)
      return !current || current.revision !== expect.revision || current.origin !== expect.origin
    }
    const refuse = (outcome: 'stale' | 'gone' | 'covered' | 'outside', detail: string): ActOutcome => ({ outcome, detail, page: now() })
    const STALE = 'The page changed since that revision (navigation, resize or another site). Nothing was done: read it again.'
    if (changed()) return refuse('stale', STALE)

    // The point to act on: an element from the last read at this revision, or CSS pixels.
    let point: { x: number; y: number } | undefined
    if ('ref' in input && input.ref !== undefined) {
      const parts = refParts(input.ref)
      if (!parts || parts.revision !== expect.revision) return refuse('stale', `That ref belongs to another revision (${input.ref}). Nothing was done: read the page again.`)
      const found = await run<{ result: string; x?: number; y?: number }>(contents, pointScript(parts.revision, parts.index))
      if (found.result !== 'ok') {
        const why: Record<string, [ 'stale' | 'gone' | 'covered' | 'outside', string ]> = {
          stale: ['stale', STALE], gone: ['gone', 'That element is no longer on the page. Nothing was done.'],
          covered: ['covered', 'Something else covers that element. Nothing was done.'], outside: ['outside', 'That element is outside the viewport. Nothing was done.'],
        }
        const [outcome, detail] = why[found.result] ?? why.stale!
        return refuse(outcome, detail)
      }
      point = { x: found.x!, y: found.y! }
    } else if ('x' in input && input.x !== undefined && input.y !== undefined) {
      point = { x: input.x, y: input.y }
    } else if (input.kind === 'scroll') {
      point = { x: page.viewport.width / 2, y: page.viewport.height / 2 }
    }
    if (point && !insideViewport(point.x, point.y, page.viewport)) return refuse('outside', `(${point.x}, ${point.y}) is outside the ${page.viewport.width}×${page.viewport.height} viewport. Nothing was done.`)
    if (input.kind === 'drag' && !(insideViewport(input.from.x, input.from.y, page.viewport) && insideViewport(input.to.x, input.to.y, page.viewport))) {
      return refuse('outside', `The drag must start and end inside the ${page.viewport.width}×${page.viewport.height} viewport. Nothing was done.`)
    }

    // The last check, with nothing awaited between it and the input it guards.
    if (changed()) return refuse('stale', STALE)
    const send = (event: Parameters<WebContents['sendInputEvent']>[0]): void => contents.sendInputEvent(event)
    const click = (p: { x: number; y: number }): void => {
      send({ type: 'mouseMove', x: p.x, y: p.y })
      send({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      send({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    }
    let detail: string
    switch (input.kind) {
      case 'click': click(point!); detail = `Clicked at (${Math.round(point!.x)}, ${Math.round(point!.y)}).`; break
      case 'hover': send({ type: 'mouseMove', x: point!.x, y: point!.y }); detail = `Pointer at (${Math.round(point!.x)}, ${Math.round(point!.y)}).`; break
      case 'type': {
        if (point) {
          click(point)
          await sleep(60)
          // Clicking may have navigated: the text goes nowhere but the field that was meant.
          if (changed()) return refuse('stale', 'The page changed after the click, before typing. The click happened; nothing was typed.')
        }
        await withinTime(contents.insertText(input.text), SCRIPT_MS, `The page did not take the text within ${SCRIPT_MS / 1000} s`)
        detail = `Typed ${input.text.length} characters${point ? ` at (${Math.round(point.x)}, ${Math.round(point.y)})` : ' into the focused element'}.`
        break
      }
      case 'key': {
        const key = KEY_EVENTS[input.key]!
        const modifiers = [...(input.modifiers ?? [])] as Array<'shift' | 'alt' | 'control' | 'meta'>
        send({ type: 'keyDown', keyCode: key.keyCode, modifiers })
        if (key.char && modifiers.length === 0) send({ type: 'char', keyCode: key.char })
        send({ type: 'keyUp', keyCode: key.keyCode, modifiers })
        detail = `Pressed ${[...modifiers, input.key].join('+')}.`
        break
      }
      case 'scroll': {
        // Chromium's wheel delta points the other way: negative scrolls down. A move first, so a
        // page in the background targets the right element (order 11 experiment, run4).
        send({ type: 'mouseMove', x: point!.x, y: point!.y })
        send({ type: 'mouseWheel', x: point!.x, y: point!.y, deltaX: -input.dx, deltaY: -input.dy })
        await sleep(SCROLL_SETTLE_MS)
        const scroll = await run<{ x: number; y: number }>(contents, SCROLL_SCRIPT).catch(() => undefined)
        detail = scroll ? `Scrolled; the page is now at (${scroll.x}, ${scroll.y}).` : 'Scrolled.'
        return { outcome: 'done', detail, page: now() }
      }
      case 'drag': {
        send({ type: 'mouseMove', x: input.from.x, y: input.from.y })
        send({ type: 'mouseDown', x: input.from.x, y: input.from.y, button: 'left', clickCount: 1 })
        for (const p of dragPath(input.from, input.to, input.steps)) send({ type: 'mouseMove', x: p.x, y: p.y, button: 'left', modifiers: ['leftbuttondown'] })
        send({ type: 'mouseUp', x: input.to.x, y: input.to.y, button: 'left', clickCount: 1 })
        detail = `Dragged from (${input.from.x}, ${input.from.y}) to (${input.to.x}, ${input.to.y}).`
        break
      }
    }
    await sleep(SETTLE_MS)
    return { outcome: 'done', detail, page: now() }
  }

  return {
    info,
    async ensure(key, projectPath) {
      const full = await service.ensure(key, projectPath)
      if (full) throw new Error(full)
      return info(key) ?? gone(key)
    },
    async goto(key, url) {
      const contents = contentsOf(key)
      const refused = service.load(key, url)
      if (refused) throw new Error(refused)
      await settle(contents)
      return info(key) ?? gone(key)
    },
    historyUrl(key, direction) {
      const history = service.agentPage(key)?.contents.navigationHistory
      if (!history) return undefined
      const index = history.getActiveIndex() + (direction === 'back' ? -1 : 1)
      return index >= 0 && index < history.length() ? history.getEntryAtIndex(index)?.url : undefined
    },
    async history(key, action) {
      const contents = contentsOf(key)
      service.navigate(key, action)
      await settle(contents)
      return info(key) ?? gone(key)
    },
    async read(key): Promise<PageRead> {
      const contents = contentsOf(key)
      const page = info(key) ?? gone(key)
      const read = await run<Omit<PageRead, 'page'>>(contents, readScript(page.revision))
      return { page, ...read }
    },
    async capture(key): Promise<Capture> {
      const contents = contentsOf(key)
      // A page that changes while it is captured is captured again, once, so the image and the
      // revision it reports belong together.
      for (let attempt = 0; ; attempt++) {
        const before = info(key) ?? gone(key)
        const image = await withinTime(contents.capturePage(undefined, { stayHidden: true }), CAPTURE_MS, `The page could not be captured within ${CAPTURE_MS / 1000} s`)
        const after = info(key)
        if (after?.revision === before.revision || attempt >= 1) {
          const { width, height } = before.viewport
          const sized = image.isEmpty() || width < 1 ? image : image.resize({ width, height, quality: 'best' })
          const size = sized.getSize()
          return { data: sized.toPNG().toString('base64'), mimeType: 'image/png', width: size.width, height: size.height, page: after ?? before }
        }
      }
    },
    act: (key, input, expect) => serial(key, () => act(key, input, expect)),
  }
}
