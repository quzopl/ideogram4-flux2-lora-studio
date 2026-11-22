import { motion } from 'motion/react'
import { cn } from '@/lib/utils'

interface JobProgressProps {
  /** Job state from the backend, e.g. "running", "done", "error", "cancelled". */
  state: string
  processed: number
  total: number
  /** What is being worked on now (a file name); may be empty. */
  current?: string
  error?: string
}

export function JobProgress({ state, processed, total, current, error }: JobProgressProps) {
  const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0
  const failed = state === 'error'
  const running = state === 'running' || state === 'pending'

  return (
    <div data-testid="job-progress" data-state={state} className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={processed}
        className="relative h-2 overflow-hidden rounded-full bg-white/[0.06]"
      >
        <motion.div
          className={cn(
            'relative h-full overflow-hidden rounded-full bg-linear-to-r',
            failed ? 'from-danger to-danger/70' : 'from-accent-from to-accent-to',
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
          <span className="text-text">{processed} / {total}</span>
          {current ? ` · ${current}` : ''}
        </span>
        <span className="shrink-0 text-text-dim">{state}</span>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}
