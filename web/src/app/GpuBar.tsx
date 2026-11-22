import { useQueryClient } from '@tanstack/react-query'
import { Cpu, Power } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { formatGb } from '@/lib/format'
import { useGpus, useGpuStatus, useMutationWithToast } from '@/lib/queries'
import type { GpuCard as Card, GpuStatus, Role } from '@/lib/types'
import { cn } from '@/lib/utils'

/** "Qwen/Qwen2.5-VL-7B-Instruct" -> "Qwen2.5-VL-7B-Instruct". */
const tail = (id: string) => id.split('/').pop() || id

/** Name of the model loaded for a role, as far as /api/gpu knows it. */
function loadedName(role: Role, status: GpuStatus | undefined): string {
  if (role === 'vlm' && status?.model) return tail(status.model)
  if (role === 'upscale' && status?.upscale_model) return tail(status.upscale_model)
  return role
}

function GpuCardView({ card, status }: { card: Card; status: GpuStatus | undefined }) {
  const used = card.vram_used_gb
  const total = card.vram_total_gb
  const pct = used != null && total ? Math.min(100, (used / total) * 100) : 0
  const hot = pct >= 90

  return (
    <div
      data-testid="gpu-card"
      title={card.name}
      className="flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm font-medium">{card.label.split(' · ')[0]}</span>
        <span className="shrink-0 font-mono text-xs text-text-dim tabular-nums">
          {used != null && total != null ? (
            <>
              <span className={cn(hot ? 'text-warning' : 'text-text')}>{formatGb(used)}</span>
              {' / '}
              {formatGb(total)}
            </>
          ) : (
            'VRAM —'
          )}
        </span>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <motion.div
          className={cn(
            'h-full rounded-full bg-linear-to-r',
            hot ? 'from-warning to-danger' : 'from-accent-from to-accent-to',
          )}
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 24 }}
        />
      </div>

      <div className="flex min-h-5 flex-wrap items-center gap-1">
        {card.roles.map((role) => (
          <span
            key={role}
            className="rounded-md border border-line px-1.5 font-mono text-[10px] leading-4 text-text-dim uppercase"
          >
            {role}
          </span>
        ))}
        {card.loaded.map((role) => (
          <span
            key={`loaded-${role}`}
            className="flex max-w-40 items-center gap-1 rounded-md bg-success/10 px-1.5 text-[10px] leading-4 text-success"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-success shadow-[0_0_6px_var(--color-success)]" />
            <span className="truncate">{loadedName(role, status)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export function GpuBar() {
  const qc = useQueryClient()
  const gpus = useGpus()
  const status = useGpuStatus()
  const release = useMutationWithToast(() => api<GpuStatus>('/api/unload', { method: 'POST' }), {
    success: 'GPU memory released',
    invalidate: [['gpus'], ['gpu']],
  })

  // /api/gpus is polled, /api/gpu is not: refresh the model names when what
  // is loaded where changes.
  const loadedKey = JSON.stringify(gpus.data?.gpus.map((c) => c.loaded))
  const prevLoaded = useRef(loadedKey)
  useEffect(() => {
    if (prevLoaded.current !== undefined && prevLoaded.current !== loadedKey) {
      void qc.invalidateQueries({ queryKey: ['gpu'] })
    }
    prevLoaded.current = loadedKey
  }, [loadedKey, qc])

  const cards = gpus.data?.gpus ?? []

  return (
    <header
      data-testid="gpu-bar"
      className="flex min-h-20 shrink-0 items-center gap-3 border-b border-line bg-surface/60 px-6 py-3 backdrop-blur-xl"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto">
        {gpus.isPending ? (
          <Skeleton className="h-[68px] w-72 rounded-xl bg-surface-2" />
        ) : gpus.isError ? (
          <span className="text-sm text-danger">GPU status unavailable</span>
        ) : cards.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-text-dim">
            <Cpu className="size-4" />
            <span className="text-text">No CUDA GPU</span>
            <span>· models run on the CPU</span>
          </div>
        ) : (
          cards.map((card) => <GpuCardView key={card.uuid} card={card} status={status.data} />)
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={release.isPending}
            onClick={() => release.mutate()}
            className="shrink-0"
          >
            <Power data-icon="inline-start" />
            Release
          </Button>
        </TooltipTrigger>
        <TooltipContent>Unload every model and free GPU memory</TooltipContent>
      </Tooltip>
    </header>
  )
}
