import { Wand2 } from 'lucide-react'
import { JobProgress } from '@/components/JobProgress'
import { Button } from '@/components/ui/button'
import type { useDatasetJob } from './runStore'

interface RunPanelProps {
  /** False without a source, while one is loading, or while a job runs. */
  canProcess: boolean
  onProcess: () => void
  /** The current run's job; null before the first run. */
  job: ReturnType<typeof useDatasetJob> | null
}

/** The Process button and the run's progress. */
export function RunPanel({ canProcess, onProcess, job }: RunPanelProps) {
  const data = job?.data
  // The backend appends a traceback: the first line shows, the rest is in the title.
  const error = data?.state === 'error' ? data.error : job?.error ?? ''
  return (
    <div className="flex flex-col gap-3">
      <Button
        size="lg"
        type="button"
        disabled={!canProcess}
        onClick={onProcess}
        className="bg-linear-to-r from-accent-from to-accent-to text-white shadow-[0_0_24px_rgba(139,92,246,0.25)] transition-shadow hover:shadow-[0_0_32px_rgba(34,211,238,0.3)]"
      >
        <Wand2 />
        Process images
      </Button>
      {job && (
        <div title={error || undefined} className="rounded-xl border border-line bg-surface p-4">
          <JobProgress
            state={data?.state ?? 'pending'}
            processed={data?.processed ?? 0}
            total={data?.total ?? 0}
            current={data?.current}
            error={error ? error.split('\n')[0] : undefined}
          />
        </div>
      )}
    </div>
  )
}
