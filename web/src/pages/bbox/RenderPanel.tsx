import { useQuery } from '@tanstack/react-query'
import { Palette, RefreshCw, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { JobProgress } from '@/components/JobProgress'
import { NumberInput } from '@/components/NumberInput'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useJobPoll } from '@/hooks/useJobPoll'
import { api } from '@/lib/api'
import { useMutationWithToast } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { useBboxLint } from './lint'
import { errorText } from './normalize'
import { clearResults, dropRender, finishRender, startRender, useRenderRun, type RenderImage, type RenderOutcome } from './renderStore'

/** The classic render card's fields (inventory §1.5); all but `random` are sent. */
interface RenderForm {
  preset: string
  megapixels: number
  seed: number
  random: boolean
  variant: string
  batch_size: number
  lora_enabled: boolean
  lora_name: string
  lora_strength: number
  diff_model: string
  uncond_model: string
  vae_name: string
  clip_name: string
}

type Params = Record<string, unknown>

/** GET /api/ideogram/render/config: the last render's params, merged with the defaults (also the hidden cfg, shift…). */
interface RenderConfig {
  params: Params
  presets: string[]
}

/** GET /api/comfy/job/{id}. */
interface RenderJob {
  state: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  current: string
  progress: { value: number; max: number }
  has_preview: boolean
  preview_ts: number
  images: RenderImage[]
  error: string
}

const PRESETS: [string, string][] = [['Quality', 'Quality (48 steps)'], ['Default', 'Default (20)'], ['Turbo', 'Turbo (12)']]
const VARIANTS: [string, string][] = [['simple', 'Simple (AuraFlow + euler)'], ['ideogram4', 'Ideogram 4 (original)']]
const MODELS: ['diff_model' | 'uncond_model' | 'vae_name' | 'clip_name', string][] = [
  ['diff_model', 'Diffusion model'],
  ['uncond_model', 'Unconditional model'],
  ['vae_name', 'VAE'],
  ['clip_name', 'CLIP (text encoder)'],
]
const SENT = ['preset', 'megapixels', 'seed', 'variant', 'batch_size', 'lora_enabled', 'lora_name', 'lora_strength',
  'diff_model', 'uncond_model', 'vae_name', 'clip_name'] as const
const ENDS = ['done', 'error', 'cancelled']
const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

/** The form as the server saved it; "random" starts on (classic). */
const formOf = (p: Params) =>
  ({ ...Object.fromEntries(SENT.map((k) => [k, p[k]])), random: true }) as RenderForm

/** Edits outlive leaving the view (not a reload: then the saved config is the start). */
let kept: RenderForm | null = null

/**
 * "Render (Ideogram 4 via ComfyUI)": the form from the saved config, the job
 * (in renderStore, so it survives leaving the view) with its progress and
 * live preview, and the rendered images. Rendering is held back while the v15
 * check finds an error, unless asked to anyway.
 */
