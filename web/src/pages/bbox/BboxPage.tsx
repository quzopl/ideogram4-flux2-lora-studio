import { ClipboardPaste } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BboxCanvas } from '@/editors/bbox/BboxCanvas'
import { addEl, fromCaption, isDefaultDoc, parseRatio, toJson, type ElType } from '@/editors/bbox/model'
import { claimBboxHandoff, takeBboxHandoff } from '@/lib/bboxHandoff'
import { cn } from '@/lib/utils'
import { markAnalyzeApplied, type AnalyzeResult } from './analyzeStore'
import { flushDraft, getDraft, useBboxDoc } from './bboxStore'
import { FromImagePanel, FromImageTools, useFromImage, useImageDrop } from './FromImage'
import { errorText, LEGACY_WARNING, normalizePrompt, type Normalized } from './normalize'
import { PasteBar } from './PasteBar'
import { RenderPanel } from './RenderPanel'
import { SidePanel } from './SidePanel'

/** A load waiting for "Replace the current canvas?". */
interface PendingLoad {
  title: string
  apply: () => void
}

/** The classic toolbar's ratios. */
const RATIOS = ['1:1', '4:5', '9:16', '16:9', '3:1']

export function BboxPage() {
  const [doc, setDoc, selected, setSelected] = useBboxDoc()
  useEffect(() => flushDraft, [])
  // Any preset click (even the active one) resets the custom field and its error.
  const [presetClicks, setPresetClicks] = useState(0)
  const [pasting, setPasting] = useState(false)
  const [pasteText, setPasteText] = useState('')
  // Kept after the dialog closes, so its title does not change while it animates out.
  const [pending, setPending] = useState<PendingLoad | null>(null)
  const [confirming, setConfirming] = useState(false)
  // Whether the dialog is asking now (a ref: loads come from promises and effects of
  // older renders), and the loads that came meanwhile: an open question is never swapped.
  const asking = useRef(false)
  const queued = useRef<PendingLoad[]>([])

  const offer = (p: PendingLoad) => {
    if (asking.current) queued.current.push(p)
    else if (isDefaultDoc(getDraft().doc)) p.apply()
    else {
      asking.current = true
      setPending(p)
      setConfirming(true)
    }
  }
  const onConfirmOpen = (open: boolean) => {
    asking.current = open
    setConfirming(open)
  }
  // Once the question is answered (and a Replace applied), the waiting loads are offered
  // in turn (one that needs no question is applied and the next one follows).
  useEffect(() => {
    while (!confirming && !asking.current && queued.current.length) offer(queued.current.shift()!)
    // `offer` only reads refs and the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming])

  /** Puts a normalised prompt on the canvas, asking first when that would replace work. */
  const load = (n: Normalized, title: string, done?: () => void) => {
    const apply = () => {
      const doc = fromCaption(JSON.parse(n.prompt))
      setDoc(doc)
      // New keys: the selection would be lost, so the first element is selected (classic).
      setSelected(doc.elements.length ? 0 : null)
      if (n.legacy_style) toast.warning(LEGACY_WARNING, { duration: 12000 })
      done?.()
    }
    offer({ title, apply })
  }

  // A prompt handed over by the Prompt studio is claimed in an initializer (StrictMode
  // mounts twice, so not in an effect cleanup) and loaded once.
  useState(claimBboxHandoff)
  useEffect(() => {
    const json = takeBboxHandoff()
    if (json === null) return
    // A plain promise: StrictMode's remount would detach a mutation's per-call callbacks.
    normalizePrompt(json).then(
      (n) =>
        load(n, 'Replace the current canvas with the prompt from the studio?', () =>
          toast.success('Prompt loaded for editing.')),
      (e: Error) => toast.error(errorText(e)),
    )
    // Once per entry; `load` only reads the store at that time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // From image: a finished analysis is offered for the canvas once (also across
  // remounts and reloads), not while another question is open; refused, it waits
  // behind Load draft.
  const fromImage = useFromImage()
  const drop = useImageDrop(fromImage.analyze)
  const loadDraft = (r: AnalyzeResult) =>
    // The job's JSON is already a normalised v15 prompt.
    load({ prompt: r.json, legacy_style: false }, 'Replace the current canvas with the image draft?', () =>
      toast.success(`Draft ready: ${r.elements} elements (${r.model}).`))
  const { result, applied } = fromImage.run
  useEffect(() => {
    if (result && !applied && !confirming && markAnalyzeApplied()) loadDraft(result)
    // `loadDraft` only reads the store at that time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, applied, confirming])

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
            <Button size="lg" variant="outline" aria-expanded={pasting} onClick={() => setPasting((p) => !p)}>
              <ClipboardPaste />
              Paste JSON
            </Button>
            <FromImageTools fi={fromImage} onLoadDraft={loadDraft} />
          </div>
          <FromImagePanel fi={fromImage} />
          <AnimatePresence initial={false}>
            {pasting && (
              <PasteBar
                key="paste"
                text={pasteText}
                onText={setPasteText}
                onLoaded={(n) => load(n, 'Replace the current canvas?', () => setPasting(false))}
                onCancel={() => setPasting(false)}
              />
            )}
          </AnimatePresence>
          <div
            data-testid="bbox-drop"
            onDragOver={drop.onDragOver}
            onDragLeave={drop.onDragLeave}
            onDrop={drop.onDrop}
            className={cn('rounded-2xl transition-shadow', drop.over && 'shadow-glow')}
          >
            <BboxCanvas doc={doc} selected={selected} onSelect={setSelected} onChange={setDoc} />
          </div>
        </section>

        <SidePanel doc={doc} selected={selected} onSelect={setSelected} onChange={setDoc} />
      </div>

      <RenderPanel json={toJson(doc)} />

      <ConfirmDialog
        open={confirming}
        onOpenChange={onConfirmOpen}
        title={pending?.title ?? ''}
        action="Replace"
        onConfirm={() => pending?.apply()}
      >
        Everything on the canvas now is replaced by the loaded prompt.
      </ConfirmDialog>
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
