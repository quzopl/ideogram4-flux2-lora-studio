import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BboxCanvas } from '@/editors/bbox/BboxCanvas'
import { addEl, parseRatio, toJson, type ElType } from '@/editors/bbox/model'
import { cn } from '@/lib/utils'
import { flushDraft, getDraft, useBboxDoc } from './bboxStore'

/** The classic toolbar's ratios. */
const RATIOS = ['1:1', '4:5', '9:16', '16:9', '3:1']

export function BboxPage() {
  const [doc, setDoc, selected, setSelected] = useBboxDoc()
  useEffect(() => flushDraft, [])
  // Any preset click (even the active one) resets the custom field and its error.
  const [presetClicks, setPresetClicks] = useState(0)

  const setRatio = (aspect_ratio: string) => setDoc((d) => ({ ...d, aspect_ratio }))
  const add = (type: ElType) => {
    setDoc((d) => addEl(d, type))
    setSelected(getDraft().doc.elements.length - 1)
  }

  return (
    <div className="flex flex-col gap-6 px-10 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Bbox editor</h1>
        <p className="mt-1 text-sm text-text-dim">
          Lay out elements visually on the canvas (0–1000, [y1,x1,y2,x2]). Drag a box to move it, its handles to
          resize it; clicking the same spot again cycles overlapping boxes. Arrow keys nudge (Shift ×10), Delete
          removes.
        </p>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-start gap-2">
            <RatioPicker
              value={doc.aspect_ratio}
              onChange={(r) => {
                setRatio(r)
                setPresetClicks((n) => n + 1)
              }}
            />
            <CustomRatio key={presetClicks} value={doc.aspect_ratio} onChange={setRatio} />
            <Button size="lg" onClick={() => add('obj')}>+ obj</Button>
            <Button size="lg" variant="outline" onClick={() => add('text')}>+ text</Button>
          </div>
          <BboxCanvas doc={doc} selected={selected} onSelect={setSelected} onChange={setDoc} />
        </section>

        <aside className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-xs font-medium tracking-wide text-text-dim uppercase">JSON</h2>
          <pre
            data-testid="bbox-json"
            className="max-h-[60vh] overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-[#cdd2da]"
          >
            {toJson(doc, true)}
          </pre>
        </aside>
      </div>
    </div>
  )
}

/** The five ratios; the pill slides to the active one (none for a custom ratio). */
function RatioPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div role="group" aria-label="Aspect ratio" className="flex gap-1 rounded-xl border border-line bg-bg/60 p-1">
      {RATIOS.map((r) => {
        const active = r === value
        return (
          <button
            key={r}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(r)}
            className={cn(
              'relative rounded-lg px-3 py-1 font-mono text-[13px] whitespace-nowrap transition-colors outline-none focus-visible:shadow-glow',
              active ? 'text-white' : 'text-text-dim hover:text-text',
            )}
          >
            {active && (
              <motion.span
                layoutId="bbox-ratio"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                className="absolute inset-0 rounded-lg bg-linear-to-r from-accent-from to-accent-to shadow-[0_0_16px_rgba(139,92,246,0.35)]"
              />
            )}
            <span className="relative">{r}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Any W:H, applied on blur or Enter (not per keystroke); a bad one is shown as an error. */
function CustomRatio({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value)
  const [error, setError] = useState('')
  // A ratio set elsewhere (a preset, a load) replaces the typed text.
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setText(value)
    setError('')
  }
  const commit = () => {
    const v = text.trim()
    if (!parseRatio(v)) {
      setError('Use W:H with whole numbers above 0, e.g. 21:9')
      return
    }
    setError('')
    setText(v)
    if (v !== value) onChange(v)
  }
  return (
    <div className="relative">
      <Input
        aria-label="Custom aspect ratio (W:H)"
        title="custom W:H"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setError('')
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'bbox-ratio-error' : undefined}
        className="h-9 w-20 text-center font-mono"
      />
      {error && (
        <p
          id="bbox-ratio-error"
          className="absolute top-full left-0 z-20 mt-1 rounded-md border border-danger/30 bg-surface-2 px-2 py-1 text-xs whitespace-nowrap text-danger shadow-lg"
        >
          {error}
        </p>
      )}
    </div>
  )
}
