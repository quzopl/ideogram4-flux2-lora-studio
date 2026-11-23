import { motion } from 'motion/react'
import { cn } from '@/lib/utils'

interface JobProgressProps {
  /** Job state from the backend, e.g. "pending", "processing", "done", "error", "cancelled". */
  state: string
  /** Without `processed`/`total` the bar is indeterminate and shows no counts. */
  processed?: number
  total?: number
  /** What is being worked on now (a file name); may be empty. */
  current?: string
  error?: string
}

export function JobProgress({ state, processed = 0, total, current, error }: JobProgressProps) {
  const failed = state === 'error'
  const running = !['done', 'error', 'cancelled'].includes(state)
  const counted = total !== undefined
  // Indeterminate: a full bar with the shimmer (red once failed).
  const pct = !counted ? 100 : total > 0 ? Math.min(100, (processed / total) * 100) : 0

  return (
    <div data-testid="job-progress" data-state={state} className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-valuemin={counted ? 0 : undefined}
        aria-valuemax={counted ? total : undefined}
        aria-valuenow={counted ? processed : undefined}
        className="relative h-2 overflow-hidden rounded-full bg-white/[0.06]"
      >
        <motion.div
          className={cn(
            'relative h-full overflow-hidden rounded-full bg-linear-to-r',
            failed ? 'from-danger to-danger/70' : 'from-accent-from to-accent-to',
            !counted && running && 'opacity-50',
          )}
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 24 }}
        >
          {running && (
            <motion.div
              className="absolute inset-y-0 w-1/3 bg-linear-to-r from-transparent via-white/35 to-transparent"
              initial={{ x: '-100%' }}
              animate={{ x: '300%' }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
            />
          )}
        </motion.div>
      </div>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate font-mono text-text-dim tabular-nums">
          {counted ? (
            <>
              <span className="text-text">{processed} / {total}</span>
              {current ? ` · ${current}` : ''}
            </>
          ) : (
            <span className="text-text">{current}</span>
          )}
        </span>
        {counted && <span className="shrink-0 text-text-dim">{state}</span>}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}
