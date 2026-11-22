import { useSyncExternalStore } from 'react'
import { emptyDoc, newKey, parseRatio, type Doc, type El } from '@/editors/bbox/model'

/**
 * This tab's Bbox canvas: the document and the selected element (its index in
 * `doc.elements`, or null). Kept in sessionStorage, so leaving the view or a
 * reload keeps the work.
 */
export interface Draft {
  doc: Doc
  selected: number | null
}

const KEY = 'flux.bbox.draft'
const DEBOUNCE_MS = 300

const str = (v: unknown) => (typeof v === 'string' ? v : '')

function fresh(): Draft {
  return { doc: emptyDoc(), selected: 0 }
}

/** Element keys are minted anew: they are only unique within one page load. */
function loadEl(e: Partial<El>): El {
  const b = e.bbox
  return {
    key: newKey(),
    type: e.type === 'text' ? 'text' : 'obj',
    bbox: Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v))
      ? [b[0], b[1], b[2], b[3]]
      : null,
    desc: str(e.desc),
    text: str(e.text),
  }
}

function load(): Draft {
  try {
    const r = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { doc?: Partial<Doc>; selected?: unknown } | null
    const d = r?.doc
    if (!d || typeof d !== 'object' || !Array.isArray(d.elements)) return fresh()
    const doc: Doc = {
      aspect_ratio: typeof d.aspect_ratio === 'string' && parseRatio(d.aspect_ratio) ? d.aspect_ratio : '1:1',
      hld: str(d.hld),
      bg: str(d.bg),
      elements: d.elements.filter((e) => e && typeof e === 'object').map(loadEl),
    }
    const s = r.selected
    const selected = typeof s === 'number' && Number.isInteger(s) && s >= 0 && s < doc.elements.length ? s : null
    return { doc, selected }
  } catch {
    return fresh()
  }
}

// The live state is here; sessionStorage is its copy for a reload.
let draft: Draft = load()
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function write() {
  clearTimeout(timer)
  timer = undefined
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft))
  } catch {
    // Storage blocked: the draft lives until the tab closes.
  }
}

/** Every change (a drag makes many) is saved 300 ms after the last one. */
function update(next: Draft) {
  draft = next
  listeners.forEach((l) => l())
  clearTimeout(timer)
  timer = setTimeout(write, DEBOUNCE_MS)
}

/** Writes a pending change now. */
export function flushDraft() {
  if (timer !== undefined) write()
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushDraft)

export const getDraft = () => draft

/**
 * A new document. The selection follows its element (by key) when the array
 * is reordered, and is dropped when the element is gone.
 */
export function setDoc(next: Doc | ((d: Doc) => Doc)) {
  const doc = typeof next === 'function' ? next(draft.doc) : next
  const key = draft.selected === null ? null : draft.doc.elements[draft.selected]?.key
  const i = key ? doc.elements.findIndex((e) => e.key === key) : -1
  update({ doc, selected: i >= 0 ? i : null })
}

export function setSelected(selected: number | null) {
  const s = selected !== null && selected >= 0 && selected < draft.doc.elements.length ? selected : null
  if (s !== draft.selected) update({ ...draft, selected: s })
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** [doc, setDoc, selected, setSelected] of this tab's draft. */
export function useBboxDoc() {
  const d = useSyncExternalStore(subscribe, getDraft)
  return [d.doc, setDoc, d.selected, setSelected] as const
}
