import { useQuery } from '@tanstack/react-query'
import { Eraser, ImageOff, Scissors, TriangleAlert } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { JobProgress } from '@/components/JobProgress'
import { Button } from '@/components/ui/button'
import { useCropPlan } from '@/hooks/useCropPlan'
import { api, ApiError } from '@/lib/api'
import { useMutationWithToast } from '@/lib/queries'
import type { CropAutoJob, CropPlan } from '@/lib/types'
import { cn } from '@/lib/utils'
import { clearCropAuto, markCropAutoMerged, startCropAuto, useCropAuto } from './cropAutoStore'

const TERMINAL = ['done', 'error']

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Tile({ folder, name, cropped, index, onOpen }: {
  folder: string
  name: string
  cropped: boolean
  index: number
  onOpen: () => void
}) {
  const [broken, setBroken] = useState(false)
  return (
    <motion.li
      data-testid="source-tile"
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      // Cascade the first screenful; later tiles come in together.
      transition={{ type: 'spring', stiffness: 380, damping: 30, delay: Math.min(index, 24) * 0.03 }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={name}
        title={`Crop ${name}`}
        className={cn(
          'group flex w-full flex-col overflow-hidden rounded-xl border bg-surface text-left transition-[border-color,box-shadow] outline-none focus-visible:shadow-glow',
          cropped ? 'border-accent-to/40' : 'border-line hover:border-accent-from/50 hover:shadow-[0_0_24px_rgba(139,92,246,0.15)]',
        )}
      >
        <div className="relative aspect-square overflow-hidden bg-bg">
          {broken ? (
            <div className="grid size-full place-items-center"><ImageOff className="size-6 text-text-dim" /></div>
          ) : (
            <img
              src={`/api/src/thumb?${new URLSearchParams({ folder, name })}`}
              alt=""
              loading="lazy"
              onError={() => setBroken(true)}
              className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
          )}
          {cropped && (
            <span
              title="Has a crop"
              className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-bg/80 text-xs text-accent-to ring-1 ring-accent-to/40 backdrop-blur"
            >
              ✂
            </span>
          )}
        </div>
        <span className="truncate px-2.5 py-1.5 font-mono text-xs text-text-dim">{name}</span>
      </button>
    </motion.li>
  )
}

/** The source images; a tile opens the crop editor, ✂ marks a saved crop. */
export function SourceGrid({ folder, files, plan, onOpen }: {
  folder: string
  files: string[]
  plan: CropPlan
  onOpen: (name: string) => void
}) {
  return (
    <ul key={folder} className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3">
      {files.map((name, i) => (
        <Tile key={name} folder={folder} name={name} index={i} cropped={Boolean(plan[name])} onOpen={() => onOpen(name)} />
      ))}
    </ul>
  )
}

interface CropBarProps {
  folder: string
  files: string[]
  /** Dataset settings sent with the auto-crop job. */
  settings: { mode: string; resolution: number; step: number; square: boolean }
}

/**
 * "Auto-crop all" and "Clear crops" for the source folder. An auto-crop job
 * merges its boxes into the folder it ran on (even if the source changed
 * meanwhile) and switches that folder to manual crops. The job is kept in
 * cropAutoStore, so leaving the view does not lose it.
 */
export function CropBar({ folder, files, settings }: CropBarProps) {
  const crops = useCropPlan(folder)
  const job = useCropAuto()
  const jobCrops = useCropPlan(job?.folder ?? null)
  const [confirmAuto, setConfirmAuto] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const existing = files.filter((f) => crops.plan[f]).length

  // Stored at mutation level: it must happen even if the view was left before the answer.
  const start = useMutationWithToast(
    (f: string) =>
      api<{ job_id: string; total: number }>('/api/crop/auto', { method: 'POST', json: { folder: f, ...settings } }),
    { onSuccess: (r, f) => startCropAuto(r.job_id, f) },
  )
  const run = () => start.mutate(folder)

  // Polling survives transient errors and stops on a final state or a 404.
  const isGone = (e: unknown) => e instanceof ApiError && e.status === 404
  const poll = useQuery({
    queryKey: ['crop-auto', job?.id],
    queryFn: () => api<CropAutoJob>(`/api/crop/auto/${job!.id}`),
    enabled: job !== null,
    refetchInterval: (q) => (isGone(q.state.error) || TERMINAL.includes(q.state.data?.state ?? '') ? false : 800),
  })
  const state = poll.data?.state ?? ''
  const gone = poll.isError && isGone(poll.error)
  const running = start.isPending || (job !== null && !gone && !TERMINAL.includes(state))

  useEffect(() => {
    if (!gone) return
    toast.error('The auto-crop job is gone (was the server restarted?)')
    clearCropAuto()
  }, [gone])

  // Once per job, also across remounts and reloads (the store keeps `merged`).
  const { merge, setMode, loaded: jobLoaded } = jobCrops
  useEffect(() => {
    if (state !== 'done' || !job || job.merged || !jobLoaded) return
    if (!markCropAutoMerged(job.id)) return
    merge(poll.data?.crops ?? {})
    setMode('manual')
  }, [state, job, jobLoaded, poll.data, merge, setMode])

  const error = state === 'error' ? (poll.data?.error ?? '') : ''
  const skipped = poll.data?.skipped ?? []
  const found = Object.keys(poll.data?.crops ?? {}).length

  if (!files.length && !job) return null
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!crops.loaded || running || !files.length}
          onClick={() => (existing > 0 ? setConfirmAuto(true) : run())}
        >
          <Scissors />
          Auto-crop all
        </Button>
        <Button
          size="sm"
          variant="ghost"
          // Crops of files no longer in the folder do not count (plans are never pruned).
          disabled={!crops.loaded || running || existing === 0}
          onClick={() => setConfirmClear(true)}
        >
          <Eraser />
          Clear crops
        </Button>
        <span className="text-xs text-text-dim">
          {crops.error
            ? <span className="text-danger">Cannot load the crop plan: {crops.error}</span>
            : crops.loaded && `${existing} of ${plural(files.length, 'image', 'images')} have a crop.`}
        </span>
      </div>

      {job && (job.folder === folder || running) && (
        <div className="flex flex-col gap-2">
          {running || error ? (
            // The backend appends a traceback: the first line shows, the rest is in the title.
            <div title={error || undefined}>
              <JobProgress
                state={state || 'pending'}
                processed={poll.data?.processed ?? 0}
                total={poll.data?.total ?? 0}
                current={poll.data?.current}
                error={error ? error.split('\n')[0] : undefined}
              />
            </div>
          ) : (
            <p className="text-xs text-success">
              Auto-crop done: {plural(found, 'crop', 'crops')} computed
              {job.folder !== folder && ` for ${job.folder}`}.
            </p>
          )}
          {skipped.length > 0 && (
            <ul aria-label="Skipped files" className="flex flex-col gap-0.5 text-xs text-warning">
              {skipped.map((s) => (
                <li key={s} className="flex items-start gap-1.5">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  <span className="break-all">{s}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmAuto}
        onOpenChange={setConfirmAuto}
        title="Auto-crop all photos?"
        action="Auto-crop"
        onConfirm={run}
      >
        Auto-crop recomputes a crop for every photo. Photos where nothing is detected keep their current crop ({existing} existing).
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear all crops?"
        action="Clear"
        destructive
        onConfirm={crops.clear}
      >
        Every photo of this folder loses its crop. The crop source stays as it is.
      </ConfirmDialog>
    </div>
  )
}
