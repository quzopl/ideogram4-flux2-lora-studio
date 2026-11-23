// The job polling loop, outside React (the batch runs this way). No imports: the unit spec loads this file in Node.

/** The states a job ends in. */
export const JOB_ENDS: readonly string[] = ['done', 'error', 'cancelled']

export const isJobEnd = (state: string | undefined) => JOB_ENDS.includes(state ?? '')

/** Resolves after `ms`, rejects as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const done = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const t = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(t)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export interface PollOptions<J> {
  signal?: AbortSignal
  intervalMs?: number
  onUpdate?: (job: J) => void
}

/**
 * Polls a job with `get` until it ends, with useJobPoll's rules: a failed
 * poll is waited out, the job ending (`done`, `error`, `cancelled`) resolves
 * with it, an error `isGone` accepts resolves with "gone" (e.g. the server was
 * restarted). `onUpdate` gets every answer. Aborting `signal` rejects with its
 * reason.
 */
export async function pollJobCore<J extends { state: string }>(
  get: (jobId: string, signal?: AbortSignal) => Promise<J>,
  isGone: (e: unknown) => boolean,
  jobId: string,
  opts: PollOptions<J> = {},
): Promise<J | 'gone'> {
  const { signal, intervalMs = 700, onUpdate } = opts
  for (;;) {
    signal?.throwIfAborted()
    let job: J
    try {
      job = await get(jobId, signal)
    } catch (e) {
      signal?.throwIfAborted()
      if (isGone(e)) return 'gone'
      // Anything else (the server busy or briefly away): try again.
      await sleep(intervalMs, signal)
      continue
    }
    // Outside the try: a throwing onUpdate is the caller's error, not a failed poll to retry.
    onUpdate?.(job)
    if (isJobEnd(job.state)) return job
    await sleep(intervalMs, signal)
  }
}
