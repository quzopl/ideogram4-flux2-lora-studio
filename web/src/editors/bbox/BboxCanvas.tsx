import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { HANDLES, hitStack, moveBy, resize, toBbox, toPx, type Handle } from './geometry'
import { parseRatio, removeEl, setBbox, type Bbox, type Doc, type El } from './model'

interface BboxCanvasProps {
  doc: Doc
  /** Index in `doc.elements`, or null. */
  selected: number | null
  onSelect: (i: number | null) => void
  onChange: (doc: Doc) => void
}

/** A press that moves less than this (px) is a click. */
const CLICK_PX = 3
/** Room around the frame for the tags and the handles of boxes at its edge. */
const PAD = 28

const HANDLE_POS: Record<Handle, string> = {
  nw: 'left-0 top-0',
  n: 'left-1/2 top-0',
  ne: 'left-full top-0',
  e: 'left-full top-1/2',
  se: 'left-full top-full',
  s: 'left-1/2 top-full',
  sw: 'left-0 top-full',
  w: 'left-0 top-1/2',
}
const CURSORS: Record<Handle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
}

interface Drag {
  pointerId: number
  index: number
  key: string
  /** null = the body (a move). */
  handle: Handle | null
  x: number
  y: number
  W: number
  H: number
  start: Bbox
  stack: number[]
  /** This press changed the selection (then its release never cycles). */
  changed: boolean
  moved: boolean
}

/** The largest w × h of ratio `aw:ah` inside the host's content box. */
function fit(availW: number, availH: number, ar: string) {
  const [aw, ah] = parseRatio(ar) ?? [1, 1]
  let w = availW
  let h = (w * ah) / aw
  if (h > availH) {
    h = availH
    w = (h * aw) / ah
  }
  return w > 0 && h > 0 ? { w, h } : null
}

/**
 * The v15 layout canvas: a frame of the doc's exact aspect ratio with a 10%
 * grid and one box per element with a bbox. Dragging a box moves it, the 8
 * handles of the selected one resize it. A press picks the selected element if
 * it is under the pointer, else the smallest one there (and selects it); a click
 * that did not change the selection cycles through the stack, smallest first.
 * With the canvas focused: arrows move 1 unit (Shift 10), Delete/Backspace
 * remove, Escape deselects (not during a drag; keys with Alt/Ctrl/Meta are ignored).
 */
