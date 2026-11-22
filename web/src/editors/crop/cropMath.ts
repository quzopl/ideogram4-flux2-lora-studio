// Crop box geometry, ported from frontend/crop_editor.js (CropEditor). Boxes are
// [x, y, w, h] in SOURCE pixels (the true size, after the EXIF fix); `ratio` is
// the forced w/h, or null for a free box.

export type Box = [number, number, number, number]
export type Handle = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se'

export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']

/** The largest box of `ratio` (or the image's own ratio), centred. */
export function defaultBox(srcW: number, srcH: number, ratio: number | null): Box {
  const r = ratio || srcW / srcH
  let w = srcW
  let h = w / r
  if (h > srcH) {
    h = srcH
    w = h * r
  }
  return [(srcW - w) / 2, (srcH - h) / 2, w, h]
}

/**
 * Fits the box inside the image, no side under `minSide`. Ratio-locked: shrink
 * to whichever dimension the image constrains first, then re-derive the height
 * from the ratio, so the box never drifts off-ratio while being fitted.
 */
export function clampBox(b: Box, srcW: number, srcH: number, ratio: number | null, minSide = 16): Box {
  let [x, y, w, h] = b
  if (ratio) {
    w = Math.max(minSide, Math.min(w, srcW, srcH * ratio))
    h = w / ratio
  } else {
    w = Math.max(minSide, Math.min(w, srcW))
    h = Math.max(minSide, Math.min(h, srcH))
  }
  x = Math.max(0, Math.min(x, srcW - w))
  y = Math.max(0, Math.min(y, srcH - h))
  return [x, y, w, h]
}

/**
 * Brings the box to `ratio` by shrinking its longer side. The anchors keep the
 * right / bottom edge in place (for handles dragged from the west / north).
 */
export function applyRatio(b: Box, ratio: number | null, anchorRight = false, anchorBottom = false): Box {
  if (!ratio) return b
  let [x, y, w, h] = b
  if (w / h > ratio) {
    const nw = h * ratio
    if (anchorRight) x += w - nw
    w = nw
  } else {
    const nh = w / ratio
    if (anchorBottom) y += h - nh
    h = nh
  }
  return [x, y, w, h]
}

/** The box a drag of `handle` by (dx, dy) source px makes from the start box `b`. */
export function resizeBox(
  b: Box,
  handle: Handle,
  dx: number,
  dy: number,
  srcW: number,
  srcH: number,
  ratio: number | null,
): Box {
  let [x, y, w, h] = b
  if (handle.includes('w')) {
    x = b[0] + dx
    w = b[2] - dx
  }
  if (handle.includes('e')) w = b[2] + dx
  if (handle.includes('n')) {
    y = b[1] + dy
    h = b[3] - dy
  }
  if (handle.includes('s')) h = b[3] + dy
  const ratioed = applyRatio([x, y, w, h], ratio, handle.includes('w'), handle.includes('n'))
  return clampBox(ratioed, srcW, srcH, ratio)
}

/** The box moved by (dx, dy) source px, kept inside the image. */
export function moveBox(b: Box, dx: number, dy: number, srcW: number, srcH: number, ratio: number | null): Box {
  return clampBox([b[0] + dx, b[1] + dy, b[2], b[3]], srcW, srcH, ratio)
}

/** Integer box, as the server stores it. */
export const roundBox = (b: Box): Box => [Math.round(b[0]), Math.round(b[1]), Math.round(b[2]), Math.round(b[3])]

/** The box as fractions of the image size (for "Apply to same ratio"). */
export function fractional(b: Box, srcW: number, srcH: number): Box {
  return [b[0] / srcW, b[1] / srcH, b[2] / srcW, b[3] / srcH]
}

/** A fractional box on an image of `srcW` × `srcH`, rounded to whole pixels. */
export function fromFractional(f: Box, srcW: number, srcH: number): Box {
  return roundBox([f[0] * srcW, f[1] * srcH, f[2] * srcW, f[3] * srcH])
}
