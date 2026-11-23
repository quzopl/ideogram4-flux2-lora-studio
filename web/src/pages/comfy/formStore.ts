import { useSyncExternalStore } from 'react'

/** The LoRA test form. */
export interface LoraForm {
  prompt: string
}

/** The reference batch form (Task 36 adds its fields). */
export type BatchForm = Record<string, never>

/**
 * This tab's ComfyUI page form. `url` is the server URL typed but not saved
 * yet (absent: the field shows the saved one). Kept in sessionStorage (the
 * only owner of `flux.comfy.form`), so leaving the view or a reload keeps it.
 */
export interface ComfyForm {
  url?: string
  lora: LoraForm
  batch: BatchForm
}

const KEY = 'flux.comfy.form'
const DEBOUNCE_MS = 300
const DEFAULTS: ComfyForm = { lora: { prompt: '' }, batch: {} }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** Stored values of the right type over the defaults (a missing or broken field keeps its default). */
function load(): ComfyForm {
  try {
    const r = obj(JSON.parse(sessionStorage.getItem(KEY) ?? 'null'))
    const lora = obj(r.lora)
    return {
      ...(typeof r.url === 'string' ? { url: r.url } : {}),
      lora: { ...DEFAULTS.lora, ...(typeof lora.prompt === 'string' ? { prompt: lora.prompt } : {}) },
      batch: { ...DEFAULTS.batch },
    }
  } catch {
    return DEFAULTS
  }
}

// The live state is here; sessionStorage is its copy for a reload.
let form: ComfyForm = load()
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function write() {
  clearTimeout(timer)
  timer = undefined
  try {
    sessionStorage.setItem(KEY, JSON.stringify(form))
  } catch {
    // Storage blocked: the form lives until the tab closes.
  }
}

/** Every change (typing makes many) is saved 300 ms after the last one. */
function update(next: ComfyForm) {
  form = next
  listeners.forEach((l) => l())
  clearTimeout(timer)
  timer = setTimeout(write, DEBOUNCE_MS)
}

/** Writes a pending change now. */
export function flushComfyForm() {
  if (timer !== undefined) write()
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushComfyForm)

export const getComfyForm = () => form

/** The typed server URL; `undefined` drops it (the field follows the saved one again). */
export function setUrlDraft(url: string | undefined) {
  if (url === form.url) return
  const next = { ...form, url }
  if (url === undefined) delete next.url
  update(next)
}

export function setLoraForm(patch: Partial<LoraForm>) {
  update({ ...form, lora: { ...form.lora, ...patch } })
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useComfyForm() {
  return useSyncExternalStore(subscribe, getComfyForm)
}
