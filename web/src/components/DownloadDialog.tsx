import { Download, HardDrive } from 'lucide-react'
import { useEffect, useState } from 'react'
import { FolderPicker, useFsList } from '@/components/FolderPicker'
import { SpringDialogContent } from '@/components/SpringDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { useMutationWithToast, useSettings, useStoreModels } from '@/lib/queries'
import type { DownloadJob } from '@/lib/types'

interface DownloadDialogProps {
  modelId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DownloadDialog({ modelId, open, onOpenChange }: DownloadDialogProps) {
  const settings = useSettings()
  const store = useStoreModels()
  const model = store.data?.models.find((m) => m.id === modelId)
  const modelsDir = settings.data?.models_dir ?? ''

  // The destination starts at the models folder; empty when none is set, so
  // the user has to choose one (never a silent default).
  const [dest, setDest] = useState(modelsDir)
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    if (open) setDest(modelsDir)
  }, [open, modelsDir])

  const target = useFsList(dest, false, open && dest !== '')
  const size = model?.download?.total_bytes || 0

  const start = useMutationWithToast(
    () => api<DownloadJob>('/api/store/download', { method: 'POST', json: { model_id: modelId, dest } }),
    { success: 'Download started', invalidate: [['store-models']] },
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SpringDialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Download {model?.label ?? modelId}</DialogTitle>
          <DialogDescription>
            {model?.repo_id ? <span className="font-mono text-xs">{model.repo_id}</span> : 'Choose where to save it.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-dim">Destination</span>
          <div className="flex items-center gap-2">
            <div
              data-testid="download-dest"
              className="min-h-8 flex-1 truncate rounded-lg border border-line bg-bg/60 px-2.5 py-1.5 font-mono text-xs"
            >
              {dest || <span className="text-text-dim">No folder chosen</span>}
            </div>
            <Button variant="outline" size="sm" onClick={() => setPicking(true)}>Change…</Button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-text-dim tabular-nums">
            {dest !== '' && (
              target.isPending ? (
                <Skeleton className="h-4 w-24" />
              ) : target.isError ? (
                <span className="text-danger">
                  {target.error instanceof ApiError ? target.error.detail : target.error.message}
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <HardDrive className="size-3.5" />
                  {formatBytes(target.data.free_bytes)} free
                </span>
              )
            )}
            {size > 0 && <span>Model size {formatBytes(size)}</span>}
          </div>
        </div>

        <DialogFooter className="mx-0 mb-0 rounded-none border-0 bg-transparent p-0">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            size="sm"
            disabled={!dest || target.isError || start.isPending}
            onClick={() => start.mutate(undefined, { onSuccess: () => onOpenChange(false) })}
            className="bg-linear-to-r from-accent-from to-accent-to text-white"
          >
            <Download />
            Download
          </Button>
        </DialogFooter>

        {/* Inside this dialog's tree, so its clicks are not "outside" this dialog. */}
        <FolderPicker
          open={picking}
          onOpenChange={setPicking}
          title="Download into…"
          initialPath={dest || undefined}
          onPick={setDest}
        />
      </SpringDialogContent>
    </Dialog>
  )
}
