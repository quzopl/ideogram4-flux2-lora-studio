import { useQuery } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import type { DatasetJob } from '@/lib/types'

/**
 * This tab's Dataset run: the job, the folder it read, and the review made on
 * its results (caption edits and removed images, keyed by result `idx`).
 */
export interface Run {
  jobId: string
  folder: string
  edits: Record<number, string>
  deleted: number[]
}

const KEY = 'flux.dataset.run'
const DEBOUNCE_MS = 300

function load(): Run | null {
  try {
    const r = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Run | null
    if (!r || typeof r.jobId !== 'string' || typeof r.folder !== 'string') return null
    return {
      jobId: r.jobId,
      folder: r.folder,
      edits: r.edits && typeof r.edits === 'object' ? r.edits : {},
      deleted: Array.isArray(r.deleted) ? r.deleted : [],
    }
  } catch {
    return null
  }
}

// The live state is here; sessionStorage is its copy for a reload.
let run: Run | null = load()
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function write() {
  clearTimeout(timer)
  timer = undefined
  try {
    if (run) sessionStorage.setItem(KEY, JSON.stringify(run))
    else sessionStorage.removeItem(KEY)
  } catch {
    // Storage blocked: the run lives until the tab closes.
  }
}

function update(next: Run | null, debounce = false) {
  run = next
  listeners.forEach((l) => l())
  if (!debounce) write()
  else {
    clearTimeout(timer)
    timer = setTimeout(write, DEBOUNCE_MS)
  }
}

/** Writes a pending edit now. */
export function flushRun() {
  if (timer !== undefined) write()
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushRun)

export const getRun = () => run

/** A new job: its review starts empty. */
export function startRun(jobId: string, folder: string) {
  update({ jobId, folder, edits: {}, deleted: [] })
}

/** Forgets the run (its job is gone). */
export function clearRun() {
  update(null)
}

/** Saved 300 ms after the last keystroke; the live state has it at once. */
export function setEdit(idx: number, text: string) {
  if (run) update({ ...run, edits: { ...run.edits, [idx]: text } }, true)
}

export function toggleDeleted(idx: number) {
  if (!run) return
  const deleted = run.deleted.includes(idx) ? run.deleted.filter((i) => i !== idx) : [...run.deleted, idx]
  update({ ...run, deleted })
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useRun() {
  return useSyncExternalStore(subscribe, getRun)
}

const TERMINAL = ['done', 'error']
const isGone = (e: unknown) => e instanceof ApiError && e.status === 404

/**
 * Polls GET /api/job/{id} until the job is over. A transient error keeps
 * polling (the last data stays shown); a 404 (e.g. after a server restart)
 * stops it and forgets the run.
 */
export function useDatasetJob(jobId: string | null) {
  const job = useQuery({
    queryKey: ['dataset-job', jobId],
    queryFn: () => api<DatasetJob>(`/api/job/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: (q) => (isGone(q.state.error) || TERMINAL.includes(q.state.data?.state ?? '') ? false : 1000),
  })
  const gone = job.isError && isGone(job.error)
  useEffect(() => {
    if (!gone) return
    toast.error('The processing job is gone (was the server restarted?)')
    clearRun()
  }, [gone])
  return {
    data: job.data,
    /** Why the last poll failed, while there is nothing to show yet. */
    error: job.isError && !job.data ? (job.error instanceof ApiError ? job.error.detail : job.error.message) : '',
    running: jobId !== null && !gone && !TERMINAL.includes(job.data?.state ?? ''),
  }
}