export function RenderPanel({ json }: { json: string }) {
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const config = useQuery({
    queryKey: ['ideogram-render-config'],
    queryFn: () => api<RenderConfig>('/api/ideogram/render/config'),
  })
  const [form, setFormState] = useState<RenderForm | null>(kept)
  if (!form && config.data) setFormState(formOf(config.data.params))
  useEffect(() => {
    kept = form
  }, [form])
  const set = <K extends keyof RenderForm>(k: K, v: RenderForm[K]) => setFormState((f) => (f ? { ...f, [k]: v } : f))

  const [errors, setErrors] = useState<Record<string, string>>({})
  const onValidity = useCallback(
    (field: string, error: string) => setErrors((e) => (e[field] === error ? e : { ...e, [field]: error })),
    [],
  )
  // A random seed replaces the typed one, so only the other fields hold a render back.
  const invalid = Object.entries(errors).some(([f, e]) => e && !(f === 'seed' && form?.random))

  const lint = useBboxLint(json)
  const lintErrors = lint.data?.warnings.filter((f) => f.level === 'err').length ?? 0

  const run = useRenderRun()
  const jobId = run.jobId
  const job = useJobPoll<RenderJob>(['render-job', jobId], jobId ? `/api/comfy/job/${jobId}` : null, {
    intervalMs: 700,
    terminal: ENDS,
  })
  const data = job.data
  useEffect(() => {
    if (!jobId) return
    if (data && ENDS.includes(data.state)) finishRender(jobId, data.state as RenderOutcome['state'], data.images, data.error)
    else if (job.isGone) {
      toast.error('The render job is gone (was the server restarted?)')
      dropRender(jobId)
    }
  }, [jobId, data, job.isGone])

  // At mutation level: the job is kept even if the view was left before the answer.
  const start = useMutationWithToast(
    (body: { prompt: string; params: Params }) =>
      api<{ job_id: string }>('/api/ideogram/render', { method: 'POST', json: body }),
    { onSuccess: (r) => startRender(r.job_id) },
  )
  const cancel = useMutationWithToast((job: string) => api(`/api/comfy/job/${job}/cancel`, { method: 'POST' }))

  const busy = start.isPending || jobId !== null
  const ready = form !== null && config.data !== undefined && !invalid && !busy

  const render = () => {
    if (!ready) return
    // Drawn here and sent as drawn (the field shows it too), up to the largest exact integer.
    const seed = form.random ? Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER + 1)) : form.seed
    if (form.random) set('seed', seed)
    const params = { ...config.data.params, ...Object.fromEntries(SENT.map((k) => [k, form[k]])) }
    start.mutate({ prompt: json, params: { ...params, seed, lora_name: form.lora_name.trim() } })
  }

  const loras = useQuery({
    queryKey: ['comfy-loras'],
    queryFn: () => api<{ loras: string[] }>('/api/comfy/loras'),
    // ComfyUI down is a hint at the field, at once (no retry, no toast).
    retry: false,
  })

  return (
    <section
      aria-labelledby={id('title')}
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5"
    >
      <div>
        <h2 id={id('title')} className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Palette className="size-5 text-accent-from" />
          Render (Ideogram 4 via ComfyUI)
        </h2>
        <p className="mt-1 max-w-4xl text-sm text-text-dim">
          Renders the current canvas with the built-in Ideogram 4 workflow. The prompt gets an explicit orientation
          cue and exact pixel dimensions — without it the model tends to rotate or squash the layout. Requires a
          ComfyUI server with the Ideogram 4 nodes.
        </p>
      </div>

      {!form ? (
        config.isError ? (
          <p role="alert" className="text-sm text-danger">
            Could not load the render settings: {errorText(config.error)}
          </p>
        ) : (
          <p className="text-sm text-text-dim">Loading the render settings…</p>
        )
      ) : (
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Quality preset" htmlFor={id('preset')}>
            <Select value={form.preset} onValueChange={(v) => set('preset', v)}>
              <SelectTrigger id={id('preset')} className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Megapixels" htmlFor={id('mp')}>
            <NumberInput
              id={id('mp')}
              field="megapixels"
              decimal
              min={0.1}
              max={4}
              step={0.1}
              value={form.megapixels}
              onChange={(v) => set('megapixels', v)}
              onValidity={onValidity}
            />
          </Field>
          <Field
            label="Seed"
            htmlFor={id('seed')}
            aside={
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-dim">
                <input
                  type="checkbox"
                  checked={form.random}
                  onChange={(e) => set('random', e.target.checked)}
                  className="size-3.5 accent-accent-from"
                />
                random
              </label>
            }
          >
            <NumberInput
              id={id('seed')}
              field="seed"
              min={0}
              max={Number.MAX_SAFE_INTEGER}
              value={form.seed}
              onChange={(v) => set('seed', v)}
              onValidity={onValidity}
            />
          </Field>
          <Field label="Scheduler" htmlFor={id('variant')}>
            <Select value={form.variant} onValueChange={(v) => set('variant', v)}>
              <SelectTrigger id={id('variant')} className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VARIANTS.map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Batch" htmlFor={id('batch')}>
            <NumberInput
              id={id('batch')}
              field="batch_size"
              min={1}
              max={16}
              value={form.batch_size}
              onChange={(v) => set('batch_size', v)}
              onValidity={onValidity}
            />
          </Field>
          <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <label className="flex w-fit cursor-pointer items-center gap-1.5 text-xs font-medium text-text-dim">
              <input
                type="checkbox"
                checked={form.lora_enabled}
                onChange={(e) => set('lora_enabled', e.target.checked)}
                className="size-3.5 accent-accent-from"
              />
              LoRA (model-only)
            </label>
            <div className="flex gap-1.5">
              <Input
                aria-label="LoRA file name"
                placeholder="LoRA file name"
                list={id('loras')}
                disabled={!form.lora_enabled}
                value={form.lora_name}
                onChange={(e) => set('lora_name', e.target.value)}
                className="font-mono"
              />
              <datalist id={id('loras')}>
                {loras.data?.loras.map((l) => <option key={l} value={l} />)}
              </datalist>
              <Button
                variant="outline"
                size="icon"
                aria-label="Refresh the LoRA list"
                title="Ask ComfyUI for its LoRAs again"
                onClick={() => loras.refetch()}
              >
                <RefreshCw className={cn(loras.isFetching && 'animate-spin motion-reduce:animate-none')} />
              </Button>
            </div>
            {loras.isError && <p className="text-xs text-text-dim">ComfyUI not reachable — type the LoRA name.</p>}
          </div>
          <Field label="LoRA strength" htmlFor={id('lorastr')}>
            <NumberInput
              id={id('lorastr')}
              field="lora_strength"
              decimal
              min={-10}
              max={10}
              step={0.05}
              value={form.lora_strength}
              onChange={(v) => set('lora_strength', v)}
              onValidity={onValidity}
            />
          </Field>
          <details className="group sm:col-span-2 lg:col-span-4">
            <summary className="w-fit cursor-pointer text-sm text-text-dim select-none hover:text-text">
              Models (advanced)
            </summary>
            <div className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {MODELS.map(([k, label]) => (
                <Field key={k} label={label} htmlFor={id(k)}>
                  <Input id={id(k)} value={form[k]} onChange={(e) => set(k, e.target.value)} className="font-mono" />
                </Field>
              ))}
            </div>
          </details>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="lg" disabled={!ready || lintErrors > 0} onClick={render}>
          <Palette />
          Render canvas
        </Button>
        {jobId && (
          <Button
            size="lg"
            variant="outline"
            disabled={cancel.isPending || (cancel.isSuccess && cancel.variables === jobId)}
            onClick={() => cancel.mutate(jobId)}
          >
            <X />
            {cancel.isSuccess && cancel.variables === jobId ? 'Cancelling…' : 'Cancel'}
          </Button>
        )}
        {lintErrors > 0 && (
          <>
            <p className="text-sm text-danger">
              The v15 check found {lintErrors} error{lintErrors === 1 ? '' : 's'} — fix {lintErrors === 1 ? 'it' : 'them'},
              or render anyway.
            </p>
            <Button size="lg" variant="ghost" disabled={!ready} onClick={render}>
              Render anyway
            </Button>
          </>
        )}
      </div>

      <Status pending={start.isPending} jobId={jobId} job={data} outcome={run.outcome} />

      <Results images={run.results} />
    </section>
  )
}

function Field({ label, htmlFor, aside, className, children }: {
  label: string
  htmlFor: string
  aside?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex h-4 items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-text-dim">{label}</label>
        {aside}
      </div>
      {children}
    </div>
  )
}

/** The job's progress and live preview while it runs; how it ended afterwards. */
function Status({ pending, jobId, job, outcome }: {
  pending: boolean
  jobId: string | null
  job: RenderJob | undefined
  outcome: RenderOutcome | null
}) {
  const counted = !!job && job.progress.max > 0
  // "Step v/m" only repeats the counted bar's own text.
  const current = counted && /^Step \d+\/\d+$/.test(job.current) ? '' : job?.current || 'Starting…'
  // The src (so the request) changes only with a new frame.
  const preview = jobId && job?.has_preview
    ? `/api/comfy/job/${jobId}/preview?${new URLSearchParams({ t: String(job.preview_ts) })}`
    : null

  if (pending || jobId) {
    return (
      <div className="flex flex-col gap-3">
        <JobProgress
          state={jobId ? (job?.state ?? 'pending') : 'pending'}
          processed={counted ? job.progress.value : undefined}
          total={counted ? job.progress.max : undefined}
          current={jobId ? current : 'Queueing the render…'}
        />
        <AnimatePresence initial={false}>
          {preview && (
            <motion.img
              key="preview"
              src={preview}
              alt="Live preview"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="max-h-[28rem] w-fit max-w-full rounded-lg border border-line object-contain"
            />
          )}
        </AnimatePresence>
      </div>
    )
  }
  if (!outcome) return null
  if (outcome.state === 'done') {
    return <p className="text-sm text-success">Done — image saved to the ComfyUI gallery.</p>
  }
  if (outcome.state === 'cancelled') return <p className="text-sm text-text-dim">Cancelled.</p>
  // The job error has a traceback after its first line: that line shows, the whole text is in the title.
  return (
    <p role="alert" title={outcome.error} className="text-sm text-danger">
      Render error: {outcome.error.split('\n')[0] || '?'}
    </p>
  )
}

/** The rendered images, newest first; each opens its full PNG from the ComfyUI gallery. */
function Results({ images }: { images: RenderImage[] }) {
  if (!images.length) return null
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          Results <span className="font-mono text-text-dim tabular-nums">({images.length})</span>
        </h3>
        <Button size="sm" variant="ghost" title="Empties this list (the images stay in the ComfyUI gallery)" onClick={clearResults}>
          Clear results
        </Button>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {/* Only images that arrive animate in (not the list shown on entering the view), one after another. */}
        <AnimatePresence initial={false}>
          {images.map((img, i) => {
            const url = `/api/comfy/gallery/${encodeURIComponent(img.id)}`
            return (
              <motion.li
                key={img.id}
                data-testid="render-result"
                layout
                initial={{ opacity: 0, y: 10, scale: 0.97 }}
                // The stagger is for the entrance only; moving aside for newer images is not delayed.
                animate={{ opacity: 1, y: 0, scale: 1, transition: { ...SPRING, delay: Math.min(i, 8) * 0.06 } }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={SPRING}
                className="overflow-hidden rounded-lg border border-line bg-bg/60"
              >
                <a href={url} target="_blank" rel="noreferrer" title="Open the full PNG" className="block outline-none focus-visible:shadow-glow">
                  <img src={url} alt={`Render, seed ${img.seed}`} loading="lazy" className="aspect-square w-full object-contain" />
                </a>
                <p className="truncate px-2.5 py-1.5 font-mono text-[11px] text-text-dim tabular-nums" title={img.filename}>
                  seed {img.seed}
                </p>
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
    </div>
  )
}
