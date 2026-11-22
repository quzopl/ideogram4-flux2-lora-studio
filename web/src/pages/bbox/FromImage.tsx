import { Camera, ImageDown } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { JobProgress } from '@/components/JobProgress'
import { NumberInput } from '@/components/NumberInput'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { VlmSelect } from '@/components/VlmSelect'
import { useSavedForm } from '@/hooks/useAutosave'
import { useJobPoll } from '@/hooks/useJobPoll'
import { api } from '@/lib/api'
import { useMutationWithToast } from '@/lib/queries'
import { cn } from '@/lib/utils'
import {
  dropAnalyze,
  failAnalyze,
  finishAnalyze,
  startAnalyze,
  useAnalyzeRun,
  type AnalyzeResult,
} from './analyzeStore'

/** Saved as forms.bbox. */
interface AnalyzeForm {
  engine: string
  /** "" until GET /api/models gives its default. */
  model: string
  quant: string
  max_tokens: number
}

const DEFAULTS: AnalyzeForm = { engine: 'florence', model: '', quant: '4bit', max_tokens: 1536 }

/** The classic engine select (inventory §1.1). */
const ENGINES: [string, string][] = [
  ['florence', 'Florence-2 — fast, measured bboxes'],
  ['hybrid', 'Hybrid — Florence bboxes + VLM prose'],
  ['vlm', 'VLM only — full draft, estimated bboxes'],
]
const QUANTS: [string, string][] = [['4bit', '4-bit (saves VRAM)'], ['none', 'None (fp16)']]

const usesVlm = (engine: string) => engine !== 'florence'

/** Image extensions the server reads; a file with no MIME type (HEIC on some systems) is judged by these. */
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|tiff?|gif|heic|heif)$/i
const isImage = (f: File) => f.type.startsWith('image/') || (f.type === '' && IMAGE_EXT.test(f.name))

/** GET /api/ideogram/analyze/jobs/{id}. */
interface AnalyzeJob {
  state: 'pending' | 'loading_model' | 'analyzing' | 'done' | 'error'
  current: string
  error: string
  result: AnalyzeResult | null
}

const STEP: Record<string, string> = { pending: 'Starting…', analyzing: 'Analyzing…' }

/**
 * "From image": the saved engine/model form, the background analyze job and
 * its result in analyzeStore (so it survives leaving the view). The page puts
 * a finished result on the canvas.
 */
export function useFromImage() {
  const [form, setForm, loaded] = useSavedForm<AnalyzeForm>('bbox', DEFAULTS)
  const [maxTokensError, setMaxTokensError] = useState('')
  const run = useAnalyzeRun()
  const jobId = run.jobId
  const job = useJobPoll<AnalyzeJob>(['analyze-job', jobId], jobId ? `/api/ideogram/analyze/jobs/${jobId}` : null)

  const data = job.data
  useEffect(() => {
    if (!jobId) return
    if (data?.state === 'done' && data.result) finishAnalyze(jobId, data.result)
    else if (data?.state === 'error') failAnalyze(jobId, data.error || 'Image analysis failed.')
    else if (job.isGone) {
      toast.error('The analysis job is gone (was the server restarted?)')
      dropAnalyze(jobId)
    }
  }, [jobId, data, job.isGone])

  // At mutation level: the job is kept even if the view was left before the answer.
  const start = useMutationWithToast(
    ({ file, form }: { file: File; form: AnalyzeForm }) => {
      const body = new FormData()
      body.append('file', file)
      body.append('engine', form.engine)
      // Florence takes no model settings (as in the classic view).
      if (usesVlm(form.engine)) {
        if (form.model) body.append('model', form.model)
        body.append('quant', form.quant)
        body.append('max_tokens', String(form.max_tokens))
      }
      return api<{ job_id: string }>('/api/ideogram/analyze/jobs', { method: 'POST', body })
    },
    { onSuccess: (r, { file }) => startAnalyze(r.job_id, file) },
  )

  const busy = start.isPending || jobId !== null
  const ready = loaded && !busy && !(usesVlm(form.engine) && (maxTokensError !== '' || form.model === ''))

  /** Analyses `file` (picked or dropped); ignored while not ready, like the disabled button. */
  const analyze = (file: File) => {
    if (ready) start.mutate({ file, form })
  }

  return { form, setForm, loaded, ready, run, data, analyze, setMaxTokensError }
}

type FromImageState = ReturnType<typeof useFromImage>

