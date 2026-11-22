import { ChevronsLeftRight } from 'lucide-react'
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

interface BeforeAfterProps {
  before: string
  after: string
  alt: string
}

const clamp = (n: number) => Math.min(100, Math.max(0, n))

/**
 * Two images stacked in one box (both `object-contain`, so a small "before"
 * thumbnail lines up with the full-size "after"). The handle reveals "after"
 * to its right; drag it, or focus it and use the arrow keys (5% a step).
 */
export function BeforeAfter({ before, after, alt }: BeforeAfterProps) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(50)

  const follow = (e: PointerEvent) => {
    const r = box.current?.getBoundingClientRect()
    if (r && r.width > 0) setPos(clamp(((e.clientX - r.left) / r.width) * 100))
  }

  const key = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[e.key]
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? 100 : step === undefined ? null : clamp(pos + step)
    if (to === null) return
    e.preventDefault()
    setPos(to)
  }

  const img = 'pointer-events-none absolute inset-0 size-full object-contain select-none'
  return (
    <div
      ref={box}
      data-testid="before-after"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        follow(e)
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && follow(e)}
      className="relative h-[70vh] w-full cursor-ew-resize touch-none overflow-hidden rounded-xl bg-[repeating-conic-gradient(#12151c_0%_25%,#181c25_0%_50%)] bg-size-[24px_24px]"
    >
      <img src={before} alt={`${alt} before`} draggable={false} className={img} />
      <img
        src={after}
        alt={`${alt} after`}
        draggable={false}
        className={img}
        style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
      />
      <span className="pointer-events-none absolute top-3 left-3 rounded-md bg-black/55 px-2 py-0.5 text-xs text-text-dim backdrop-blur">
        Before
      </span>
      <span className="pointer-events-none absolute top-3 right-3 rounded-md bg-black/55 px-2 py-0.5 text-xs text-text backdrop-blur">
        After
      </span>

      <div className="pointer-events-none absolute inset-y-0 w-px bg-white/80" style={{ left: `${pos}%` }} />
      <div
        role="slider"
        tabIndex={0}
        aria-label="Before / after"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos)}
        aria-valuetext={`${Math.round(pos)}% before`}
        onKeyDown={key}
        style={{ left: `${pos}%` }}
        className="absolute top-1/2 grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-surface-2/90 text-text shadow-lg backdrop-blur outline-none focus-visible:shadow-glow"
      >
        <ChevronsLeftRight className="size-4" />
      </div>
    </div>
  )
}
