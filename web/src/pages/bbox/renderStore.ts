import { useSyncExternalStore } from 'react'

/** A rendered image (the gallery meta of GET /api/comfy/job/{id} `images`, slimmed: no prompt). */
export interface RenderImage {
  id: string
  filename: string
  seed: number
}

/** How the last render ended, shown until the next one starts. */
export interface RenderOutcome {
  state: 'done' | 'error' | 'cancelled'
  /** The job's error (first line, then a traceback) for `error`. */
  error: string
}

/**
 * This tab's Ideogram 4 renders: the running job, the images rendered so far
 * (newest first, one per gallery id) and how the last job ended. Kept in
 * sessionStorage, so leaving the view or a reload resumes polling.
 */
export interface RenderRun {
  jobId: string | null
  results: RenderImage[]
  outcome: RenderOutcome | null
}

const KEY = 'flux.bbox.render'
const EMPTY: RenderRun = { jobId: null, results: [], outcome: null }
const ENDS = ['done', 'error', 'cancelled']

function slim(images: unknown[]): RenderImage[] {
  return images.flatMap((i) => {
    const m = i as Partial<RenderImage> | null
    return m && typeof m.id === 'string' && m.id
      ? [{ id: m.id, filename: typeof m.filename === 'string' ? m.filename : '', seed: typeof m.seed === 'number' ? m.seed : 0 }]
      : []
  })
}

function load(): RenderRun {
  try {
    const r = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Partial<RenderRun> | null
    if (!r || typeof r !== 'object') return EMPTY
    const o = r.outcome
    return {
      jobId: typeof r.jobId === 'string' ? r.jobId : null,
      results: merge([], Array.isArray(r.results) ? slim(r.results) : []),
      outcome: o && ENDS.includes(o.state) ? { state: o.state, error: typeof o.error === 'string' ? o.error : '' } : null,
    }
  } catch {
    return EMPTY
  }
}

/** `fresh` (in its order) before `results`, without an id that is already there. */
function merge(results: RenderImage[], fresh: RenderImage[]) {
  const seen = new Set(results.map((r) => r.id))
  const added = fresh.filter((r) => !seen.has(r.id) && seen.add(r.id))
  return added.length ? [...added, ...results] : results
}

let run: RenderRun = load()
const listeners = new Set<() => void>()

function update(next: RenderRun) {
  run = next
  listeners.forEach((l) => l())
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage blocked: the renders live until the tab closes.
  }
}

export const getRenderRun = () => run

/** A new job; the last outcome is cleared. */
export function startRender(jobId: string) {
  update({ ...run, jobId, outcome: null })
}

/**
 * The job ended: its images join the results and the job is forgotten. Only
 * once per job (a second poll that also saw the end changes nothing).
 */
export function finishRender(jobId: string, state: RenderOutcome['state'], images: unknown[], error = '') {
  if (run.jobId !== jobId) return
  update({ jobId: null, results: merge(run.results, slim(images)), outcome: { state, error } })
}

/** Forgets the job (it is gone). */
export function dropRender(jobId: string) {
  if (run.jobId === jobId) update({ ...run, jobId: null })
}

/** Empties the grid (the images stay in the ComfyUI gallery). */
export function clearResults() {
  update({ ...run, results: [] })
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useRenderRun() {
  return useSyncExternalStore(subscribe, getRenderRun)
}
