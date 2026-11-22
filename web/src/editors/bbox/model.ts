// The Ideogram v15 prompt document edited on the Bbox canvas. Ported from
// frontend/bbox_editor.js (buildCaption, defBbox); the classic `z` field is
// gone: array order is the z-order, the last element is on top.

/** [y1, x1, y2, x2] on a 0–1000 grid per axis, origin top-left. */
export type Bbox = [number, number, number, number]
export type ElType = 'obj' | 'text'

export interface El {
  /** Stable client-side id (React key of boxes and cards); never in the JSON. */
  key: string
  type: ElType
  /** null = no box: the element has a card but nothing on the canvas. */
  bbox: Bbox | null
  desc: string
  /** Only output for type "text". */
  text: string
  /** The box the bbox checkbox turned off, restored when it is turned on again; never in the JSON. */
  lastBbox?: Bbox
}

export interface Doc {
  aspect_ratio: string
  hld: string
  bg: string
  elements: El[]
}

let seq = 0
/** Unique for the page's life (crypto.randomUUID is missing on plain-http LAN origins). */
export const newKey = () => `el${++seq}`

/** [w, h] of a `W:H` string with both parts above zero, else null. */
export function parseRatio(ar: string): [number, number] | null {
  const m = /^(\d+):(\d+)$/.exec(ar.trim())
  if (!m) return null
  const w = parseInt(m[1], 10)
  const h = parseInt(m[2], 10)
  return w > 0 && h > 0 ? [w, h] : null
}

/** The box a new element gets (classic defBbox); every new element lands on the same one. */
export function defBbox(type: ElType, ratio: string): Bbox {
  const [aw, ah] = parseRatio(ratio) ?? [1, 1]
  const r = aw / ah
  const wide = r >= 1.4
  if (type === 'text') return wide ? [120, 300, 300, 700] : [120, 250, 260, 750]
  return wide ? [80, 400, 1000, 620] : r <= 0.85 ? [40, 250, 1000, 750] : [60, 300, 1000, 700]
}

function newEl(type: ElType, ratio: string): El {
  return { key: newKey(), type, bbox: defBbox(type, ratio), desc: '', text: '' }
}

/** What the classic editor opens with: 1:1 and one empty obj on the default box. */
export function emptyDoc(): Doc {
  return { aspect_ratio: '1:1', hld: '', bg: '', elements: [newEl('obj', '1:1')] }
}

/** The v15 prompt, keys in the classic buildCaption order. */
export function toCaption(doc: Doc): object {
  return {
    aspect_ratio: doc.aspect_ratio,
    high_level_description: doc.hld,
    compositional_deconstruction: {
      background: doc.bg,
      elements: doc.elements.map((e) => ({
        type: e.type,
        ...(e.bbox ? { bbox: e.bbox } : {}),
        ...(e.type === 'text' ? { text: e.text } : {}),
        desc: e.desc,
      })),
    },
  }
}

/** Minified like the classic Copy (`JSON.stringify`, no spaces), or indented by 2. */
export function toJson(doc: Doc, pretty = false): string {
  return JSON.stringify(toCaption(doc), null, pretty ? 2 : undefined)
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** `v` as a bbox: four finite numbers, else null. Shared by every loader. */
export function bboxOf(v: unknown): Bbox | null {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return [v[0], v[1], v[2], v[3]]
}

/** Nothing to lose: the canvas a new tab opens with, or one emptied of everything. */
export function isDefaultDoc(doc: Doc): boolean {
  if (!doc.elements.length && !doc.hld.trim() && !doc.bg.trim()) return true
  return toJson(doc) === toJson(emptyDoc())
}

/**
 * A document from a v15 prompt the server already normalised
 * (/api/ideogram/normalize). Tolerant anyway: what is missing comes out empty.
 */
export function fromCaption(obj: unknown): Doc {
  const o = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>
  const cd = (o.compositional_deconstruction && typeof o.compositional_deconstruction === 'object'
    ? o.compositional_deconstruction
    : {}) as Record<string, unknown>
  const els = Array.isArray(cd.elements) ? cd.elements : []
  return {
    aspect_ratio: typeof o.aspect_ratio === 'string' && parseRatio(o.aspect_ratio) ? o.aspect_ratio.trim() : '1:1',
    hld: str(o.high_level_description),
    bg: str(cd.background),
    elements: els
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e) => ({
        key: newKey(),
        type: e.type === 'text' ? 'text' : 'obj',
        bbox: bboxOf(e.bbox),
        desc: str(e.desc),
        text: str(e.text),
      })),
  }
}

/** A new element on top (last), on the default box of the doc's ratio. */
export function addEl(doc: Doc, type: ElType): Doc {
  return { ...doc, elements: [...doc.elements, newEl(type, doc.aspect_ratio)] }
}

export function removeEl(doc: Doc, i: number): Doc {
  return { ...doc, elements: doc.elements.filter((_, j) => j !== i) }
}

/** Swaps the element with its neighbour: "forward" = later in the array = more on top. No-op at the ends. */
export function moveEl(doc: Doc, i: number, dir: 'forward' | 'backward'): Doc {
  const j = dir === 'forward' ? i + 1 : i - 1
  if (i < 0 || j < 0 || i >= doc.elements.length || j >= doc.elements.length) return doc
  const elements = [...doc.elements]
  ;[elements[i], elements[j]] = [elements[j], elements[i]]
  return { ...doc, elements }
}

export function setBbox(doc: Doc, i: number, bbox: Bbox | null): Doc {
  return { ...doc, elements: doc.elements.map((e, j) => (j === i ? { ...e, bbox } : e)) }
}

/**
 * The bbox checkbox: off keeps the box aside (classic), on brings it back, or
 * the default box of the doc's ratio when there is none.
 */
export function toggleBbox(doc: Doc, i: number, on: boolean): Doc {
  return {
    ...doc,
    elements: doc.elements.map((e, j) => {
      if (j !== i || on === !!e.bbox) return e
      if (!on) return { ...e, bbox: null, lastBbox: e.bbox! }
      const { lastBbox, ...rest } = e
      return { ...rest, bbox: lastBbox ?? defBbox(e.type, doc.aspect_ratio) }
    }),
  }
}

/** Patches one element's fields. */
export function setEl(doc: Doc, i: number, patch: Partial<Pick<El, 'desc' | 'text'>>): Doc {
  return { ...doc, elements: doc.elements.map((e, j) => (j === i ? { ...e, ...patch } : e)) }
}
