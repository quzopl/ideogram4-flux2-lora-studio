import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileArchive, FolderOpen, FolderOutput, ImageOff, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { BeforeAfter } from '@/components/BeforeAfter'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { DropZone } from '@/components/DropZone'
import { FolderPicker } from '@/components/FolderPicker'
import { GpuSelect } from '@/components/GpuSelect'
import { JobProgress } from '@/components/JobProgress'
import { ModelSelect } from '@/components/ModelSelect'
import { PresetBar } from '@/components/PresetBar'
import { SpringDialogContent } from '@/components/SpringDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { useSavedForm } from '@/hooks/useAutosave'
import { api, ApiError } from '@/lib/api'
import { useMutationWithToast, useStoreModels } from '@/lib/queries'
import { cn } from '@/lib/utils'

type Scale = 'x2' | 'x3' | 'x4' | 'custom' | 'long_side' | 'native'

/** Saved as forms.upscale. */
interface UpscaleForm {
  folder: string
  model_id: string
  scale: Scale
  factor: number
  long_side: number
  fmt: 'png' | 'jpg'
  jpg_quality: number
  device: string
}

const DEFAULTS: UpscaleForm = {
  folder: '',
  model_id: '',
  scale: 'x2',
  factor: 2,
  long_side: 2048,
  fmt: 'png',
  jpg_quality: 95,
  device: '',
}

/** One row of GET /api/upscale/job/{id} `results`. */
interface UpscaleResult {
  idx: number
  src_name: string
  out_name: string
  width: number
  height: number
  error: string
  passes: number
  device: string
}

interface UpscaleJob {
  state: string
  total: number
  processed: number
  current: string
  error: string
  results: UpscaleResult[]
}

/** This view's job and the folder it read (for the "before" images). */
interface Run {
  id: string
  folder: string
}

const RUN_KEY = 'flux.upscale.run'

function loadRun(): Run | null {
  try {
    const r = JSON.parse(sessionStorage.getItem(RUN_KEY) ?? 'null') as Run | null
    return r && typeof r.id === 'string' && typeof r.folder === 'string' ? r : null
  } catch {
    return null
  }
}

const SCALES: [Scale, string][] = [
  ['x2', 'x2'], ['x3', 'x3'], ['x4', 'x4'], ['custom', 'Custom'], ['long_side', 'Long side'], ['native', 'Native'],
]
const FIXED_FACTOR: Partial<Record<Scale, number>> = { x2: 2, x3: 3, x4: 4 }
const TERMINAL = ['done', 'error', 'cancelled']

/** The problem with the scale settings, or "" when they are fine. */
function scaleError(f: UpscaleForm): string {
  if (f.scale === 'custom' && !(Number.isFinite(f.factor) && f.factor >= 1.5 && f.factor <= 8)) return 'Between 1.5 and 8'
  if (f.scale === 'long_side' && !(Number.isInteger(f.long_side) && f.long_side >= 64 && f.long_side <= 16384)) {
    return 'Between 64 and 16384 px'
  }
  return ''
}

/**
 * The run's device: "", "cpu" or a UUID. A form saved with "auto" (which the
 * run endpoint rejects) reads as "" (Role default).
 */
const deviceOf = (f: UpscaleForm) => (f.device === 'auto' ? '' : f.device)

/** The form as a POST /api/upscale/run body (factor must be valid even when unused). */
function runBody(f: UpscaleForm) {
  const factor = f.scale === 'custom' ? f.factor : FIXED_FACTOR[f.scale]
  return {
    folder: f.folder.trim(),
    model_id: f.model_id,
    mode: factor !== undefined ? 'factor' : f.scale,
    factor: factor ?? 2,
    long_side: Number.isInteger(f.long_side) ? f.long_side : 2048,
    fmt: f.fmt,
    jpg_quality: f.jpg_quality,
    device: deviceOf(f),
  }
}

