import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/utils'

/** One v15 lint finding (backend/v15_lint.py). */
export interface V15Finding {
  level: 'err' | 'warn'
  msg: string
}

const row = 'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm'
const item = {
  initial: { opacity: 0, x: -6 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0 },
  transition: { type: 'spring' as const, stiffness: 420, damping: 32 },
}

/** The v15 guideline check of a JSON prompt: its findings, or that it has none. */
export function V15Findings({ findings }: { findings: V15Finding[] }) {
  return (
    <ul data-testid="v15-findings" aria-label="v15 check" className="flex flex-col gap-1.5">
      <AnimatePresence initial={false} mode="popLayout">
        {findings.length === 0 ? (
          <motion.li key="ok" layout {...item} className={cn(row, 'border-success/25 bg-success/[0.06]')}>
            <span aria-hidden className="font-semibold text-success">✓</span>
            <span>No warnings — compliant with the v15 guidelines</span>
          </motion.li>
        ) : (
          findings.map((f, i) => {
            const err = f.level === 'err'
            return (
              <motion.li
                key={`${i}-${f.msg}`}
                layout
                {...item}
                transition={{ ...item.transition, delay: Math.min(i, 8) * 0.03 }}
                className={cn(row, err ? 'border-danger/25 bg-danger/[0.06]' : 'border-warning/25 bg-warning/[0.06]')}
              >
                <span aria-hidden className={cn('w-3 shrink-0 text-center font-semibold', err ? 'text-danger' : 'text-warning')}>
                  {err ? '✕' : '!'}
                </span>
                <span className="min-w-0 break-words">{f.msg}</span>
              </motion.li>
            )
          })
        )}
      </AnimatePresence>
    </ul>
  )
}
