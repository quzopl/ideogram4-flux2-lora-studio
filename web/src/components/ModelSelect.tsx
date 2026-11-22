import { Download, X } from 'lucide-react'
import { useState } from 'react'
import { DownloadDialog } from '@/components/DownloadDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useMutationWithToast, useStoreModels } from '@/lib/queries'
import type { Role, StoreModel } from '@/lib/types'
import { cn } from '@/lib/utils'

/** "ready", "missing" or "downloading NN%" (no percentage while the size is unknown). */
export function statusText(m: StoreModel): string {
  if (m.status !== 'downloading') return m.status
  const job = m.download
  if (!job || job.total_bytes <= 0) return 'downloading'
  return `downloading ${Math.min(100, Math.floor((job.done_bytes / job.total_bytes) * 100))}%`
}

export function StatusBadge({ model }: { model: StoreModel }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-mono tabular-nums',
        model.status === 'ready' && 'border-success/40 text-success',
        model.status === 'missing' && 'border-warning/40 text-warning',
        model.status === 'downloading' && 'border-accent-to/40 text-accent-to',
      )}
    >
      {statusText(model)}
    </Badge>
  )
}

/** Why the latest download of a still-missing model failed. */
export function DownloadError({ error, className }: { error: string; className?: string }) {
  return (
    <p title={error} className={cn('line-clamp-2 max-w-56 text-xs whitespace-normal text-danger', className)}>
      Download failed: {error}
    </p>
  )
}

interface ModelSelectProps {
  kind: Role
  value: string
  onChange: (id: string) => void
  id?: string
  /** The trigger's accessible name. */
  label?: string
  /** Adds a first option meaning "no model" (value ""), with this label. */
  noneLabel?: string
}

// Radix Select items cannot have the value "".
const NONE = '__none__'

export function ModelSelect({ kind, value, onChange, id, label = 'Model', noneLabel }: ModelSelectProps) {
  const store = useStoreModels()
  const [downloading, setDownloading] = useState(false)
  const models = store.data?.models.filter((m) => m.kind === kind) ?? []
  const current = models.find((m) => m.id === value)

  const cancel = useMutationWithToast(
    (jobId: string) => api(`/api/store/downloads/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
    { success: 'Download cancelled', invalidate: [['store-models']] },
  )

  if (store.isPending) return <Skeleton className="h-8 w-72" />

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={noneLabel !== undefined && value === '' ? NONE : value}
        onValueChange={(v) => onChange(v === NONE ? '' : v)}
      >
        <SelectTrigger id={id} aria-label={label} className="min-w-72">
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent>
          {noneLabel !== undefined && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
          {models.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              <span className="truncate">{m.label}</span>
              <StatusBadge model={m} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {current?.status === 'missing' && (
        <Button size="sm" variant="outline" onClick={() => setDownloading(true)}>
          <Download />
          Download
        </Button>
      )}
      {current?.status === 'missing' && current.last_error && <DownloadError error={current.last_error} />}
      {current?.status === 'downloading' && current.download && (
        <Button
          size="sm"
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(current.download!.id)}
        >
          <X />
          Cancel
        </Button>
      )}

      {/* Outside the Select: its content unmounts when it closes. */}
      {current && (
        <DownloadDialog modelId={current.id} open={downloading} onOpenChange={setDownloading} />
      )}
    </div>
  )
}
