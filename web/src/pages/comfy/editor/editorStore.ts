import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { isDictValue, type Workflow } from './schema'

/**
 * The workflow editor's draft: the workflow as edited, its library name, and
 * whether it changed since it was loaded. `invalid` holds every field whose
 * text was not taken (`"<node id>.<field>"`, or `"<id>.<field>.<key>"` inside
 * a dict) with its error: while it is not empty, Generate is off.
 */
export interface EditorState {
  workflow: Workflow | null
  name: string
  dirty: boolean
  invalid: Record<string, string>
  /** Bumped by every load (not stored): the node cards remount for the new workflow. */
  loads: number
}

const KEY = 'flux.comfy.editor'
const DEBOUNCE_MS = 300
const EMPTY: EditorState = { workflow: null, name: '', dirty: false, invalid: {}, loads: 0 }

const isWorkflow = (v: unknown): v is Workflow => isDictValue(v) && Object.values(v).every(isDictValue)

/** What is stored, field by field (a missing or broken part is empty); null when this tab has no draft. */
function load(): EditorState | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw === null) return null
    const r = JSON.parse(raw)
    if (!isDictValue(r)) return null
    return {
      workflow: isWorkflow(r.workflow) ? r.workflow : null,
      name: typeof r.name === 'string' ? r.name : '',
      dirty: r.dirty === true,
      // Not restored: the rejected texts are gone, and every mounted control reports its own validity.
      invalid: {},
      loads: 0,
    }
  } catch {
    return null
  }
}

const isQuota = (e: unknown) =>
  e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')

// The live state is here; sessionStorage is its copy for a reload.
let state: EditorState = load() ?? EMPTY
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function write() {
  clearTimeout(timer)
  timer = undefined
  try {
    const { loads: _, ...rest } = state
    sessionStorage.setItem(KEY, JSON.stringify(rest))
  } catch (e) {
    // Too big (or storage blocked): the draft lives until the tab closes or reloads.
    if (isQuota(e)) toast.error('Could not keep the edited workflow in this tab.', { id: 'comfy-editor-quota' })
  }
}

/** Every change (typing makes many) is saved 300 ms after the last one. */
function update(next: EditorState) {
  state = next
  listeners.forEach((l) => l())
  clearTimeout(timer)
  timer = setTimeout(write, DEBOUNCE_MS)
}

/** Writes a pending change now. */
export function flushEditor() {
  if (timer !== undefined) write()
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushEditor)

export const getEditor = () => state

/** A new workflow in the editor (a file, the server's, Task 38's library): unchanged, nothing invalid. */
export function loadWorkflow(workflow: Workflow, name?: string) {
  update({ workflow, name: name ?? state.name, dirty: false, invalid: {}, loads: state.loads + 1 })
}

/** The library name typed for the workflow (Save to library, Import and the .json file name use it). */
export function setName(name: string) {
  if (name !== state.name) update({ ...state, name })
}

/**
 * `workflow` was saved to the library as `name`: unchanged since, unless it
 * was edited while the save was on its way.
 */
export function markSaved(name: string, workflow: Workflow) {
  update({ ...state, name, dirty: state.workflow === workflow ? false : state.dirty })
}

/** `normalize`: the app rewrote the value into the form ComfyUI expects (not the user's edit, so not dirty). */
export interface WriteOptions {
  normalize?: boolean
}

/** Sets node `id`'s input `field` (a copy: the old workflow object is never changed). */
export function setInput(id: string, field: string, value: unknown, { normalize = false }: WriteOptions = {}) {
  const wf = state.workflow
  const node = wf?.[id]
  if (!wf || !node) return
  const inputs = node.inputs ?? {}
  if (Object.is(inputs[field], value)) return
  update({
    ...state,
    dirty: normalize ? state.dirty : true,
    workflow: { ...wf, [id]: { ...node, inputs: { ...inputs, [field]: value } } },
  })
}

/** Sets `key` inside node `id`'s dict input `field` (e.g. a Power Lora Loader's `lora_1.strength`). */
export function setSubInput(id: string, field: string, key: string, value: unknown, opts?: WriteOptions) {
  const old = state.workflow?.[id]?.inputs?.[field]
  const dict = isDictValue(old) ? old : {}
  if (Object.is(dict[key], value) && isDictValue(old)) return
  setInput(id, field, { ...dict, [key]: value }, opts)
}

/** Marks field `key` invalid with `msg`, or valid again with null or ''. */
export function setInvalid(key: string, msg: string | null) {
  const cur = state.invalid[key]
  if (msg) {
    if (cur === msg) return
    update({ ...state, invalid: { ...state.invalid, [key]: msg } })
  } else if (cur !== undefined) {
    const { [key]: _, ...rest } = state.invalid
    update({ ...state, invalid: rest })
  }
}

let serverLoad: Promise<number | null> | null = null

/**
 * The editor's first entry in a tab without a draft: the server's last editor
 * workflow (once per page). Resolves with its node count when it was taken; a
 * draft (also one loaded meanwhile) is never replaced.
 */
export function loadServerWorkflow(): Promise<number | null> {
  if (state.workflow) return Promise.resolve(null)
  serverLoad ??= api<{ workflow: Workflow | null; node_count: number }>('/api/comfy/editor/workflow').then(
    (r) => {
      if (state.workflow || !isWorkflow(r.workflow) || Object.keys(r.workflow).length === 0) return null
      loadWorkflow(r.workflow)
      return r.node_count
    },
    () => null,
  )
  return serverLoad
}

/**
 * "Reload from disk": the server's last editor workflow, asked now (edits are
 * replaced). Resolves with its node count; null, the draft kept, when the
 * server has none.
 */
export async function reloadServerWorkflow(): Promise<number | null> {
  const r = await api<{ workflow: Workflow | null; node_count: number }>('/api/comfy/editor/workflow')
  if (!isWorkflow(r.workflow) || Object.keys(r.workflow).length === 0) return null
  loadWorkflow(r.workflow)
  return Object.keys(r.workflow).length
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useEditor() {
  return useSyncExternalStore(subscribe, getEditor)
}
