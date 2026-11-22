import { useSyncExternalStore } from 'react'
import type { V15Finding } from '@/components/V15Findings'

/** A finished generation (GET /api/prompt/jobs/{id} `result`). */
export interface PromptResult {
  prompt: string
  warnings: V15Finding[]
  /** The caption_format it was generated for: "flux", "ideogram" or "aitoolkit". */
  format: string
  library_id: number
}

/**
 * This tab's Prompt studio: the prompt being written, the running job (and
 * the format it was started with), the last result and the user's edit of it
 * (null while unedited). Kept in sessionStorage, not in the saved form.
 */
export interface PromptRun {
  text: string
  jobId: string | null
  format: string
  result: PromptResult | null
  edited: string | null
}

const KEY = 'flux.prompts.run'
const DEBOUNCE_MS = 300
const EMPTY: PromptRun = { text: '', jobId: null, format: 'flux', result: null, edited: null }

function load(): PromptRun {
  try {
    const r = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Partial<PromptRun> | null
    if (!r || typeof r !== 'object') return EMPTY
    const result = r.result && typeof r.result.prompt === 'string' ? r.result : null
    return {
      text: typeof r.text === 'string' ? r.text : '',
      jobId: typeof r.jobId === 'string' ? r.jobId : null,
      format: typeof r.format === 'string' ? r.format : 'flux',
      result: result && { ...result, warnings: Array.isArray(result.warnings) ? result.warnings : [] },
      edited: typeof r.edited === 'string' ? r.edited : null,
    }
  } catch {
    return EMPTY
  }
}

// The live state is here; sessionStorage is its copy for a reload.
let run: PromptRun = load()
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function write() {
  clearTimeout(timer)
  timer = undefined
  try {
    sessionStorage.setItem(KEY, JSON.stringify(run))
  } catch {
    // Storage blocked: the run lives until the tab closes.
  }
}

function update(next: PromptRun, debounce = false) {
  run = next
  listeners.forEach((l) => l())
  if (!debounce) write()
  else {
    clearTimeout(timer)
    timer = setTimeout(write, DEBOUNCE_MS)
  }
}

/** Writes a pending edit now. */
export function flushPromptRun() {
  if (timer !== undefined) write()
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushPromptRun)

export const getPromptRun = () => run

/** Saved 300 ms after the last keystroke; the live state has it at once. */
export function setPromptText(text: string) {
  update({ ...run, text }, true)
}

/** A new job: the previous result and its edit are dropped. */
export function startPromptJob(jobId: string, format: string) {
  update({ ...run, jobId, format, result: null, edited: null })
}

/** The job is done: its result is kept here, so the job is no longer needed. */
export function finishPromptJob(jobId: string, result: PromptResult) {
  if (run.jobId !== jobId) return
  update({ ...run, jobId: null, result: { ...result, format: result.format ?? run.format } })
}

/** Forgets the job (it is gone). */
export function dropPromptJob(jobId: string) {
  if (run.jobId === jobId) update({ ...run, jobId: null })
}

export function setPromptEdited(edited: string) {
  update({ ...run, edited }, true)
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function usePromptRun() {
  return useSyncExternalStore(subscribe, getPromptRun)
}
