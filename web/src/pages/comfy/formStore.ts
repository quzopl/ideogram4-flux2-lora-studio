import { useSyncExternalStore } from 'react'

/** The LoRA test form (classic defaults). */
export interface LoraForm {
  prompt: string
  width: number
  height: number
  steps: number
  cfg: number
  /** -1 = random. */
  seed: number
  /** Sample count. */
  batch: number
  /**
   * The LoRA rows as typed, row i for the workflow's LoRA slot i ('' leaves
   * the slot as it is). null until a row is touched: one empty row per slot.
   */
  loras: string[] | null
}

/** A number field of a form: its key, label and bounds. */
export interface NumberSpec<K> { k: K; label: string; min: number; max: number; step?: number; decimal?: boolean }

/** Size, steps and CFG (classic labels; the bounds are the port's): the LoRA test and the reference batch have these. */
export const SIZE_FIELDS: NumberSpec<'width' | 'height' | 'steps' | 'cfg'>[] = [
  { k: 'width', label: 'Width', min: 64, max: 8192, step: 64 },
  { k: 'height', label: 'Height', min: 64, max: 8192, step: 64 },
  { k: 'steps', label: 'Steps', min: 1, max: 1000 },
  { k: 'cfg', label: 'CFG / Guidance', min: 0, max: 100, step: 0.1, decimal: true },
]

/** The reference batch form (classic defaults). */
export interface BatchForm {
  /** One prompt per line. */
  prompts: string
  width: number
  height: number
  steps: number
  cfg: number
}

/**
 * This tab's ComfyUI page form. `url` is the server URL typed but not saved
 * yet (absent: the field shows the saved one); `mapping` likewise is the
 * mapping JSON as edited but not activated. Kept in sessionStorage (the only
 * owner of `flux.comfy.form`), so a tab switch, leaving the view or a reload
 * keeps it.
 */
export interface ComfyForm {
  url?: string
  mapping?: string
  lora: LoraForm
  batch: BatchForm
}

const KEY = 'flux.comfy.form'
const DEBOUNCE_MS = 300
const LORA_DEFAULTS: LoraForm = { prompt: '', width: 1024, height: 1024, steps: 20, cfg: 3.5, seed: -1, batch: 2, loras: null }
const BATCH_DEFAULTS: BatchForm = { prompts: '', width: 1024, height: 1024, steps: 20, cfg: 3.5 }
const DEFAULTS: ComfyForm = { lora: LORA_DEFAULTS, batch: BATCH_DEFAULTS }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** The stored LoRA form field by field over the defaults (a missing or broken field keeps its default). */
function loadLora(v: unknown): LoraForm {
  const l = obj(v)
  const out: LoraForm = { ...LORA_DEFAULTS }
  if (typeof l.prompt === 'string') out.prompt = l.prompt
  for (const k of ['width', 'height', 'steps', 'cfg', 'seed', 'batch'] as const) {
    const n = l[k]
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n
  }
  if (Array.isArray(l.loras) && l.loras.every((s) => typeof s === 'string')) out.loras = l.loras
  return out
}

/** The stored batch form field by field over the defaults. */
function loadBatch(v: unknown): BatchForm {
  const b = obj(v)
  const out: BatchForm = { ...BATCH_DEFAULTS }
  if (typeof b.prompts === 'string') out.prompts = b.prompts
  for (const k of ['width', 'height', 'steps', 'cfg'] as const) {
    const n = b[k]
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n
  }
  return out
}

/** Stored values of the right type over the defaults (a missing or broken field keeps its default). */
function load(): ComfyForm {
  try {
    const r = obj(JSON.parse(sessionStorage.getItem(KEY) ?? 'null'))
    return {
      ...(typeof r.url === 'string' ? { url: r.url } : {}),
      ...(typeof r.mapping === 'string' ? { mapping: r.mapping } : {}),
      lora: loadLora(r.lora),
      batch: loadBatch(r.batch),
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

/** Sets an optional draft; `undefined` drops it (the field follows the saved value again). */
function setDraft(key: 'url' | 'mapping', value: string | undefined) {
  if (value === form[key]) return
  const next = { ...form, [key]: value }
  if (value === undefined) delete next[key]
  update(next)
}

/** The typed server URL. */
export const setUrlDraft = (url: string | undefined) => setDraft('url', url)

/** The edited mapping JSON. */
export const setMappingDraft = (mapping: string | undefined) => setDraft('mapping', mapping)

export function setLoraForm(patch: Partial<LoraForm>) {
  update({ ...form, lora: { ...form.lora, ...patch } })
}

export function setBatchForm(patch: Partial<BatchForm>) {
  update({ ...form, batch: { ...form.batch, ...patch } })
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