export function BboxCanvas({ doc, selected, onSelect, onChange }: BboxCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState<{ w: number; h: number } | null>(null)
  const drag = useRef<Drag | null>(null)
  // The captured pointer keeps the cursor of the host, so it is set there while dragging.
  const [dragCursor, setDragCursor] = useState<string | undefined>()

  // Read by the pointer handlers, which run between renders.
  const latest = useRef({ doc, onChange })
  useLayoutEffect(() => {
    latest.current = { doc, onChange }
  })

  useEffect(() => {
    const host = hostRef.current!
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setAvail((a) => (a && a.w === width && a.h === height ? a : { w: width, h: height }))
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  const size = avail && fit(avail.w, avail.h, doc.aspect_ratio)

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || drag.current) return
    const frameEl = frameRef.current
    if (!frameEl) return
    const r = frameEl.getBoundingClientRect()
    const { doc } = latest.current
    const handle = ((e.target as HTMLElement).dataset.h as Handle | undefined) ?? null
    let index: number
    let stack: number[] = []
    let changed = false
    if (handle && selected !== null) {
      index = selected
    } else {
      stack = hitStack(doc, e.clientX - r.left, e.clientY - r.top, r.width, r.height)
      if (!stack.length) {
        onSelect(null)
        frameEl.focus({ preventScroll: true })
        return
      }
      if (selected !== null && stack.includes(selected)) index = selected
      else {
        index = stack[0]
        changed = true
        onSelect(index)
      }
    }
    const el = doc.elements[index]
    if (!el?.bbox) return
    drag.current = {
      pointerId: e.pointerId, index, key: el.key, handle, x: e.clientX, y: e.clientY,
      W: r.width, H: r.height, start: el.bbox, stack, changed, moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    // preventDefault below also stops the focus change, and the keys need it.
    frameEl.focus({ preventScroll: true })
    e.preventDefault()
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved) {
      if (Math.hypot(dx, dy) < CLICK_PX) return
      d.moved = true
      setDragCursor(d.handle ? CURSORS[d.handle] : 'move')
    }
    const { doc, onChange } = latest.current
    const i = doc.elements.findIndex((el) => el.key === d.key)
    if (i < 0) return
    const bbox = d.handle
      ? toBbox(resize(toPx(d.start, d.W, d.H), d.handle, dx, dy, d.W, d.H), d.W, d.H)
      : moveBy(d.start, Math.round((dy / d.H) * 1000), Math.round((dx / d.W) * 1000))
    const cur = doc.elements[i].bbox
    if (!cur || cur.some((v, k) => v !== bbox[k])) onChange(setBbox(doc, i, bbox))
  }

  function endDrag(e: PointerEvent<HTMLDivElement>, cycle: boolean) {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    drag.current = null
    setDragCursor(undefined)
    if (cycle && !d.moved && !d.changed && !d.handle && d.stack.length > 1) {
      const at = d.stack.indexOf(d.index)
      onSelect(d.stack[(at + 1) % d.stack.length])
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Modified keys belong to the browser; a drag in progress keeps its element.
    if (drag.current || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'Escape') {
      if (selected !== null) {
        e.preventDefault()
        onSelect(null)
      }
      return
    }
    if (selected === null) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      onChange(removeEl(doc, selected))
      return
    }
    const step = e.shiftKey ? 10 : 1
    const d = ({ ArrowLeft: [0, -step], ArrowRight: [0, step], ArrowUp: [-step, 0], ArrowDown: [step, 0] } as Record<string, [number, number]>)[e.key]
    const bbox = doc.elements[selected]?.bbox
    if (!d || !bbox) return
    e.preventDefault()
    onChange(setBbox(doc, selected, moveBy(bbox, d[0], d[1])))
  }

  const drawn = doc.elements.some((el) => el.bbox)

  return (
    <div
      ref={hostRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, false)}
      onLostPointerCapture={(e) => endDrag(e, false)}
      style={{ padding: PAD, cursor: dragCursor }}
      className="relative isolate grid h-[max(22rem,calc(100dvh-19rem))] place-items-center overflow-hidden rounded-2xl border border-line bg-[repeating-linear-gradient(45deg,var(--color-surface)_0_10px,var(--color-bg)_10px_20px)] select-none"
    >
      {size && (
        <div
          ref={frameRef}
          data-testid="bbox-frame"
          role="application"
          aria-label="Bbox canvas"
          aria-roledescription="layout canvas"
          tabIndex={0}
          onKeyDown={onKeyDown}
          style={{
            width: size.w,
            height: size.h,
            backgroundImage:
              'linear-gradient(to right, rgba(255,255,255,0.11) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.11) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.045) 1px, transparent 1px)',
            backgroundSize: '50% 50%, 50% 50%, 10% 10%, 10% 10%',
            backgroundPosition: '-0.5px -0.5px',
          }}
          className="relative touch-none rounded-[3px] bg-surface-2 shadow-[0_0_0_1px_rgba(255,255,255,0.09),0_24px_60px_-12px_rgba(0,0,0,0.7)] outline-none transition-[width,height,box-shadow] duration-200 ease-out focus-visible:shadow-[0_0_0_1px_rgba(255,255,255,0.09),0_0_0_4px_rgba(139,92,246,0.35),0_24px_60px_-12px_rgba(0,0,0,0.7)] motion-reduce:transition-none"
        >
          {doc.elements.map((el, i) =>
            el.bbox ? (
              <Box key={el.key} el={el} bbox={el.bbox} index={i} selected={i === selected} />
            ) : null,
          )}
          {!drawn && (
            <p className="pointer-events-none absolute inset-0 grid place-items-center p-4 text-center text-sm text-text-dim">
              Add an element with + obj or + text.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

const TONE = {
  obj: {
    box: 'border-bbox-obj bg-bbox-obj/12 hover:bg-bbox-obj/18',
    sel: 'border-white bg-bbox-obj/24 shadow-[0_0_0_1px_var(--color-bbox-obj),0_0_18px_color-mix(in_srgb,var(--color-bbox-obj)_45%,transparent)]',
    tag: 'bg-bbox-obj',
    handle: 'border-bbox-obj',
  },
  text: {
    box: 'border-bbox-text bg-bbox-text/12 hover:bg-bbox-text/18',
    sel: 'border-white bg-bbox-text/24 shadow-[0_0_0_1px_var(--color-bbox-text),0_0_18px_color-mix(in_srgb,var(--color-bbox-text)_45%,transparent)]',
    tag: 'bg-bbox-text',
    handle: 'border-bbox-text',
  },
}

function Box({ el, bbox, index, selected }: { el: El; bbox: Bbox; index: number; selected: boolean }) {
  const [y1, x1, y2, x2] = bbox
  const tone = TONE[el.type]
  // Numbered by array index + 1, as the server lint numbers elements.
  const label = el.type === 'text' ? `text: ${el.text || '…'}` : `obj #${index + 1}`
  return (
    <div
      data-testid="bbox-box"
      data-index={index}
      data-selected={selected || undefined}
      style={{
        left: `${x1 / 10}%`,
        top: `${y1 / 10}%`,
        width: `${(x2 - x1) / 10}%`,
        height: `${(y2 - y1) / 10}%`,
        zIndex: selected ? 1000 : index + 1,
      }}
      className={cn(
        'absolute animate-in cursor-move rounded-[2px] border-[1.5px] fade-in-0 zoom-in-95 motion-reduce:animate-none',
        'transition-[background-color,border-color,box-shadow] duration-150 motion-reduce:transition-none',
        selected ? tone.sel : tone.box,
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute max-w-40 truncate rounded-[5px] px-1.5 text-[11px] leading-[1.45] font-semibold text-white shadow-sm',
          // Lifted clear of the n/nw handles while selected.
          selected ? 'bottom-[calc(100%+7px)] left-0' : '-top-2.5 left-1.5',
          tone.tag,
        )}
      >
        {label}
      </span>
      {selected &&
        HANDLES.map((h) => (
          <i
            key={h}
            data-h={h}
            className={cn(
              'absolute size-2.5 -translate-1/2 rounded-[2px] border bg-white shadow-[0_1px_3px_rgba(0,0,0,0.5)] transition-transform duration-100 hover:scale-125 motion-reduce:transition-none',
              tone.handle,
              HANDLE_POS[h],
            )}
            style={{ cursor: CURSORS[h] }}
          />
        ))}
    </div>
  )
}
