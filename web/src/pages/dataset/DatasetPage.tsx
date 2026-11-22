import { useMutation } from '@tanstack/react-query'
import { Images } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CropEditorDialog } from '@/components/CropEditorDialog'
import { useSavedForm } from '@/hooks/useAutosave'
import { useCropPlan } from '@/hooks/useCropPlan'
import { api, ApiError } from '@/lib/api'
import { useMutationWithToast } from '@/lib/queries'
import { DATASET_DEFAULTS, toProcessRequest, type DatasetForm } from './datasetForm'
import { ExportPanel } from './ExportPanel'
import { ResultsGrid } from './ResultsGrid'
import { RunPanel } from './RunPanel'
import { flushRun, startRun, useDatasetJob, useRun } from './runStore'
import { SettingsPanel, type NumberField } from './SettingsPanel'
import { CropBar, SourceGrid } from './SourceGrid'
import { SourcePanel, type SourceStatus } from './SourcePanel'

/** POST /api/scan and POST /api/upload. */
interface Source {
  folder: string
  count: number
  files: string[]
}

const images = (n: number) => (n === 1 ? '1 image' : `${n} images`)

export function DatasetPage() {
  const [form, setForm, loaded] = useSavedForm<DatasetForm>('dataset', DATASET_DEFAULTS)
  // The folder whose images are shown: what the server answered, never the typed text.
  const [source, setSource] = useState<Source | null>(null)
  const [status, setStatus] = useState<SourceStatus | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const crops = useCropPlan(source?.folder ?? null)
  const [uploading, setUploading] = useState(false)
  // Number fields whose text is not a valid number (it is not in the form).
  const [invalid, setInvalid] = useState<Partial<Record<NumberField, string>>>({})
  const onValidity = useCallback(
    (field: NumberField, error: string) => setInvalid((v) => ((v[field] ?? '') === error ? v : { ...v, [field]: error })),
    [],
  )
  const settingsRef = useRef<HTMLFieldSetElement>(null)

  // This tab's run (kept in sessionStorage, so leaving the view resumes it).
  const run = useRun()
  const job = useDatasetJob(run?.jobId ?? null)
  useEffect(() => flushRun, [])

  const takeSource = (s: Source) => {
    setSource(s)
    setForm((f) => ({ ...f, folder: s.folder }))
  }

  // Errors go to the status line only (no toast). Only the latest scan reports.
  const scanner = useMutation({
    mutationFn: (folder: string) => api<Source>('/api/scan', { method: 'POST', json: { folder } }),
  })
  const scan = (folder: string) => {
    setStatus({ text: 'Scanning…', tone: 'dim' })
    scanner.mutate(folder, {
      onSuccess: (r) => {
        takeSource(r)
        setStatus({ text: `Found ${images(r.count)} in: ${r.folder}`, tone: r.count ? 'ok' : 'warn' })
      },
      onError: (e) => {
        setSource(null)
        setStatus({ text: e instanceof ApiError ? e.detail : e.message, tone: 'err' })
      },
    })
  }

  // The saved folder is scanned as soon as the form has loaded.
  const entered = useRef(false)
  useEffect(() => {
    if (!loaded || entered.current) return
    entered.current = true
    if (form.folder) scan(form.folder)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on entry
  }, [loaded])

  const start = useMutationWithToast((body: ReturnType<typeof toProcessRequest>) =>
    api<{ job_id: string; total: number }>('/api/process', { method: 'POST', json: body }))

  const canProcess = loaded && !scanner.isPending && !uploading && source !== null && source.count > 0 &&
    crops.loaded && !start.isPending && !job.running

  const process = () => {
    if (!source || !canProcess) return
    // A number field that is not a number is not sent; its error shows next to it.
    if (Object.values(invalid).some(Boolean)) {
      settingsRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }
    const body = toProcessRequest({ ...form, folder: source.folder }, { plan: crops.plan, mode: crops.mode })
    start.mutate(body, { onSuccess: (r) => startRun(r.job_id, body.folder) })
  }

  return (
    <div className="flex flex-col gap-6 px-10 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dataset</h1>
        <p className="mt-1 text-sm text-text-dim">Crop, resize and caption a folder of photos for LoRA training.</p>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(24rem,32rem)_1fr]">
        <fieldset ref={settingsRef} disabled={!loaded} className="flex min-w-0 flex-col gap-6">
          <SourcePanel
            folder={form.folder}
            disabled={!loaded}
            scanning={scanner.isPending}
            uploading={uploading}
            onUploading={setUploading}
            status={status}
            onScan={scan}
            onUploaded={(folder, files) => {
              // A scan answered later must not replace the upload (its callbacks are dropped).
              scanner.reset()
              takeSource({ folder, count: files.length, files })
              setStatus({ text: `Uploaded ${images(files.length)}.`, tone: 'ok' })
            }}
            onEmptyUpload={(folder) => {
              scanner.reset()
              takeSource({ folder, count: 0, files: [] })
              setStatus({ text: 'No supported images in the upload', tone: 'err' })
            }}
          />
          <SettingsPanel
            form={form}
            setForm={setForm}
            cropMode={crops.mode}
            onCropMode={crops.setMode}
            cropReady={crops.loaded}
            // Crops of files no longer in the folder do not count (plans are never pruned).
            planEmpty={!source?.files.some((f) => crops.plan[f])}
            onValidity={onValidity}
          />
          <RunPanel canProcess={canProcess} onProcess={process} job={run ? job : null} />
        </fieldset>

        <section aria-label="Photos" className="flex min-w-0 flex-col gap-4">
          {/* Always mounted, so a running auto-crop outlives a failed scan. */}
          <CropBar
            folder={source?.folder ?? ''}
            files={source?.files ?? []}
            settings={{ mode: form.mode, resolution: form.resolution, step: form.step, square: form.square }}
          />
          {source && source.files.length > 0 ? (
            <SourceGrid folder={source.folder} files={source.files} plan={crops.plan} onOpen={setEditing} />
          ) : (
            <div className="grid min-h-80 place-items-center rounded-xl border border-dashed border-line bg-surface/40 p-8 text-center">
              <div className="flex flex-col items-center gap-2">
                <Images className="size-6 text-accent-to/70" />
                <p className="text-sm">Photos appear here</p>
                <p className="text-xs text-text-dim">Scan a folder or drop images. Click a photo to crop it.</p>
              </div>
            </div>
          )}
        </section>
      </div>

      {run && (
        <>
          {job.data && (
            <ResultsGrid key={`grid-${run.jobId}`} job={job.data} run={run} trigger={form.trigger} prependTrigger={form.prepend_trigger} />
          )}
          <ExportPanel
            key={`export-${run.jobId}`}
            job={job.data}
            run={run}
            trigger={form.trigger}
            prependTrigger={form.prepend_trigger}
            outputFolder={form.output_folder}
            onOutputFolder={(output_folder) => setForm((f) => ({ ...f, output_folder }))}
          />
        </>
      )}

      {source && editing && (
        <CropEditorDialog
          folder={source.folder}
          name={editing}
          files={source.files}
          square={form.square}
          autoCrop={{ mode: form.mode, resolution: form.resolution, step: form.step }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
