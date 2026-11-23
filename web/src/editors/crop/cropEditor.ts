import { HANDLES, applyRatio, clampBox, moveBox, resizeBox, type Box, type Handle } from './cropMath'

export interface CropEditorOptions {
  /** True source size (the `X-Src-*` headers), not the preview's natural size. */
  srcW: number
  srcH: number
  ratio: number | null
  box: Box
  /** Every change, the first draw included; the box is in source px, unrounded. */
  onChange(box: Box): void
}

export interface CropEditor {
  setRatio(r: number | null): void
  setBox(b: Box): void
  destroy(): void
}

const CURSORS: Record<Handle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize',
}

/** Handles sit inside the box, so they stay hit-testable when it touches the image edge. */
function placeHandle(el: HTMLElement, h: Handle) {
  const s = el.style
  if (h.includes('n')) s.top = '0'
  else if (h.includes('s')) s.bottom = '0'
  else s.top = 'calc(50% - 6px)'
  if (h.includes('w')) s.left = '0'
  else if (h.includes('e')) s.right = '0'
  else s.left = 'calc(50% - 6px)'
  s.cursor = CURSORS[h]
}

/**
 * The crop box over `img`, drawn inside `stage` (positioned, the image's size).
 * Dragging the box moves it, dragging one of the 8 handles resizes it (pointer
 * capture, no window listeners). With the stage focused the arrow keys move it
 * 1 source px, 10 with Shift. A ResizeObserver keeps the screen scale current.
 */
export function createCropEditor(stage: HTMLElement, img: HTMLImageElement, opts: CropEditorOptions): CropEditor {
  const { srcW, srcH, onChange } = opts
  let ratio = opts.ratio
  let box = clampBox(opts.box, srcW, srcH, ratio)
  let scale = 0 // screen px per source px
  let drag: { handle: Handle | null; x: number; y: number; start: Box } | null = null

  const rect = document.createElement('div')
  rect.dataset.testid = 'crop-rect'
  rect.className = 'absolute cursor-move touch-none border border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]'
  for (const h of HANDLES) {
    const el = document.createElement('i')
    el.dataset.h = h
    el.className = 'absolute size-3 rounded-[3px] border border-white bg-accent-to/80'
    placeHandle(el, h)
    rect.appendChild(el)
  }
  stage.appendChild(rect)
  stage.tabIndex = 0

  function draw() {
    const s = rect.style
    s.left = `${box[0] * scale}px`
    s.top = `${box[1] * scale}px`
    s.width = `${box[2] * scale}px`
    s.height = `${box[3] * scale}px`
  }

  function update(b: Box) {
    box = clampBox(b, srcW, srcH, ratio)
    draw()
    onChange(box)
  }

  const measure = () => {
    scale = img.clientWidth / srcW
    draw()
  }
  const ro = new ResizeObserver(measure)
  ro.observe(img)
  measure()
  onChange(box)

  function onDown(e: PointerEvent) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    drag = { handle: (target.dataset.h as Handle | undefined) ?? null, x: e.clientX, y: e.clientY, start: box }
    target.setPointerCapture(e.pointerId)
    // preventDefault below also stops the focus change, and the keys need it.
    stage.focus({ preventScroll: true })
    e.preventDefault()
  }

  function onMove(e: PointerEvent) {
    if (!drag || scale <= 0) return
    const dx = (e.clientX - drag.x) / scale
    const dy = (e.clientY - drag.y) / scale
    if (drag.handle) update(resizeBox(drag.start, drag.handle, dx, dy, srcW, srcH, ratio))
    else update(moveBox(drag.start, dx, dy, srcW, srcH, ratio))
  }

  const onUp = () => {
    drag = null
  }

  function onKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 10 : 1
    const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[e.key]
    if (!d) return
    e.preventDefault()
    update(moveBox(box, d[0], d[1], srcW, srcH, ratio))
  }

  rect.addEventListener('pointerdown', onDown)
  rect.addEventListener('pointermove', onMove)
  rect.addEventListener('pointerup', onUp)
  rect.addEventListener('lostpointercapture', onUp)
  stage.addEventListener('keydown', onKey)

  return {
    setRatio(r) {
      ratio = r
      update(applyRatio(box, r))
    },
    setBox(b) {
      update(b)
    },
    destroy() {
      ro.disconnect()
      stage.removeEventListener('keydown', onKey)
      stage.removeAttribute('tabindex')
      rect.remove()
    },
  }
}
