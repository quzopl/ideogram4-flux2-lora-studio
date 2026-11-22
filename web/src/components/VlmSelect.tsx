import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FolderOpen, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { DownloadDialog } from '@/components/DownloadDialog'
import { FolderPicker } from '@/components/FolderPicker'
import { DownloadError, StatusBadge } from '@/components/ModelSelect'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { useMutationWithToast, useStoreModels } from '@/lib/queries'

/** GET /api/models: id -> label; ids are HF repos, custom folders (absolute paths) or `lmstudio:<id>`. */
interface VlmModels {
  models: Record<string, string>
  default: string
}

const KEY = ['vlm-models']

/** A custom model is a folder on disk, as in the classic view. */
const isCustom = (id: string) => id.startsWith('/')

interface VlmSelectProps {
  id?: string
  value: string
  onChange: (id: string) => void
}

/**
 * The captioning model. An empty value becomes the server's default; a saved
 * id that is not listed (say, LM Studio is not running) is kept and shown as
 * unavailable rather than replaced.
 */
export function VlmSelect({ id, value, onChange }: VlmSelectProps) {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: KEY, queryFn: () => api<VlmModels>('/api/models') })
  const store = useStoreModels()
  const [picking, setPicking] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const models = list.data?.models ?? {}
  const fallback = list.data?.default
  useEffect(() => {
    if (value === '' && fallback) onChange(fallback)
  }, [value, fallback, onChange])

  // Store entries (status, download) exist for the Hugging Face repos only.
  const storeEntry = (mid: string) => store.data?.models.find((m) => m.kind === 'vlm' && m.id === mid && m.repo_id)
  const current = storeEntry(value)

  const add = useMutationWithToast((path: string) =>
    api<VlmModels & { added: string }>('/api/models/custom', { method: 'POST', json: { path } }))
  const remove = useMutationWithToast((path: string) =>
    api<VlmModels>('/api/models/custom', { method: 'DELETE', json: { path } }))

  if (list.isPending) return <Skeleton className="h-8 w-72" />

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={id} className="min-w-0 flex-1">
            <SelectValue placeholder="Choose a model" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(models).map(([mid, label]) => {
              const entry = storeEntry(mid)
              return (
                <SelectItem key={mid} value={mid}>
                  <span className="truncate">{label}</span>
                  {entry && <StatusBadge model={entry} />}
                </SelectItem>
              )
            })}
            {value && !(value in models) && (
              <SelectItem value={value}>
                <span className="truncate">{value} (unavailable)</span>
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        {current?.status === 'missing' && (
          <Button type="button" size="sm" variant="outline" onClick={() => setDownloading(true)}>
            <Download />
            Download
          </Button>
        )}
      </div>
      {list.isError && (
        <p className="text-xs text-danger">
          Cannot list models: {list.error instanceof ApiError ? list.error.detail : list.error.message}
        </p>
      )}
      {current?.status === 'missing' && current.last_error && <DownloadError error={current.last_error} />}

      <div className="flex flex-wrap gap-1">
        <Button type="button" variant="ghost" size="sm" className="text-text-dim" onClick={() => setPicking(true)}>
          <FolderOpen />
          Add model from folder…
        </Button>
        {isCustom(value) && value in models && (
          <Button type="button" variant="ghost" size="sm" className="text-text-dim hover:text-danger" onClick={() => setRemoving(true)}>
            <Trash2 />
            Remove custom
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-text-dim"
          disabled={list.isFetching}
          onClick={() => list.refetch()}
        >
          <RefreshCw className={list.isFetching ? 'animate-spin' : undefined} />
          Refresh
        </Button>
      </div>

      <FolderPicker
        open={picking}
        onOpenChange={setPicking}
        title="Choose a model folder"
        requireWritable={false}
        onPick={(path) =>
          add.mutate(path, {
            onSuccess: (r) => {
              qc.setQueryData<VlmModels>(KEY, { models: r.models, default: r.default })
              onChange(r.added)
              toast.success(`Added ${r.models[r.added] ?? r.added}`)
            },
          })}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove the custom model?"
        action="Remove"
        destructive
        onConfirm={() =>
          remove.mutate(value, {
            onSuccess: (r) => {
              qc.setQueryData<VlmModels>(KEY, r)
              onChange(r.default)
            },
          })}
      >
        {models[value] ?? value} leaves the list. The folder on disk is not touched.
      </ConfirmDialog>
      {current && <DownloadDialog modelId={current.id} open={downloading} onOpenChange={setDownloading} />}
    </div>
  )
}
