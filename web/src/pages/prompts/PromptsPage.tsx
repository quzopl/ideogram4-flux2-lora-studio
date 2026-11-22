import { useQueryClient } from '@tanstack/react-query'
import { Sparkles, WandSparkles } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { JobProgress } from '@/components/JobProgress'
import { Button } from '@/components/ui/button'
import { useSavedForm } from '@/hooks/useAutosave'
import { useJobPoll } from '@/hooks/useJobPoll'
import { api } from '@/lib/api'
import { useMutationWithToast } from '@/lib/queries'
import { LibraryPanel } from './LibraryPanel'
import { PROMPT_DEFAULTS, toJobBody, type PromptForm as Form } from './promptForm'
import { PromptForm } from './PromptForm'
import {
  dropPromptJob,
  finishPromptJob,
  flushPromptRun,
  setPromptEdited,
  setPromptText,
  startPromptJob,
  usePromptRun,
  type PromptResult,
} from './promptRunStore'
import { ResultPanel } from './ResultPanel'

/** GET /api/prompt/jobs/{id}. */
interface PromptJob {
  state: 'pending' | 'loading_model' | 'generating' | 'done' | 'error'
  current: string
  error: string
  result: PromptResult | null
}

const STEP: Record<string, string> = { pending: 'Starting…', generating: 'Generating…' }

export function PromptsPage() {
  const qc = useQueryClient()
  const [form, setForm, loaded] = useSavedForm<Form>('prompts', PROMPT_DEFAULTS)
  const [textError, setTextError] = useState('')
  const [maxTokensError, setMaxTokensError] = useState('')
  const onValidity = useCallback((_: 'max_tokens', error: string) => setMaxTokensError(error), [])
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // This tab's run (kept in sessionStorage, so leaving the view resumes it).
  const run = usePromptRun()
  const jobId = run.jobId
  const job = useJobPoll<PromptJob>(['prompt-job', jobId], jobId ? `/api/prompt/jobs/${jobId}` : null)
  useEffect(() => flushPromptRun, [])

  const data = job.data
  useEffect(() => {
    if (!jobId) return
    if (data?.state === 'done' && data.result) {
      finishPromptJob(jobId, data.result)
      qc.invalidateQueries({ queryKey: ['gpu'] })
      qc.invalidateQueries({ queryKey: ['prompt-library'] })
    } else if (job.isGone) {
      toast.error('The prompt job is gone (was the server restarted?)')
      dropPromptJob(jobId)
    }
  }, [jobId, data, job.isGone, qc])

  // At mutation level: the job is kept even if the view was left before the answer.
  const start = useMutationWithToast(
    (body: ReturnType<typeof toJobBody>) => api<{ job_id: string }>('/api/prompt/jobs', { method: 'POST', json: body }),
    { onSuccess: (r, body) => startPromptJob(r.job_id, body.caption_format) },
  )

  const busy = start.isPending || job.running
  const canGenerate = loaded && !busy && !maxTokensError && form.model !== ''

  const generate = () => {
    if (!canGenerate) return
    if (!run.text.trim()) {
      setTextError('Type a prompt to process.')
      inputRef.current?.focus()
      return
    }
    start.mutate(toJobBody(form, run.text))
  }

  const onText = (text: string) => {
    setPromptText(text)
    if (textError && text.trim()) setTextError('')
  }

  const toInput = (text: string) => {
    onText(text)
    setForm((f) => ({ ...f, action: 'refine' }))
    inputRef.current?.focus()
    toast.success('Moved the result to the input.')
  }

  // The job error has a traceback after its first line: that line shows, the whole text is in the title.
  const error = data?.state === 'error' ? data.error : ''
  const step = data?.state === 'loading_model' ? data.current || 'Loading the model…' : STEP[data?.state ?? 'pending']

  return (
    <div className="flex flex-col gap-6 px-10 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Prompt studio</h1>
        <p className="mt-1 text-sm text-text-dim">
          Expand a short idea or clean up an existing prompt for FLUX.2, Ideogram 4 or ai-toolkit.
        </p>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(26rem,36rem)_1fr]">
        <fieldset disabled={!loaded} className="flex min-w-0 flex-col gap-4">
          <PromptForm
            form={form}
            setForm={setForm}
            text={run.text}
            onText={onText}
            textError={textError}
            inputRef={inputRef}
            onValidity={onValidity}
          />
          <Button
            size="lg"
            type="button"
            disabled={!canGenerate}
            onClick={generate}
            className="bg-linear-to-r from-accent-from to-accent-to text-white shadow-[0_0_24px_rgba(139,92,246,0.25)] transition-shadow hover:shadow-[0_0_32px_rgba(34,211,238,0.3)]"
          >
            <Sparkles />
            Generate prompt
          </Button>
          <AnimatePresence initial={false}>
            {jobId && (
              <motion.div
                key="progress"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                title={error || undefined}
                className="rounded-xl border border-line bg-surface p-4"
              >
                <JobProgress
                  state={data?.state ?? 'pending'}
                  current={error ? undefined : step}
                  error={error ? error.split('\n')[0] : undefined}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </fieldset>

        <AnimatePresence mode="wait" initial={false}>
          {run.result ? (
            <motion.div
              key={`result-${run.result.library_id}-${run.result.prompt.length}`}
              initial={{ opacity: 0, y: 12, scale: 0.98, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ type: 'spring', stiffness: 260, damping: 28 }}
              className="min-w-0"
            >
              <ResultPanel
                result={run.result}
                edited={run.edited}
                onEdit={setPromptEdited}
                onRegenerate={generate}
                regenerateDisabled={!canGenerate}
                stale={busy}
                onUseAsInput={toInput}
              />
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="grid min-h-80 place-items-center rounded-xl border border-dashed border-line bg-surface/40 p-8 text-center"
            >
              <div className="flex flex-col items-center gap-2">
                <WandSparkles className="size-6 text-accent-to/70" />
                <p className="text-sm">The prompt appears here</p>
                <p className="text-xs text-text-dim">Generate one, then edit, copy or open it on the canvas.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <LibraryPanel />
    </div>
  )
}
