import { useQuery } from '@tanstack/react-query'
import { Loader2, RotateCcw, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { SpringDialogContent } from '@/components/SpringDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createCropEditor, type CropEditor } from '@/editors/crop/cropEditor'
import { defaultBox, fractional, fromFractional, roundBox, type Box } from '@/editors/crop/cropMath'
import { useCropPlan } from '@/hooks/useCropPlan'
import { api, ApiError } from '@/lib/api'
import { useMutationWithToast } from '@/lib/queries'
import type { CropAutoJob, CropPlan } from '@/lib/types'

/** The classic modal's ratio options (value = w/h). */
const RATIOS = [
  { value: 'free', label: 'Free' },
  { value: '1', label: '1:1' },
  { value: '0.75', label: '3:4' },
  { value: '1.3333', label: '4:3' },
  { value: '1.7778', label: '16:9' },
]
/** Files whose aspect ratio is this close get the same crop. */
const SAME_RATIO = 0.02
const TERMINAL = ['done', 'error']
/** The last ratio chosen, kept for the next file opened (as the classic modal did). */
let lastRatio = 'free'

interface AutoCropSettings {
  /** Caption mode (`person`, `landscape`, …): it decides what Florence looks for. */
  mode: string
  resolution: number
  step: number
}

interface CropEditorDialogProps {
  folder: string
  name: string
  /** Every file of the folder, for "Apply to same ratio". */
  files: string[]
  /** "Square (crop to 1:1)": the ratio is locked to 1:1. */
  square: boolean
  /** Dataset settings sent with "Auto (Florence)". */
  autoCrop: AutoCropSettings
  onClose: () => void
}

interface Source {
  url: string
  w: number
  h: number
}

/**
 * Manual crop of one source image. Edits stay in the dialog until Save (or
 * Apply to same ratio), which writes the plan and switches the folder's crop
 * source to manual. Cancel and Esc close without saving; so does Auto, which
 * only moves the box. A new file (or folder) mounts a fresh editor.
 */
export function CropEditorDialog(props: CropEditorDialogProps) {
  return <Editor key={`${props.folder}\n${props.name}`} {...props} />
}

function Editor({ folder, name, files, square, autoCrop, onClose }: CropEditorDialogProps) {
  const crops = useCropPlan(folder)
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const editorRef = useRef<CropEditor | null>(null)
  const [src, setSrc] = useState<Source | null>(null)
  const [loadError, setLoadError] = useState('')
  const [imgReady, setImgReady] = useState(false)
  const [box, setBox] = useState<Box | null>(null)
  const [ratioValue, setRatioValueState] = useState(lastRatio)
  const setRatioValue = (v: string) => {
    lastRatio = v
    setRatioValueState(v)
  }
  const [applying, setApplying] = useState(false)
  // "Apply to same ratio" awaits requests; it must not write after the dialog closed.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const ratio = square ? 1 : ratioValue === 'free' ? null : parseFloat(ratioValue)

  // Read when the editor is created, without recreating it on every change.
  const planRef = useRef<CropPlan>(crops.plan)
  const ratioRef = useRef(ratio)
  useEffect(() => {
    planRef.current = crops.plan
    ratioRef.current = ratio
  })

  // The ≤1600 px preview; the headers carry the true source size.
  useEffect(() => {
    const ctl = new AbortController()
    let url = ''
    fetch(`/api/src/image?${new URLSearchParams({ folder, name })}`, { signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim())
        const w = parseInt(res.headers.get('X-Src-Width') ?? '', 10)
        const h = parseInt(res.headers.get('X-Src-Height') ?? '', 10)
        if (!(w > 0 && h > 0)) throw new Error('no source size')
        const blob = await res.blob()
        if (ctl.signal.aborted) return
        url = URL.createObjectURL(blob)
        setSrc({ url, w, h })
      })
      .catch((e: Error) => {
        if (!ctl.signal.aborted) setLoadError(e.message)
      })
    return () => {
      ctl.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [folder, name])

  useEffect(() => {
    const stage = stageRef.current
    const img = imgRef.current
    if (!src || !imgReady || !crops.loaded || !stage || !img) return
    const r = ratioRef.current
    const ed = createCropEditor(stage, img, {
      srcW: src.w,
      srcH: src.h,
      ratio: r,
      box: planRef.current[name] ?? defaultBox(src.w, src.h, r),
      onChange: setBox,
    })
    editorRef.current = ed
    return () => {
      ed.destroy()
      editorRef.current = null
    }
  }, [src, imgReady, crops.loaded, name])

  useEffect(() => {
    editorRef.current?.setRatio(ratio)
  }, [ratio])

  // Auto (Florence) for this file. Polling survives transient errors and
  // stops on a final state or a 404 (job unknown, e.g. server restarted).
  const [autoJob, setAutoJob] = useState<string | null>(null)
  const startAuto = useMutationWithToast(() =>
    api<{ job_id: string; total: number }>('/api/crop/auto', {
      method: 'POST',
      json: { folder, ...autoCrop, square, names: [name] },
    }),
  )
  const isGone = (e: unknown) => e instanceof ApiError && e.status === 404
  const job = useQuery({
    queryKey: ['crop-auto', autoJob],
    queryFn: () => api<CropAutoJob>(`/api/crop/auto/${autoJob}`),
    enabled: autoJob !== null,
    refetchInterval: (q) => (isGone(q.state.error) || TERMINAL.includes(q.state.data?.state ?? '') ? false : 800),
  })
  const autoState = job.data?.state ?? ''
  const autoRunning =
    startAuto.isPending || (autoJob !== null && !(job.isError && isGone(job.error)) && !TERMINAL.includes(autoState))
  const handledJob = useRef<string | null>(null)
  const [nothingFound, setNothingFound] = useState(false)
  useEffect(() => {
    if (autoState !== 'done' || !autoJob || handledJob.current === autoJob) return
    handledJob.current = autoJob
    const found = job.data?.crops[name]
    if (found) editorRef.current?.setBox(found)
    setNothingFound(!found)
  }, [autoState, autoJob, job.data, name])
  const autoError = autoState === 'error'
    ? (job.data?.error ?? '')
    : job.isError && isGone(job.error)
      ? 'The auto-crop job is gone (was the server restarted?)'
      : ''

  const save = () => {
    if (!box) return
    crops.set(name, roundBox(box))
    crops.setMode('manual')
    onClose()
  }

  // The same fractional box on every file of (nearly) the same aspect ratio;
  // one light size request per file. This image always gets its own box.
  const applyToSameRatio = async () => {
    if (!box || !src) return
    setApplying(true)
    const f = fractional(box, src.w, src.h)
    const ar = src.w / src.h
    const sizes = await Promise.allSettled(
      files.map((n) => api<{ width: number; height: number }>(`/api/src/size?${new URLSearchParams({ folder, name: n })}`)),
    )
    if (!alive.current) return
    const boxes: CropPlan = {}
    let failed = 0
    sizes.forEach((res, i) => {
      if (res.status !== 'fulfilled') {
        if (files[i] !== name) failed++
        return
      }
      const { width: w, height: h } = res.value
      if (w > 0 && h > 0 && Math.abs(w / h - ar) <= SAME_RATIO) boxes[files[i]] = fromFractional(f, w, h)
    })
    boxes[name] = roundBox(box)
    if (failed > 0) {
      toast.warning(
        `Applied to ${Object.keys(boxes).length} of ${files.length} images: the size of ${failed === 1 ? '1 image' : `${failed} images`} could not be read.`,
      )
    }
    crops.merge(boxes)
    crops.setMode('manual')
    onClose()
  }

  const ready = box !== null
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <SpringDialogContent className="sm:max-w-5xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{name}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3">
          <Select value={square ? '1' : ratioValue} onValueChange={setRatioValue} disabled={square}>
            <SelectTrigger aria-label="Aspect ratio" className="min-w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RATIOS.map((r) => (
                <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span data-testid="crop-size" className="font-mono text-xs text-text-dim tabular-nums">
            {box ? `crop ${Math.round(box[2])} × ${Math.round(box[3])} px` : ''}
          </span>
        </div>

        <div className="flex min-h-40 min-w-0 items-center justify-center rounded-xl bg-[repeating-conic-gradient(#12151c_0%_25%,#181c25_0%_50%)] bg-size-[24px_24px]">
          {crops.error ? (
            <p className="p-6 text-sm text-danger">Cannot load the crop plan: {crops.error}</p>
          ) : loadError ? (
            <p className="p-6 text-sm text-danger">Cannot load the image: {loadError}</p>
          ) : !src ? (
            <Loader2 className="size-5 animate-spin text-text-dim" />
          ) : (
            <div
              ref={stageRef}
              data-testid="crop-stage"
              className="relative max-w-full min-w-0 touch-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-accent-to/60"
            >
              <img
                ref={imgRef}
                src={src.url}
                alt={name}
                draggable={false}
                onLoad={() => setImgReady(true)}
                onError={() => setLoadError('the browser cannot display it')}
                className="block h-auto max-h-[65vh] w-auto max-w-full select-none"
              />
            </div>
          )}
        </div>

        {autoError && (
          <p data-testid="crop-auto-error" title={autoError} className="text-xs text-danger">
            {autoError.split('\n')[0]}
          </p>
        )}
        {nothingFound && <p className="text-xs text-text-dim">Nothing detected; the box is unchanged.</p>}

        <DialogFooter className="mx-0 mb-0 rounded-none border-0 bg-transparent p-0 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!ready || autoRunning}
              onClick={() => {
                setNothingFound(false)
                startAuto.mutate(undefined, { onSuccess: (r) => setAutoJob(r.job_id) })
              }}
            >
              {autoRunning ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Auto (Florence)
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!ready}
              onClick={() => src && editorRef.current?.setBox(defaultBox(src.w, src.h, ratio))}
            >
              <RotateCcw />
              Reset
            </Button>
            <Button variant="outline" size="sm" disabled={!ready || applying} onClick={applyToSameRatio}>
              Apply to same ratio
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button
              size="sm"
              disabled={!ready || applying}
              onClick={save}
              className="bg-linear-to-r from-accent-from to-accent-to text-white"
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </SpringDialogContent>
    </Dialog>
  )
}
