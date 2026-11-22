import { Download, FolderSearch, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'
import { Link } from 'react-router'
import { DownloadDialog } from '@/components/DownloadDialog'
import { FolderPicker } from '@/components/FolderPicker'
import { StatusBadge } from '@/components/ModelSelect'
import { SpringDialogContent } from '@/components/SpringDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, ApiError } from '@/lib/api'
import { formatBytes, ROLE_LABEL } from '@/lib/format'
import { useMutationWithToast, useSettings, useStoreModels } from '@/lib/queries'
import type { DownloadJob, StoreModel } from '@/lib/types'

/** Row progress of a download; a moving shimmer while the size is unknown. */
function DownloadBar({ job, label }: { job: DownloadJob; label: string }) {
  const known = job.total_bytes > 0
  const pct = known ? Math.min(100, (job.done_bytes / job.total_bytes) * 100) : 100
  return (
    <div className="mt-1.5 flex w-44 flex-col gap-1">
      <div
        role="progressbar"
        aria-label={`Downloading ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.floor(pct) : undefined}
        className="relative h-1.5 overflow-hidden rounded-full bg-white/[0.06]"
      >
        <motion.div
          className="relative h-full overflow-hidden rounded-full bg-linear-to-r from-accent-from to-accent-to"
          style={{ opacity: known ? 1 : 0.45 }}
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 24 }}
        >
          <motion.div
            className="absolute inset-y-0 w-1/3 bg-linear-to-r from-transparent via-white/40 to-transparent"
            initial={{ x: '-100%' }}
            animate={{ x: '300%' }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
          />
        </motion.div>
      </div>
      <span className="font-mono text-[11px] text-text-dim tabular-nums">
        {formatBytes(job.done_bytes)}
        {known && ` / ${formatBytes(job.total_bytes)}`}
      </span>
    </div>
  )
}

export function ModelsPage() {
  const store = useStoreModels()
  const settings = useSettings()
  const locations = settings.data?.model_locations ?? {}
  const modelsDir = store.data?.models_dir ?? settings.data?.models_dir ?? ''

  // Each dialog keeps its model while it animates closed.
  const [downloadId, setDownloadId] = useState('')
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [locating, setLocating] = useState<StoreModel | null>(null)
  const [locateOpen, setLocateOpen] = useState(false)
  const [forgetting, setForgetting] = useState<StoreModel | null>(null)
  const [forgetOpen, setForgetOpen] = useState(false)

  const changed = { invalidate: [['store-models'], ['settings']] }
  const locate = useMutationWithToast(
    (v: { model_id: string; path: string }) => api('/api/store/locate', { method: 'POST', json: v }),
    { success: 'Model located', ...changed },
  )
  const forget = useMutationWithToast(
    (model_id: string) => api('/api/store/forget', { method: 'POST', json: { model_id } }),
    { success: 'Location forgotten', ...changed },
  )
  const cancel = useMutationWithToast(
    (jobId: string) => api(`/api/store/downloads/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
    { success: 'Download cancelled', invalidate: [['store-models']] },
  )

  return (
    <div className="flex flex-col gap-5 px-10 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
        <p className="mt-1 text-sm text-text-dim">
          {modelsDir ? (
            <>Downloads go to <span className="font-mono text-xs text-text">{modelsDir}</span></>
          ) : (
            <>
              No models folder chosen yet.{' '}
              <Link to="/settings" className="text-accent-to underline-offset-4 hover:underline">Choose one in Settings</Link>
              {' '}or pick a folder per download.
            </>
          )}
        </p>
      </div>

      <div className="rounded-xl border border-line bg-surface">
        <Table>
          <TableHeader>
            <TableRow className="border-line hover:bg-transparent">
              <TableHead className="pl-4">Model</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="pr-4"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {store.isPending &&
              Array.from({ length: 4 }, (_, i) => (
                <TableRow key={i} className="border-line">
                  <TableCell colSpan={5} className="px-4"><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))}
            {store.isError && (
              <TableRow className="border-line">
                <TableCell colSpan={5} className="px-4 text-danger">
                  {store.error instanceof ApiError ? store.error.detail : store.error.message}
                </TableCell>
              </TableRow>
            )}
            {store.data?.models.map((m) => {
              const job = m.status === 'downloading' ? m.download : null
              return (
                <TableRow key={m.id} data-model-id={m.id} className="border-line align-top hover:bg-white/[0.02]">
                  <TableCell className="max-w-80 pl-4 whitespace-normal">
                    <div className="font-medium">{m.label}</div>
                    {m.repo_id && (
                      <div className="truncate font-mono text-[11px] text-text-dim">
                        {m.repo_id}{m.filename && ` · ${m.filename}`}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-text-dim">{ROLE_LABEL[m.kind]}</TableCell>
                  <TableCell>
                    <StatusBadge model={m} />
                    {job && <DownloadBar job={job} label={m.label} />}
                  </TableCell>
                  <TableCell className="max-w-72">
                    {m.local_path ? (
                      <div title={m.local_path} className="truncate font-mono text-xs">{m.local_path}</div>
                    ) : (
                      <span className="text-text-dim">—</span>
                    )}
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1.5">
                      {job && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={cancel.isPending}
                          onClick={() => cancel.mutate(job.id)}
                        >
                          <X />
                          Cancel
                        </Button>
                      )}
                      {m.status === 'missing' && m.repo_id && !m.path && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setDownloadId(m.id)
                            setDownloadOpen(true)
                          }}
                        >
                          <Download />
                          Download…
                        </Button>
                      )}
                      {/* Entries with their own path (local scans, custom VLMs) cannot be moved. */}
                      {!m.path && !job && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setLocating(m)
                            setLocateOpen(true)
                          }}
                        >
                          <FolderSearch />
                          Use existing…
                        </Button>
                      )}
                      {locations[m.id] && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setForgetting(m)
                            setForgetOpen(true)
                          }}
                          className="text-text-dim hover:text-danger"
                        >
                          Forget
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {downloadId && <DownloadDialog modelId={downloadId} open={downloadOpen} onOpenChange={setDownloadOpen} />}

      <FolderPicker
        open={locateOpen}
        onOpenChange={setLocateOpen}
        title={`Use existing ${locating?.label ?? 'model'}`}
        initialPath={modelsDir || undefined}
        mode={locating?.kind === 'upscale' ? 'weights' : 'dir'}
        onPick={(path) => locating && locate.mutate({ model_id: locating.id, path })}
      />

      <Dialog open={forgetOpen} onOpenChange={setForgetOpen}>
        <SpringDialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Forget {forgetting?.label}?</DialogTitle>
            <DialogDescription>
              The app stops using <span className="font-mono text-xs">{forgetting && locations[forgetting.id]}</span>.
              Files stay on disk.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mx-0 mb-0 rounded-none border-0 bg-transparent p-0">
            <Button variant="ghost" size="sm" onClick={() => setForgetOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={forget.isPending}
              onClick={() =>
                forgetting && forget.mutate(forgetting.id, { onSuccess: () => setForgetOpen(false) })}
            >
              Forget
            </Button>
          </DialogFooter>
        </SpringDialogContent>
      </Dialog>
    </div>
  )
}
