import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useMutationWithToast } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { useComfyJobs, useSlotJob, type JobOutcome, type SlotName } from './comfyJobStore'
import { fmtProgress, galleryLink } from './format'
import type { ComfyJob } from './pollJob'

const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

/**
 * The slot's job: while it runs its step with speed and ETA, the bar, the live
 * preview and Cancel; afterwards how it ended. Reads the query JobObservers
 * polls (it also moves the ended job into the slot's outcome). Nothing when
 * the slot has had no job.
 */
export function ComfyJobBox({ slot }: { slot: SlotName }) {
  const { jobId, last } = useComfyJobs()[slot]
  const job = useSlotJob(jobId).data
  if (!jobId && !last) return null
  return (
    <div data-testid="comfy-job" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      {jobId ? <Running jobId={jobId} job={job} /> : last && <Outcome outcome={last} />}
    </div>
  )
}

function Running({ jobId, job }: { jobId: string; job: ComfyJob | undefined }) {
  const cancel = useMutationWithToast((id: string) => api(`/api/comfy/job/${encodeURIComponent(id)}/cancel`, { method: 'POST' }))
  // Cancel is asked: the job keeps showing until it reports `cancelled`.
  const cancelling = cancel.isSuccess && cancel.variables === jobId
  const max = job?.progress.max ?? 0
  const pct = max > 0 ? Math.min(100, (100 * (job?.progress.value ?? 0)) / max) : 0
  // The src (so the request) changes only with a new frame.
  const preview = job?.has_preview
    ? `/api/comfy/job/${encodeURIComponent(jobId)}/preview?${new URLSearchParams({ t: String(job.preview_ts) })}`
    : null

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="min-w-0 font-mono text-xs break-words whitespace-pre-wrap text-text tabular-nums">
          {job ? (job.current || job.state) + fmtProgress(job.progress) : 'Starting…'}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={cancel.isPending || cancelling}
          onClick={() => cancel.mutate(jobId)}
        >
          <X />
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </Button>
      </div>
      <div
        role="progressbar"
        aria-label="Job progress"
        aria-valuemin={0}
        aria-valuemax={max || undefined}
        aria-valuenow={max ? job?.progress.value : undefined}
        className="relative h-2 overflow-hidden rounded-full bg-white/[0.06]"
      >
        <motion.div
          className={cn('h-full rounded-full bg-linear-to-r from-accent-from to-accent-to', !max && 'animate-pulse opacity-40 motion-reduce:animate-none')}
          initial={false}
          animate={{ width: max ? `${pct}%` : '100%' }}
          transition={{ duration: 0.2 }}
        />
      </div>
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
    </>
  )
}

/** A job error: its first line, the whole text (a traceback) behind "Details". */
function ErrorText({ text, prefix, className }: { text: string; prefix: string; className: string }) {
  const [first, ...rest] = text.split('\n')
  return (
    <div role="alert" className={cn('flex flex-col gap-1.5 text-sm', className)}>
      <p className="break-words">{prefix}{first || '?'}</p>
      {rest.some((l) => l.trim()) && (
        <details>
          <summary className="w-fit cursor-pointer text-xs text-text-dim select-none hover:text-text">Details</summary>
          <pre className="mt-1.5 max-h-72 overflow-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[11px] whitespace-pre-wrap text-text-dim">
            {text}
          </pre>
        </details>
      )}
    </div>
  )
}

function Outcome({ outcome }: { outcome: JobOutcome }) {
  if (outcome.state === 'cancelled') return <p className="text-sm text-text-dim">Cancelled.</p>
  if (outcome.state === 'error') return <ErrorText text={outcome.error} prefix="Error: " className="text-danger" />
  const { images } = outcome
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm text-success">Done: {images.length} image(s).</p>
        {images.length > 0 && (
          <Link to={galleryLink(images[0].id)} className="text-sm text-accent-to underline-offset-4 hover:underline">
            Open in gallery
          </Link>
        )}
      </div>
      {/* Done, but e.g. an image could not be fetched from ComfyUI. */}
      {outcome.error && <ErrorText text={outcome.error} prefix="Warning: " className="text-warning" />}
      {images.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
          {images.map((img, i) => (
            <motion.li
              key={img.id}
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ ...SPRING, delay: Math.min(i, 8) * 0.05 }}
              className="overflow-hidden rounded-lg border border-line bg-bg/60"
            >
              <Link to={galleryLink(img.id)} title="Open in the gallery" className="block outline-none focus-visible:shadow-glow">
                <img src={img.url} alt={`Seed ${img.seed}`} loading="lazy" className="aspect-square w-full object-contain" />
              </Link>
            </motion.li>
          ))}
        </ul>
      )}
    </>
  )
}
