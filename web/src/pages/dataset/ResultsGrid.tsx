import { ImageOff, TriangleAlert, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { DatasetJob, DatasetResult } from '@/lib/types'
import { getRun, setEdit, toggleDeleted, type Run } from './runStore'

const JSON_FORMATS = ['ideogram', 'aitoolkit']

/** Restores a removed image, unless a new run has started since. */
function undoRemove(jobId: string, idx: number) {
  const run = getRun()
  if (run?.jobId === jobId && run.deleted.includes(idx)) toggleDeleted(idx)
}

function ResultCard({ jobId, r, text, trigger, delay }: {
  jobId: string
  r: DatasetResult
  /** The caption shown: the user's edit or the model's. */
  text: string
  /** The trigger preview line, or "" for none. */
  trigger: string
  delay: number
}) {
  const failed = r.out_name === ''
  return (
    <motion.li
      layout
      data-testid="result-card"
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 380, damping: 30, delay } }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
      className={
        failed
          ? 'flex flex-col overflow-hidden rounded-xl border border-danger/40 bg-danger/[0.04]'
          : 'flex flex-col overflow-hidden rounded-xl border border-line bg-surface'
      }
    >
      <div className="relative aspect-4/3 overflow-hidden bg-bg">
        {failed ? (
          <div className="grid size-full place-items-center"><ImageOff className="size-6 text-danger/70" /></div>
        ) : (
          <>
            <img src={`/api/thumb/${jobId}/${r.idx}`} alt="" loading="lazy" className="size-full object-cover" />
            <button
              type="button"
              aria-label={`Remove ${r.out_name}`}
              title="Remove this photo from the dataset"
              onClick={() => {
                toggleDeleted(r.idx)
                toast(`Removed ${r.out_name}`, { action: { label: 'Undo', onClick: () => undoRemove(jobId, r.idx) } })
              }}
              className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-full bg-bg/80 text-text-dim ring-1 ring-line backdrop-blur transition-colors outline-none hover:text-danger focus-visible:shadow-glow"
            >
              <X className="size-4" />
            </button>
          </>
        )}
      </div>
      <div className="flex flex-col gap-1.5 p-3">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="truncate font-mono">{r.out_name || r.src_name}</span>
          {!failed && (
            <span className="shrink-0 font-mono text-text-dim tabular-nums">
              {r.width}×{r.height}
              {r.upscaled && <span title="Upscaled with the selected model"> ✨</span>}
            </span>
          )}
        </div>
        {failed ? (
          <p className="line-clamp-3 text-xs break-words text-danger" title={r.caption}>{r.caption}</p>
        ) : (
          <>
            {trigger && <p data-testid="trigger-preview" className="font-mono text-xs text-accent-to">{trigger}</p>}
            <textarea
              aria-label={`Caption of ${r.out_name}`}
              placeholder="(no caption)"
              value={text}
              onChange={(e) => setEdit(r.idx, e.target.value)}
              rows={5}
              className="min-h-24 w-full resize-y rounded-lg border border-line bg-bg/60 px-2.5 py-2 text-xs leading-relaxed outline-none placeholder:text-text-dim focus-visible:border-accent-from/60 focus-visible:shadow-glow"
            />
          </>
        )}
      </div>
    </motion.li>
  )
}

/** Results of the run as they arrive: thumbnails with editable captions. */
export function ResultsGrid({ job, run, trigger, prependTrigger }: {
  job: DatasetJob
  run: Run
  trigger: string
  prependTrigger: boolean
}) {
  const results = [...job.results].sort((a, b) => a.idx - b.idx)
  const shown = results.filter((r) => !run.deleted.includes(r.idx))
  // Cards present at the first render cascade in; later ones come in as they arrive.
  const [firstBatch, setFirstBatch] = useState<number | null>(null)
  if (firstBatch === null && results.length) setFirstBatch(results.length)
  const batch = firstBatch ?? results.length

  const t = trigger.trim()
  const preview = prependTrigger && t
    ? JSON_FORMATS.includes(job.config.caption_format ?? '') ? 'trigger added to high_level_description' : `${t},`
    : ''
  const upscaleFailed = results.filter((r) => r.upscale_error)

  if (!results.length) return null
  return (
    <section aria-label="Results" className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold">Review and edit captions</h2>
      {upscaleFailed.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>
            Upscaling failed on {upscaleFailed.length === 1 ? '1 image' : `${upscaleFailed.length} images`} (resized
            without the model): {upscaleFailed[0].upscale_error}
          </span>
        </p>
      )}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
        <AnimatePresence>
          {shown.map((r) => {
            const pos = results.indexOf(r)
            return (
              <ResultCard
                key={r.idx}
                jobId={run.jobId}
                r={r}
                text={run.edits[r.idx] ?? r.caption}
                trigger={preview}
                delay={pos < batch ? Math.min(pos, 24) * 0.03 : 0}
              />
            )
          })}
        </AnimatePresence>
      </ul>
    </section>
  )
}
