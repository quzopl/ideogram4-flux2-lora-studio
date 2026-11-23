import { api, ApiError } from '@/lib/api'
import type { JobProgressInfo } from './format'
import type { GalleryItem } from './queries'

export type JobState = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

/** GET /api/comfy/job/{id} (the LoRA test, the batch lines and the editor run as these). */
export interface ComfyJob {
  id: string
  state: JobState
  total: number
  done_count: number
  /** What it does now, e.g. "Sample 1/2: step 3/20". */
  current: string
  /** The id of the node ComfyUI executes. */
  current_node: string
  progress: Required<JobProgressInfo>
  has_preview: boolean
  /** Changes with each preview frame. */
  preview_ts: number
  images: GalleryItem[]
  /** First line for the UI, then a traceback; on `done` a warning (e.g. an image that could not be fetched). */
  error: string
}

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

/**
 * Polls a job until it ends, outside React (the batch runs this way), with
 * useJobPoll's rules: a failed poll is waited out, the job ending (`done`,
 * `error`, `cancelled`) resolves with it, a 404 resolves with "gone" (e.g. the
 * server was restarted). `onUpdate` gets every answer. Aborting `signal`
 * rejects with its reason.
 */
export async function pollJob(
  jobId: string,
  opts: { signal?: AbortSignal; intervalMs?: number; onUpdate?: (job: ComfyJob) => void } = {},
): Promise<ComfyJob | 'gone'> {
  const { signal, intervalMs = 700, onUpdate } = opts
  for (;;) {
    signal?.throwIfAborted()
    try {
      const job = await api<ComfyJob>(`/api/comfy/job/${encodeURIComponent(jobId)}`, { signal })
      onUpdate?.(job)
      if (isJobEnd(job.state)) return job
    } catch (e) {
      signal?.throwIfAborted()
      if (e instanceof ApiError && e.status === 404) return 'gone'
      // Anything else (the server busy or briefly away): try again.
    }
    await sleep(intervalMs, signal)
  }
}
