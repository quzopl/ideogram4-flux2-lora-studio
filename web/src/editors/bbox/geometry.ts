// Canvas geometry of the Bbox editor, ported from frontend/bbox_editor.js
// (pxFromBbox, bboxFromPx). A bbox is [y1, x1, y2, x2] on a 0–1000 grid per
// axis; a rect is in frame pixels (W × H).

import type { Bbox, Doc } from './model'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function toPx(bbox: Bbox, W: number, H: number): Rect {
  const [y1, x1, y2, x2] = bbox
  return { left: (x1 / 1000) * W, top: (y1 / 1000) * H, width: ((x2 - x1) / 1000) * W, height: ((y2 - y1) / 1000) * H }
}

/** Whole units in 0–1000, each side at least 10 units (classic bboxFromPx forced that only when inverted). */
export function toBbox(rect: Rect, W: number, H: number): Bbox {
  let x1 = clamp(Math.round((rect.left / W) * 1000), 0, 1000)
  let y1 = clamp(Math.round((rect.top / H) * 1000), 0, 1000)
  let x2 = clamp(Math.round(((rect.left + rect.width) / W) * 1000), 0, 1000)
  let y2 = clamp(Math.round(((rect.top + rect.height) / H) * 1000), 0, 1000)
  if (x2 - x1 < 10) {
    x2 = Math.min(1000, x1 + 10)
    x1 = x2 - 10
  }
  if (y2 - y1 < 10) {
    y2 = Math.min(1000, y1 + 10)
    y1 = y2 - 10
  }
  return [y1, x1, y2, x2]
}

/**
 * The rect a drag of `handle` by (dx, dy) px makes from `rect`. The dragged
 * edges stay inside the frame and at least `minPx` from the opposite edge,
 * which does not move.
 */
export function resize(rect: Rect, handle: Handle, dx: number, dy: number, W: number, H: number, minPx = 8): Rect {
  let l = rect.left
  let t = rect.top
  let r = rect.left + rect.width
  let b = rect.top + rect.height
  if (handle.includes('w')) l = clamp(l + dx, 0, Math.max(0, r - minPx))
  if (handle.includes('e')) r = clamp(r + dx, Math.min(W, l + minPx), W)
  if (handle.includes('n')) t = clamp(t + dy, 0, Math.max(0, b - minPx))
  if (handle.includes('s')) b = clamp(b + dy, Math.min(H, t + minPx), H)
  return { left: l, top: t, width: r - l, height: b - t }
}

/**
 * The box shifted by (dy, dx) units, kept whole: at the frame edge it stops
 * instead of shrinking. A box already out of range is never pushed further out.
 */
export function moveBy(bbox: Bbox, dy: number, dx: number): Bbox {
  const [y1, x1, y2, x2] = bbox
  const my = clamp(dy, Math.min(0, -y1), Math.max(0, 1000 - y2))
  const mx = clamp(dx, Math.min(0, -x1), Math.max(0, 1000 - x2))
  return [y1 + my, x1 + mx, y2 + my, x2 + mx]
}

const area = ([y1, x1, y2, x2]: Bbox) => (y2 - y1) * (x2 - x1)

/**
 * Indices of the elements whose box contains the frame point (x, y), smallest
 * area first; on equal area the one on top (higher index) first.
 */
export function hitStack(doc: Doc, x: number, y: number, W: number, H: number): number[] {
  const hits: number[] = []
  doc.elements.forEach((e, i) => {
    if (!e.bbox) return
    const p = toPx(e.bbox, W, H)
    if (x >= p.left && x <= p.left + p.width && y >= p.top && y <= p.top + p.height) hits.push(i)
  })
  const els = doc.elements
  return hits.sort((a, b) => area(els[a].bbox!) - area(els[b].bbox!) || b - a)
}
