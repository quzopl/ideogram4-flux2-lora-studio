import { api, ApiError } from '@/lib/api'
import type { JobProgressInfo } from './format'
import { pollJobCore, type PollOptions } from './pollJobCore'
import type { GalleryItem } from './queries'

export { isJobEnd, JOB_ENDS } from './pollJobCore'

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
  progress: JobProgressInfo
  has_preview: boolean
  /** Changes with each preview frame. */
  preview_ts: number
  images: GalleryItem[]
  /** First line for the UI, then a traceback; on `done` a warning (e.g. an image that could not be fetched). */
  error: string
}

/** Polls GET /api/comfy/job/{id} until it ends (pollJobCore); a 404 is "gone". */
export const pollJob = (jobId: string, opts: PollOptions<ComfyJob> = {}): Promise<ComfyJob | 'gone'> =>
  pollJobCore(
    (id, signal) => api<ComfyJob>(`/api/comfy/job/${encodeURIComponent(id)}`, { signal }),
    (e) => e instanceof ApiError && e.status === 404,
    jobId,
    opts,
  )