/** Buttons with one active; the active pill slides between them (`layoutId`). */
function Segmented<T extends string>({ options, value, onChange, layoutId, label }: {
  options: [T, string][]
  value: T
  onChange: (v: T) => void
  layoutId: string
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1 rounded-xl border border-line bg-bg/60 p-1">
      {options.map(([v, text]) => {
        const active = v === value
        return (
          <button
            key={v}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(v)}
            className={cn(
              'relative flex-1 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:shadow-glow disabled:opacity-50',
              active ? 'text-white' : 'text-text-dim hover:text-text',
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                className="absolute inset-0 rounded-lg bg-linear-to-r from-accent-from to-accent-to shadow-[0_0_16px_rgba(139,92,246,0.35)]"
              />
            )}
            <span className="relative">{text}</span>
          </button>
        )
      })}
    </div>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-xs font-medium tracking-wide text-text-dim uppercase">{label}</label>
      {children}
    </div>
  )
}

interface Registry {
  models: { id: string; repo_id?: string; filename?: string; path?: string }[]
}

/**
 * Registers an upscale model: a Hugging Face file (POST /api/upscale/models/custom)
 * or a local weights file, whose folder becomes the scanned local folder
 * (POST /api/upscale/models/scan, as in the classic view).
 */
function AddModelDialog({ open, onOpenChange, onAdded }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (id: string) => void
}) {
  const qc = useQueryClient()
  const [repo, setRepo] = useState('')
  const [file, setFile] = useState('')
  const [picking, setPicking] = useState(false)
  const added = (id: string | undefined) => {
    qc.invalidateQueries({ queryKey: ['store-models'] })
    if (id) onAdded(id)
    toast.success('Model added')
  }

  const addHf = useMutationWithToast((v: { repo_id: string; filename: string }) =>
    api<Registry>('/api/upscale/models/custom', { method: 'POST', json: v }))
  const addLocal = useMutationWithToast((folder: string) =>
    api<Registry>('/api/upscale/models/scan', { method: 'POST', json: { folder } }))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const v = { repo_id: repo.trim(), filename: file.trim() }
    addHf.mutate(v, {
      onSuccess: (r) => {
        added(r.models.find((m) => m.repo_id === v.repo_id && m.filename === v.filename)?.id)
        setRepo('')
        setFile('')
        onOpenChange(false)
      },
    })
  }

  const pickLocal = (path: string) => {
    const folder = path.slice(0, path.lastIndexOf('/')) || '/'
    addLocal.mutate(folder, { onSuccess: (r) => added(r.models.find((m) => m.path === path)?.id) })
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <SpringDialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add an upscale model</DialogTitle>
            <DialogDescription>A weights file from Hugging Face, or one already on this machine.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="Repository" htmlFor="add-repo">
              <Input id="add-repo" placeholder="user/repo" value={repo} onChange={(e) => setRepo(e.target.value)} className="font-mono" />
            </Field>
            <Field label="File name" htmlFor="add-file">
              <Input id="add-file" placeholder="4x-Model.pth" value={file} onChange={(e) => setFile(e.target.value)} className="font-mono" />
            </Field>
            <Button
              type="submit"
              size="sm"
              disabled={!repo.trim() || !file.trim() || addHf.isPending}
              className="self-end bg-linear-to-r from-accent-from to-accent-to text-white"
            >
              Add
            </Button>
          </form>
          <div className="flex items-center gap-3 text-xs text-text-dim">
            <span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onOpenChange(false)
                setPicking(true)
              }}
            >
              <FolderOpen />
              Local weights file…
            </Button>
            <p className="text-xs text-text-dim">
              The app scans that file's folder for weights. This replaces the folder scanned before.
            </p>
          </div>
        </SpringDialogContent>
      </Dialog>
      <FolderPicker open={picking} onOpenChange={setPicking} title="Choose a weights file" mode="weights" onPick={pickLocal} />
    </>
  )
}

/** "RTX 4070 Ti · 12 GB" -> "RTX 4070 Ti". */
const shortDevice = (label: string) => label.split(' · ')[0]