/** The toolbar part: the button (with its hidden picker), the engine and Load draft. */
export function FromImageTools({ fi, onLoadDraft }: { fi: FromImageState; onLoadDraft: (r: AnalyzeResult) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const { form, setForm, run } = fi
  return (
    <>
      <Button
        size="lg"
        variant="outline"
        title="Analyze a reference photo into a v15 draft"
        disabled={!fi.ready}
        onClick={() => input.current?.click()}
      >
        <Camera />
        From image
      </Button>
      <input
        ref={input}
        type="file"
        accept="image/*,.heic,.heif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared, so the same file can be picked again.
          e.target.value = ''
          if (file) fi.analyze(file)
        }}
      />
      <Select value={form.engine} onValueChange={(engine) => setForm((f) => ({ ...f, engine }))} disabled={!fi.loaded}>
        <SelectTrigger aria-label="Engine" title="How to analyze the reference image" className="h-9 max-w-60 min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ENGINES.map(([v, label]) => (
            <SelectItem key={v} value={v}>
              {/* Shown in the narrow trigger too, cut with an ellipsis. */}
              <span className="truncate">{label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {run.result && !run.jobId && (
        <Button
          size="lg"
          variant="ghost"
          title={`Put the last image draft (${run.result.elements} elements, ${run.result.model}) on the canvas`}
          onClick={() => onLoadDraft(run.result!)}
        >
          <ImageDown />
          Load draft
        </Button>
      )}
    </>
  )
}

function Field({ label, htmlFor, className, children }: {
  label: string
  htmlFor: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-text-dim">{label}</label>
      {children}
    </div>
  )
}

/** The vision model settings (Hybrid and VLM only) and the job's progress with the photo. */
export function FromImagePanel({ fi }: { fi: FromImageState }) {
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const { form, setForm, run, data, setMaxTokensError } = fi
  const setModel = useCallback((model: string) => setForm((f) => ({ ...f, model })), [setForm])
  const onValidity = useCallback((_: 'max_tokens', error: string) => setMaxTokensError(error), [setMaxTokensError])
  const photo = usePhotoUrl(run.photo)

  // The job error has a traceback after its first line: that line shows, the whole text is in the title.
  const error = run.jobId ? '' : run.error
  const state = error ? 'error' : (data?.state ?? 'pending')
  const step = state === 'loading_model' ? data?.current || 'Loading the model…' : STEP[state]
  const vlm = usesVlm(form.engine)

  return (
    <AnimatePresence initial={false}>
      {vlm && (
        <motion.fieldset
          key="vlm"
          disabled={!fi.loaded}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="grid gap-x-4 gap-y-3 rounded-xl border border-line bg-surface p-3 sm:grid-cols-[minmax(0,1fr)_11rem_9rem]"
        >
          <Field label="Model" htmlFor={id('model')}>
            <VlmSelect id={id('model')} value={form.model} onChange={setModel} />
          </Field>
          <Field label="Quantization" htmlFor={id('quant')}>
            <Select value={form.quant} onValueChange={(quant) => setForm((f) => ({ ...f, quant }))}>
              <SelectTrigger id={id('quant')} className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUANTS.map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Max length (tokens)" htmlFor={id('maxtok')}>
            <NumberInput
              id={id('maxtok')}
              field="max_tokens"
              onValidity={onValidity}
              min={64}
              max={8192}
              step={32}
              title="Reasoning models (Qwen3 and friends) count their thinking against this limit — give them 2048+ or they return nothing."
              value={form.max_tokens}
              onChange={(max_tokens) => setForm((f) => ({ ...f, max_tokens }))}
            />
          </Field>
        </motion.fieldset>
      )}
      {(run.jobId || error) && (
        <motion.div
          key="progress"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          title={error || undefined}
          className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3"
        >
          {photo && <img src={photo} alt="Reference photo" className="size-12 shrink-0 rounded-md object-cover" />}
          <div className="min-w-0 flex-1">
            <JobProgress
              state={state}
              current={error ? undefined : step}
              error={error ? error.split('\n')[0] : undefined}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** An object URL of the photo while it is shown; revoked when it changes or the view closes. */
function usePhotoUrl(photo: File | null) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!photo) return
    const u = URL.createObjectURL(photo)
    setUrl(u)
    return () => {
      URL.revokeObjectURL(u)
      setUrl(null)
    }
  }, [photo])
  return photo ? url : null
}

/** Drop handlers for the canvas host: the first image file is analysed. */
export function useImageDrop(analyze: (file: File) => void) {
  const [over, setOver] = useState(false)
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  return {
    over,
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setOver(true)
    },
    // Not when it only moves onto a child of the host.
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setOver(false)
      const file = Array.from(e.dataTransfer.files).find(isImage)
      if (file) analyze(file)
    },
  }
}
