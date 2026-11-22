import { useSyncExternalStore } from 'react'
import type { V15Finding } from '@/components/V15Findings'

/** A finished analysis (GET /api/ideogram/analyze/jobs/{id} `result`); `json` is a normalised v15 prompt. */
export interface AnalyzeResult {
  json: string
  elements: number
  model: string
  warnings: V15Finding[]
}

/**
 * This tab's "From image": the running job, the last result (and whether it
 * was offered for the canvas, so it is put there at most once) and the last
 * error. Kept in sessionStorage, so leaving the view or a reload resumes it.
 * `photo` (the picked file, for its thumbnail) is in memory only.
 */
export interface AnalyzeRun {
  jobId: string | null
  result: AnalyzeResult | null
  applied: boolean
  error: string
  photo: File | null
}

const KEY = 'flux.bbox.analyze'
const EMPTY: AnalyzeRun = { jobId: null, result: null, applied: false, error: '', photo: null }

function load(): AnalyzeRun {
  try {
    const r = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Partial<AnalyzeRun> | null
    if (!r || typeof r !== 'object') return EMPTY
    const res = r.result
    const result = res && typeof res.json === 'string'
      ? {
          json: res.json,
          elements: typeof res.elements === 'number' ? res.elements : 0,
          model: typeof res.model === 'string' ? res.model : '',
          warnings: Array.isArray(res.warnings) ? res.warnings : [],
        }
      : null
    return {
      jobId: typeof r.jobId === 'string' ? r.jobId : null,
      result,
      // A result of unknown state is not put on the canvas again.
      applied: result ? r.applied !== false : false,
      error: typeof r.error === 'string' ? r.error : '',
      photo: null,
    }
  } catch {
    return EMPTY
  }
}

let run: AnalyzeRun = load()
const listeners = new Set<() => void>()

function update(next: AnalyzeRun) {
  run = next
  listeners.forEach((l) => l())
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...next, photo: undefined }))
  } catch {
    // Storage blocked: the run lives until the tab closes.
  }
}

export const getAnalyzeRun = () => run

/** A new job; the previous result stays (as Load draft) until this one finishes. */
export function startAnalyze(jobId: string, photo: File) {
  update({ ...run, jobId, error: '', photo })
}

/** The job is done: its result is kept here (not yet on the canvas), so the job is no longer needed. */
export function finishAnalyze(jobId: string, result: AnalyzeResult) {
  if (run.jobId !== jobId) return
  update({ jobId: null, result, applied: false, error: '', photo: null })
}

/** The job failed: its error is kept here. */
export function failAnalyze(jobId: string, error: string) {
  if (run.jobId === jobId) update({ ...run, jobId: null, error })
}

/** Hides the last error (and its photo). */
export function dismissAnalyzeError() {
  if (run.error) update({ ...run, error: '', photo: run.jobId ? run.photo : null })
}

/** Forgets the job (it is gone). */
export function dropAnalyze(jobId: string) {
  if (run.jobId === jobId) update({ ...run, jobId: null, photo: null })
}

/** Marks the result offered for the canvas; false if it already was (or there is none). */
export function markAnalyzeApplied() {
  if (!run.result || run.applied) return false
  update({ ...run, applied: true })
  return true
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useAnalyzeRun() {
  return useSyncExternalStore(subscribe, getAnalyzeRun)
}