const grid = { show: { transition: { staggerChildren: 0.04 } } }
const card = {
  hidden: { opacity: 0, y: 10, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring' as const, stiffness: 380, damping: 30 } },
}

function ResultCard({ jobId, r, onOpen }: { jobId: string; r: UpscaleResult; onOpen: () => void }) {
  const failed = Boolean(r.error)
  return (
    <motion.li variants={card} data-testid="result-card">
      <button
        type="button"
        disabled={failed}
        onClick={onOpen}
        title={failed ? r.error : `Compare ${r.src_name}`}
        className={cn(
          'group flex w-full flex-col overflow-hidden rounded-xl border bg-surface text-left transition-[border-color,box-shadow] outline-none focus-visible:shadow-glow',
          failed ? 'border-danger/40' : 'border-line hover:border-accent-from/50 hover:shadow-[0_0_24px_rgba(139,92,246,0.15)]',
        )}
      >
        <div className="relative aspect-4/3 overflow-hidden bg-bg">
          {failed ? (
            <div className="grid size-full place-items-center"><ImageOff className="size-6 text-danger/70" /></div>
          ) : (
            <img
              src={`/api/upscale/thumb/${jobId}/${r.idx}`}
              alt={r.src_name}
              loading="lazy"
              className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
          )}
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2">
          <span className="truncate text-sm">{r.src_name}</span>
          {failed ? (
            <span className="line-clamp-2 text-xs text-danger">{r.error}</span>
          ) : (
            <>
              <span className="font-mono text-xs text-text tabular-nums">{r.width}×{r.height}</span>
              <span className="truncate text-xs text-text-dim" title={r.device}>
                {r.passes} {r.passes === 1 ? 'pass' : 'passes'} · {shortDevice(r.device)}
              </span>
            </>
          )}
        </div>
      </button>
    </motion.li>
  )
}

export function UpscalePage() {
  const [form, setForm, loaded] = useSavedForm<UpscaleForm>('upscale', DEFAULTS)
  const set = <K extends keyof UpscaleForm>(k: K, v: UpscaleForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const folderId = useId()

  const [sourcePicker, setSourcePicker] = useState(false)
  const [exportPicker, setExportPicker] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(false)
  // Kept for the session, so leaving the view and coming back resumes it.
  const [run, setRunState] = useState<Run | null>(loadRun)
  const setRun = (r: Run) => {
    setRunState(r)
    try {
      sessionStorage.setItem(RUN_KEY, JSON.stringify(r))
    } catch {
      // Storage blocked: the job is still shown until the view unmounts.
    }
  }
  // The previewed result stays set while the dialog animates closed.
  const [preview, setPreview] = useState<UpscaleResult | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  const folder = form.folder.trim()
  const scan = useQuery({
    queryKey: ['scan', folder],
    queryFn: () => api<{ count: number }>('/api/scan', { method: 'POST', json: { folder } }),
    enabled: folder !== '',
    retry: false,
  })

  // Polling stops only when the job is over or unknown (404, e.g. after a server
  // restart); a transient error keeps polling and the last data stays shown.
  const isGone = (e: unknown) => e instanceof ApiError && e.status === 404
  const job = useQuery({
    queryKey: ['upscale-job', run?.id],
    queryFn: () => api<UpscaleJob>(`/api/upscale/job/${run!.id}`),
    enabled: run !== null,
    refetchInterval: (q) => (isGone(q.state.error) || TERMINAL.includes(q.state.data?.state ?? '') ? false : 700),
  })
  const gone = job.isError && isGone(job.error)
  const running = run !== null && !gone && !TERMINAL.includes(job.data?.state ?? '')
  useEffect(() => {
    if (!gone) return
    try {
      sessionStorage.removeItem(RUN_KEY)
    } catch {
      // Storage blocked: nothing was kept.
    }
  }, [gone])

  const start = useMutationWithToast((body: ReturnType<typeof runBody>) =>
    api<{ job_id: string; total: number }>('/api/upscale/run', { method: 'POST', json: body }))
  const storeModels = useStoreModels()
  const customModel = storeModels.data?.models.find((m) => m.id === form.model_id && m.source === 'custom')
  const removeModel = useMutationWithToast(
    (v: { repo_id: string; filename: string }) => api('/api/upscale/models/custom', { method: 'DELETE', json: v }),
    { success: 'Model removed', invalidate: [['store-models']], onSuccess: () => set('model_id', '') },
  )
  const exportTo = useMutationWithToast((output_folder: string) =>
    api<{ written: number; folder: string }>('/api/upscale/export', {
      method: 'POST',
      json: { job_id: run?.id, output_folder },
    }))

  const problem = scaleError(form)
  const canRun = loaded && folder !== '' && form.model_id !== '' && !problem && !running && !start.isPending

  const upscale = () => {
    const body = runBody(form)
    start.mutate(body, { onSuccess: (r) => setRun({ id: r.job_id, folder: body.folder }) })
  }

  const results = [...(job.data?.results ?? [])].sort((a, b) => a.idx - b.idx)
  const done = job.data?.state === 'done'
  const okCount = results.filter((r) => !r.error).length

  return (
    <div className="flex flex-col gap-6 px-10 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Upscale</h1>
        <p className="mt-1 text-sm text-text-dim">Enlarge a folder of photos with an upscale model, then compare and export.</p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(20rem,26rem)_1fr]">
        {/* Form */}
        <fieldset disabled={!loaded} className="flex min-w-0 flex-col gap-5 rounded-xl border border-line bg-surface p-5">
          <Field label="Source" htmlFor={folderId}>
            <DropZone disabled={!loaded} onUploaded={(f) => set('folder', f)} />
            <div className="flex items-center gap-2">
              <Input
                id={folderId}
                aria-label="Source folder"
                placeholder="/path/to/photos"
                value={form.folder}
                onChange={(e) => set('folder', e.target.value)}
                className="font-mono text-xs"
              />
              <Button type="button" variant="outline" size="sm" onClick={() => setSourcePicker(true)}>
                <FolderOpen />
                Choose folder…
              </Button>
            </div>
            {folder && (
              <p className="text-xs">
                {scan.isPending ? (
                  <span className="text-text-dim">Looking…</span>
                ) : scan.isError ? (
                  <span className="text-warning">{scan.error instanceof ApiError ? scan.error.detail : scan.error.message}</span>
                ) : (
                  <span className={scan.data.count ? 'text-success' : 'text-warning'}>
                    {scan.data.count === 1 ? '1 image' : `${scan.data.count} images`}
                  </span>
                )}
              </p>
            )}
          </Field>

          <Field label="Model">
            <ModelSelect kind="upscale" value={form.model_id} onChange={(id) => set('model_id', id)} />
            <Button type="button" variant="ghost" size="sm" className="self-start text-text-dim" onClick={() => setAdding(true)}>
              <Plus />
              Add custom model…
            </Button>
            {customModel && (
              <Button type="button" variant="ghost" size="sm" className="self-start text-text-dim" onClick={() => setRemoving(true)}>
                <Trash2 />
                Remove custom model
              </Button>
            )}
          </Field>

          <Field label="Scale">
            <Segmented label="Scale" layoutId="upscale-scale" options={SCALES} value={form.scale} onChange={(v) => set('scale', v)} />
            {form.scale === 'custom' && (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  aria-label="Factor"
                  min={1.5}
                  max={8}
                  step={0.1}
                  value={Number.isFinite(form.factor) ? form.factor : ''}
                  onChange={(e) => set('factor', e.target.valueAsNumber)}
                  aria-invalid={Boolean(problem) || undefined}
                  className="w-28 font-mono"
                />
                <span className="text-sm text-text-dim">×</span>
              </div>
            )}
            {form.scale === 'long_side' && (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  aria-label="Long side"
                  min={64}
                  max={16384}
                  step={1}
                  value={Number.isFinite(form.long_side) ? form.long_side : ''}
                  onChange={(e) => set('long_side', e.target.valueAsNumber)}
                  aria-invalid={Boolean(problem) || undefined}
                  className="w-28 font-mono"
                />
                <span className="text-sm text-text-dim">px</span>
              </div>
            )}
            {form.scale === 'native' && <p className="text-xs text-text-dim">One pass at the model's own scale.</p>}
            {problem && <p className="text-xs text-danger">{problem}</p>}
          </Field>

          <Field label="Device">
            <GpuSelect includeDefault hideAuto value={deviceOf(form)} onChange={(v) => set('device', v)} />
          </Field>

          <Field label="Format">
            <Segmented
              label="Format"
              layoutId="upscale-fmt"
              options={[['png', 'PNG'], ['jpg', 'JPG']]}
              value={form.fmt}
              onChange={(v) => set('fmt', v)}
            />
            {form.fmt === 'jpg' && (
              <div className="flex items-center gap-3">
                <Slider
                  aria-label="JPG quality"
                  min={50}
                  max={100}
                  step={1}
                  value={[form.jpg_quality]}
                  onValueChange={([q]) => set('jpg_quality', q)}
                />
                <span className="w-8 text-right font-mono text-xs tabular-nums">{form.jpg_quality}</span>
              </div>
            )}
          </Field>

          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <PresetBar view="upscale" current={form} onLoad={(v) => setForm((f) => ({ ...f, ...v }))} />
            <Button
              size="lg"
              disabled={!canRun}
              onClick={upscale}
              className="bg-linear-to-r from-accent-from to-accent-to text-white shadow-[0_0_24px_rgba(139,92,246,0.25)] transition-shadow hover:shadow-[0_0_32px_rgba(34,211,238,0.3)]"
            >
              <Wand2 />
              Upscale
            </Button>
          </div>
        </fieldset>

        {/* Results */}
        <section aria-label="Results" className="flex min-w-0 flex-col gap-4">
          {run === null ? (
            <div className="grid min-h-80 place-items-center rounded-xl border border-dashed border-line bg-surface/40 p-8 text-center">
              <div className="flex flex-col items-center gap-2">
                <Sparkles className="size-6 text-accent-to/70" />
                <p className="text-sm">Results appear here</p>
                <p className="text-xs text-text-dim">Pick a source and a model, then press Upscale.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-line bg-surface p-4">
                {job.isError && (gone || !job.data) ? (
                  <JobProgress
                    state="error"
                    processed={0}
                    total={0}
                    error={job.error instanceof ApiError ? job.error.detail : job.error.message}
                  />
                ) : (
                  <JobProgress
                    state={job.data?.state ?? 'pending'}
                    processed={job.data?.processed ?? 0}
                    total={job.data?.total ?? 0}
                    current={job.data?.current}
                    // The backend appends a traceback; the first line is the message.
                    error={job.data?.error.split('\n')[0]}
                  />
                )}
              </div>

              {results.length > 0 && (
                <motion.ul
                  key={run.id}
                  variants={grid}
                  initial="hidden"
                  animate="show"
                  className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3"
                >
                  {results.map((r) => (
                    <ResultCard
                      key={r.idx}
                      jobId={run.id}
                      r={r}
                      onOpen={() => {
                        setPreview(r)
                        setPreviewOpen(true)
                      }}
                    />
                  ))}
                </motion.ul>
              )}

              {done && okCount > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" disabled={exportTo.isPending} onClick={() => setExportPicker(true)}>
                    <FolderOutput />
                    Export to folder…
                  </Button>
                  <Button asChild variant="outline" size="sm">
                    <a href={`/api/upscale/zip/${run.id}`} download>
                      <FileArchive />
                      Download .zip
                    </a>
                  </Button>
                  <span className="text-xs text-text-dim">{okCount === 1 ? '1 image' : `${okCount} images`}</span>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <FolderPicker
        open={sourcePicker}
        onOpenChange={setSourcePicker}
        title="Choose the source folder"
        initialPath={folder || undefined}
        requireWritable={false}
        onPick={(p) => set('folder', p)}
      />
      <FolderPicker
        open={exportPicker}
        onOpenChange={setExportPicker}
        title="Export to…"
        onPick={(p) =>
          exportTo.mutate(p, {
            onSuccess: (r) => toast.success(`Exported ${r.written === 1 ? '1 image' : `${r.written} images`} to ${r.folder}`),
          })}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove custom model?"
        action="Remove"
        destructive
        onConfirm={() => customModel && removeModel.mutate({ repo_id: customModel.repo_id, filename: customModel.filename })}
      >
        Remove “{customModel?.label}” from the list? The downloaded file stays on disk.
      </ConfirmDialog>
      <AddModelDialog open={adding} onOpenChange={setAdding} onAdded={(id) => set('model_id', id)} />

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <SpringDialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle className="truncate">{preview?.src_name}</DialogTitle>
            <DialogDescription className="font-mono text-xs tabular-nums">
              {preview && `${preview.width}×${preview.height} · ${preview.passes} ${preview.passes === 1 ? 'pass' : 'passes'} · ${preview.device}`}
            </DialogDescription>
          </DialogHeader>
          {preview && run && (
            <BeforeAfter
              alt={preview.src_name}
              before={`/api/src/image?${new URLSearchParams({ folder: run.folder, name: preview.src_name })}`}
              after={`/api/upscale/image/${run.id}/${preview.idx}`}
            />
          )}
        </SpringDialogContent>
      </Dialog>
    </div>
  )
}
