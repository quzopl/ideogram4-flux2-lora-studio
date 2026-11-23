import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { claimBatchLine, getComfyJobs, setBatch, setBatchLine, slimImages, type BatchParams } from './comfyJobStore'
import { isJobEnd, pollJob } from './pollJob'
import { errorText, GALLERY_KEY } from './queries'

/*
 * The reference batch runs here, outside React (Ruling AG: the one exception
 * to useJobPoll and useIsMutating), so it goes on while the view is left. Its
 * state lives in comfyJobStore.batch (sessionStorage), so a reload resumes it.
 */

/** A line whose POST was in flight when the page was reloaded: it may have reached the server. */
export const UNKNOWN = 'unknown (page reloaded while queueing)'
const GONE = 'The ComfyUI job is gone (was the server restarted?)'

/** Whether this page's one loop runs (single-flight). */
let looping = false

const batch = () => getComfyJobs().batch

/** Starts a batch of these lines with these parameters (nothing while one runs). */
export function startBatch(qc: QueryClient, lines: string[], params: BatchParams) {
  if (batch().running || lines.length === 0) return
  setBatch({
    lines, params, index: 0, jobId: null, posting: false, cancelled: false, cancelFailed: false, running: true,
    results: lines.map((line) => ({ line, state: 'queued', images: [], error: '' })),
  })
  ensureRunning(qc)
}

/** Runs the stored batch unless this page already does (on mount, after a reload, on start). */
export function ensureRunning(qc: QueryClient) {
  if (looping || !batch().running) return
  looping = true
  void run(qc)
}

/**
 * Cancels the running line's job; the loop waits for it to end, then skips the
 * rest. Pressed again after a failed cancel request, it sends the request again.
 */
export async function cancelBatch() {
  const b = batch()
  if (!b.running || (b.cancelled && !b.cancelFailed)) return
  setBatch({ cancelled: true, cancelFailed: false })
  // No job yet (its POST in flight): the loop cancels it once it has the id.
  if (b.jobId) await sendCancel(b.jobId)
}

async function sendCancel(jobId: string) {
  try {
    await api(`/api/comfy/job/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
  } catch (e) {
    toast.error(`Could not cancel the batch job: ${errorText(e)}`)
    // Still this batch's job: Cancel is offered again (the rest stays skipped once the job ends).
    if (batch().running && batch().jobId === jobId) setBatch({ cancelFailed: true })
  }
}

async function run(qc: QueryClient) {
  try {
    // Only a fresh page (a reload) finds a POST in flight without a job: it is not sent again.
    const b = batch()
    if (b.posting && !b.jobId) {
      setBatchLine(b.index, { state: UNKNOWN })
      setBatch({ index: b.index + 1, posting: false })
    }
    await runLines(qc)
  } catch (e) {
    toast.error(`The batch stopped: ${errorText(e)}`)
    // The line it was on failed with it (else the summary would read as done).
    const { index, results } = batch()
    if (index < results.length && !['done', 'error', 'cancelled', 'gone'].includes(results[index].state)) {
      setBatchLine(index, { state: 'error', error: errorText(e) })
    }
  } finally {
    // However it ended: the lines not run are skipped and the batch is over. The loop is
    // forgotten first, so a batch started as soon as this one shows as ended gets its own.
    looping = false
    const results = batch().results.map((r) => (r.state === 'queued' ? { ...r, state: 'skipped' } : r))
    setBatch({ running: false, posting: false, jobId: null, cancelFailed: false, results })
  }
}

/** One line after another until all are run, one fails or is gone, or the batch is cancelled. */
async function runLines(qc: QueryClient) {
  for (;;) {
    const b = batch()
    const i = b.index
    if (i >= b.lines.length || (b.cancelled && !b.jobId)) return
    let jobId = b.jobId
    if (!jobId) {
      // Compare-and-set: the POST goes out only if this loop claimed the line.
      if (!claimBatchLine(i)) return
      try {
        const r = await api<{ job_id: string }>('/api/comfy/generate', {
          method: 'POST',
          json: { prompt: b.lines[i], ...b.params, batch: 1 },
        })
        jobId = r.job_id
      } catch (e) {
        setBatchLine(i, { state: 'error', error: errorText(e) })
        return
      }
      setBatch({ jobId, posting: false })
      setBatchLine(i, { state: 'pending' })
    }
    // Cancelled while the POST was in flight, or before a reload: cancel it now (again is harmless).
    if (batch().cancelled) void sendCancel(jobId)

    const job = await pollJob(jobId, {
      onUpdate: (j) => {
        if (!isJobEnd(j.state) && batch().results[i]?.state !== j.state) setBatchLine(i, { state: j.state })
      },
    })
    void qc.invalidateQueries({ queryKey: GALLERY_KEY })
    if (job === 'gone') {
      setBatchLine(i, { state: 'gone', error: GONE })
      return
    }
    setBatchLine(i, { state: job.state, images: slimImages(job.images), error: job.error ?? '' })
    setBatch({ index: i + 1, jobId: null })
    // A failed line stops the batch (classic).
    if (job.state === 'error') return
  }
}
