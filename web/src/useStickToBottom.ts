// A conversation follows new output only while you're reading its end. Scroll up and it stays
// where you are; "Jump to latest" appears when something new arrives. Layout changes (a
// growing composer, a step that expands, images that load) keep a reader at the bottom there.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const SLACK = 40

export function nearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK
}

/**
 * `resetKey` (the conversation id) starts at the bottom again; `contentKey` changes when new
 * output arrives; `sentKey` changes when you send a message, which jumps to the bottom once.
 */
export function useStickToBottom(
  scroller: RefObject<HTMLElement | null>,
  resetKey: string,
  contentKey: string,
  sentKey: string,
): { hasNew: boolean; jumpToLatest: () => void } {
  const pinned = useRef(true)
  const [hasNew, setHasNew] = useState(false)

  const toBottom = useCallback(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    pinned.current = true
    setHasNew(false)
  }, [scroller])

  useLayoutEffect(() => {
    toBottom()
  }, [resetKey, toBottom])

  useLayoutEffect(() => {
    if (pinned.current) toBottom()
    else setHasNew(true)
  }, [contentKey, toBottom])

  useLayoutEffect(() => {
    toBottom()
  }, [sentKey, toBottom])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = (): void => {
      pinned.current = nearBottom(el)
      if (pinned.current) setHasNew(false)
    }
    // Resizes of the view or of what is inside it keep a pinned reader at the end.
    const observer = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight })
    observer.observe(el)
    for (const child of Array.from(el.children)) observer.observe(child)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [scroller, resetKey])

  return { hasNew, jumpToLatest: toBottom }
}
