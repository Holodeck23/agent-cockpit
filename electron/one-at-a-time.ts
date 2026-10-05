// Preview captures share one in-memory session that is cleared after each, so they run one at a
// time. A queue like that turns one page that never finishes loading into a stall for every
// capture after it, so each step is also given a time limit.

/** Runs calls of `task` one after another; a failed call never blocks the next. */
export function oneAtATime<A extends unknown[], R>(task: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let queue: Promise<unknown> = Promise.resolve()
  return (...args) => {
    const run = queue.then(() => task(...args), () => task(...args))
    queue = run.catch(() => undefined)
    return run
  }
}

/**
 * `work`, or a rejection with `message` once `ms` pass. `onTimeout` runs first (stop the load).
 * The late outcome of `work` is swallowed so it cannot surface as an unhandled rejection.
 */
export function withinTime<T>(work: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
  work.catch(() => undefined)
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.() } catch { /* the window may already be gone */ }
      reject(new Error(message))
    }, ms)
    work.then((value) => { clearTimeout(timer); resolve(value) }, (error: unknown) => { clearTimeout(timer); reject(error) })
  })
}
