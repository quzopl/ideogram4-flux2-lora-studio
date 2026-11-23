import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useJobPoll } from '@/hooks/useJobPoll'
import { JOB_ENDS, type ComfyJob } from './pollJob'

/** A gallery image as a job keeps it: without `prompt` (sessionStorage is small). */
export interface SlimImage {
  id: string
  url: string
  seed: number
  width?: number
  height?: number
}

/** How a job ended, shown until the slot's next job starts. */
export interface JobOutcome {
  state: 'done' | 'error' | 'cancelled'
  images: SlimImage[]
  /** The job's error (first line, then a traceback); on `done` a warning. */
  error: string
}

/** One job at a time: the running one, else how the last one ended. */
export interface JobSlot {
  jobId: string | null
  last?: JobOutcome
}

/** The slots run by one job each (the LoRA test, the workflow editor). */
export type SlotName = 'lora' | 'editor'

/** One line of the reference batch and how it went (Task 36 runs it). */
export interface BatchLine {
  line: string
  state: string
  images: SlimImage[]
  error: string
}

/** The reference batch: one job per prompt line, one line after another. */
export interface BatchState {
  lines: string[]
  /** The line being sent or run. */
  index: number
  jobId: string | null
  /** Set while the line's POST is in flight (a reload then does not send it again). */
  posting: boolean
  results: BatchLine[]
  cancelled: boolean
  running: boolean
}

/** This tab's ComfyUI jobs; sessionStorage `flux.comfy.jobs`, so leaving the view or a reload resumes them. */
export interface ComfyJobs {
  lora: JobSlot
  editor: JobSlot
  batch: BatchState
}

const KEY = 'flux.comfy.jobs'
const ENDED = JOB_ENDS as readonly JobOutcome['state'][]
const EMPTY_BATCH: BatchState = {
  lines: [], index: 0, jobId: null, posting: false, results: [], cancelled: false, running: false,
}
const EMPTY: ComfyJobs = { lora: { jobId: null }, editor: { jobId: null }, batch: EMPTY_BATCH }

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** The meta the job box and the batch list need (from a job's `images`, or as stored). */
export function slimImages(images: unknown): SlimImage[] {
  if (!Array.isArray(images)) return []
  return images.flatMap((i) => {
    const m = obj(i)
    const id = str(m.id)
    if (!id) return []
    const width = num(m.width), height = num(m.height)
    return [{
      id,
      url: str(m.url) || `/api/comfy/gallery/${encodeURIComponent(id)}`,
      seed: num(m.seed) ?? 0,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    }]
  })
}

function loadSlot(v: unknown): JobSlot {
  const s = obj(v)
  const last = obj(s.last)
  const state = last.state as JobOutcome['state']
  return {
    jobId: str(s.jobId) || null,
    ...(ENDED.includes(state) ? { last: { state, images: slimImages(last.images), error: str(last.error) } } : {}),
  }
}

function loadBatch(v: unknown): BatchState {
  const b = obj(v)
  const results = Array.isArray(b.results)
    ? b.results.map((r) => {
      const l = obj(r)
      return { line: str(l.line), state: str(l.state), images: slimImages(l.images), error: str(l.error) }
    })
    : []
  return {
    lines: Array.isArray(b.lines) ? b.lines.filter((l): l is string => typeof l === 'string') : [],
    index: num(b.index) ?? 0,
    jobId: str(b.jobId) || null,
    posting: b.posting === true,
    results,
    cancelled: b.cancelled === true,
    running: b.running === true,
  }
}

/** What is stored, field by field (a missing or broken part is empty). */
function load(): ComfyJobs {
  try {
    const r = obj(JSON.parse(sessionStorage.getItem(KEY) ?? 'null'))
    return { lora: loadSlot(r.lora), editor: loadSlot(r.editor), batch: loadBatch(r.batch) }
  } catch {
    return EMPTY
  }
}

const isQuota = (e: unknown) =>
  e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')

// The live state is here; sessionStorage is its copy for a reload.
let jobs: ComfyJobs = load()
const listeners = new Set<() => void>()

function update(next: ComfyJobs) {
  jobs = next
  listeners.forEach((l) => l())
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next))
  } catch (e) {
    // Too big (or storage blocked): the jobs live until the tab closes or reloads.
    if (isQuota(e)) toast.error('Could not keep the job state in this tab.', { id: 'comfy-jobs-quota' })
  }
}

export const getComfyJobs = () => jobs

/** A new job in the slot; the last outcome is cleared. */
export function startJob(slot: SlotName, jobId: string) {
  update({ ...jobs, [slot]: { jobId } })
}

/**
 * The slot's job ended: its outcome becomes `last` and the job is forgotten.
 * Only for the slot's current job (a late answer about an older one, or a
 * second poll that also saw the end, changes nothing); true when it applied.
 */
export function finishJob(slot: SlotName, jobId: string, job: Pick<ComfyJob, 'state' | 'images' | 'error'>) {
  if (jobs[slot].jobId !== jobId || !ENDED.includes(job.state as JobOutcome['state'])) return false
  const last: JobOutcome = { state: job.state as JobOutcome['state'], images: slimImages(job.images), error: job.error ?? '' }
  update({ ...jobs, [slot]: { jobId: null, last } })
  return true
}

/** Forgets the slot's job without an outcome (it is gone: the server no longer knows it). */
export function dropJob(slot: SlotName, jobId: string) {
  if (jobs[slot].jobId === jobId) update({ ...jobs, [slot]: { ...jobs[slot], jobId: null } })
}

/** Replaces part of the batch state. */
export function setBatch(patch: Partial<BatchState>) {
  update({ ...jobs, batch: { ...jobs.batch, ...patch } })
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useComfyJobs() {
  return useSyncExternalStore(subscribe, getComfyJobs)
}

/** The slot's job as polled; one query per job, shared by JobObservers and ComfyJobBox. */
export function useSlotJob(jobId: string | null) {
  return useJobPoll<ComfyJob>(['comfy-job', jobId], jobId ? `/api/comfy/job/${encodeURIComponent(jobId)}` : null, {
    intervalMs: 700,
    terminal: [...JOB_ENDS],
  })
}
