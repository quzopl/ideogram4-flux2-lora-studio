import { FileArchive, FolderOpen, FolderOutput } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { FolderPicker } from '@/components/FolderPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiError, api, detailOf } from '@/lib/api'
import { useMutationWithToast } from '@/lib/queries'
import type { DatasetJob } from '@/lib/types'
import type { Run } from './runStore'

const images = (n: number) => (n === 1 ? '1 image' : `${n} images`)
const pairs = (n: number) => (n === 1 ? '1 pair' : `${n} pairs`)

/** The /api/export and /api/zip body (without `output_folder`). */
interface ExportBody {
  job_id: string
  trigger: string
  prepend_trigger: boolean
  /** Only edited captions; the backend uses the model's caption for the rest. */
  captions: Record<string, string>
  exclude_idx: number[]
}

/** POST /api/zip: a blob named by Content-Disposition, or JSON `detail` on error. */
async function downloadZip(body: ExportBody): Promise<string> {
  const res = await fetch('/api/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const fallback = `${res.status} ${res.statusText}`.trim()
    let detail = fallback
    try {
      detail = detailOf(await res.json(), fallback)
    } catch {
      // Not JSON: keep the status line.
    }
    throw new ApiError(res.status, detail)
  }
  const blob = await res.blob()
  const name = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'dataset.zip'
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  // Revoked later: some browsers read the URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return name
}

interface ExportPanelProps {
  job: DatasetJob | undefined
  run: Run
  trigger: string
  prependTrigger: boolean
  outputFolder: string
  onOutputFolder: (folder: string) => void
}

/** Saves the reviewed dataset to a folder or downloads it as a .zip, once the job is done. */
export function ExportPanel({ job, run, trigger, prependTrigger, outputFolder, onOutputFolder }: ExportPanelProps) {
  const folderId = useId()
  const [picking, setPicking] = useState(false)
  const done = job?.state === 'done'

  // Failed files (no out_name) are never exported.
  const ok = (job?.results ?? []).filter((r) => r.out_name !== '')
  const removed = ok.filter((r) => run.deleted.includes(r.idx)).length
  const count = ok.length - removed

  const body = (): ExportBody => ({
    job_id: run.jobId,
    trigger: trigger.trim(),
    prepend_trigger: prependTrigger,
    captions: Object.fromEntries(Object.entries(run.edits)),
    exclude_idx: [...run.deleted],
  })

  const save = useMutationWithToast((output_folder: string) =>
    api<{ output_folder: string; written: number }>('/api/export', { method: 'POST', json: { ...body(), output_folder } }))
  const zip = useMutationWithToast(downloadZip)
  const busy = save.isPending || zip.isPending
  const folder = outputFolder.trim()

  return (
    <section aria-label="Export" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Export</h2>
        {done && (
          <span className="text-xs text-text-dim">
            To export: {images(count)}{removed > 0 && ` (${removed} removed)`}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={folderId} className="text-xs font-medium text-text-dim">
          Output folder (created if it doesn't exist)
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={folderId}
            aria-label="Output folder"
            placeholder="/home/user/dataset/my-person"
            value={outputFolder}
            disabled={!done}
            onChange={(e) => onOutputFolder(e.target.value)}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Choose output folder…"
            title="Choose output folder…"
            disabled={!done}
            onClick={() => setPicking(true)}
          >
            <FolderOpen />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!done || busy || !folder || count === 0}
          onClick={() =>
            save.mutate(folder, {
              // The backend answers 200 even when nothing was written.
              onSuccess: (r) =>
                r.written > 0
                  ? toast.success(`Saved ${pairs(r.written)} to ${r.output_folder}`)
                  : toast.warning(`Nothing was written to ${r.output_folder}`),
            })}
          className="bg-linear-to-r from-accent-from to-accent-to text-white"
        >
          <FolderOutput />
          Save to folder
        </Button>
        <span className="text-xs text-text-dim">or</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!done || busy || count === 0}
          onClick={() => zip.mutate(body(), { onSuccess: (name) => toast.success(`Downloaded ${name}`) })}
        >
          <FileArchive />
          Download .zip
        </Button>
      </div>

      <FolderPicker
        open={picking}
        onOpenChange={setPicking}
        title="Export to…"
        onPick={onOutputFolder}
      />
    </section>
  )
}
