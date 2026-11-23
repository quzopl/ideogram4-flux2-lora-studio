import { useIsMutating, useQueryClient } from '@tanstack/react-query'
import { Palette } from 'lucide-react'
import { useCallback, useId, useState, type ReactNode } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { NumberInput } from '@/components/NumberInput'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useMutationWithToast } from '@/lib/queries'
import { ComfyJobBox } from './ComfyJobBox'
import { startJob, useComfyJobs } from './comfyJobStore'
import { setLoraForm, useComfyForm, type LoraForm } from './formStore'
import { LoraRows } from './LoraRows'
import { NamedLibrary } from './NamedLibrary'
import { deletePrompt, errorText, loraSlots, savePrompt, useComfyConfig, usePrompts } from './queries'
import { StatusLine, type Status } from './StatusLine'
import { WorkflowCard } from './WorkflowCard'

const START_KEY = ['comfy-lora-start']

type NumberField = 'width' | 'height' | 'steps' | 'cfg' | 'seed' | 'batch'

/** The number fields (classic labels and defaults; the bounds are the port's). */
const NUMBERS: { k: NumberField; label: string; min: number; max: number; step?: number; decimal?: boolean }[] = [
  { k: 'width', label: 'Width', min: 64, max: 8192, step: 64 },
  { k: 'height', label: 'Height', min: 64, max: 8192, step: 64 },
  { k: 'steps', label: 'Steps', min: 1, max: 1000 },
  { k: 'cfg', label: 'CFG / Guidance', min: 0, max: 100, step: 0.1, decimal: true },
  { k: 'seed', label: 'Seed (-1 = random)', min: -1, max: Number.MAX_SAFE_INTEGER },
  { k: 'batch', label: 'Sample count', min: 1, max: 8 },
]

/** The rows shown: one empty row per slot until a row is touched, else the typed ones (no more than the slots). */
const shownRows = (loras: LoraForm['loras'], slots: number) =>
  (loras ?? Array<string>(slots).fill('')).slice(0, slots)

/** The LoRA test tab: the workflow, then LoRAs, parameters and prompt, Generate samples and its job. */
export function LoraTestTab() {
  return (
    <>
      <WorkflowCard />
      <LoraTestCard />
    </>
  )
}

function LoraTestCard() {
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const qc = useQueryClient()
  const config = useComfyConfig().data
  const hasWorkflow = config?.has_workflow === true
  const slots = hasWorkflow ? loraSlots(config.mapping) : 0
  const form = useComfyForm().lora
  const rows = shownRows(form.loras, slots)

  const [errors, setErrors] = useState<Record<string, string>>({})
  const onValidity = useCallback(
    (field: string, error: string) => setErrors((e) => (e[field] === error ? e : { ...e, [field]: error })),
    [],
  )
  const invalid = Object.values(errors).some(Boolean)

  // The prompt library: Load over a typed prompt asks first.
  const prompts = usePrompts()
  const [libStatus, setLibStatus] = useState<Status | null>(null)
  const [replacing, setReplacing] = useState<string | null>(null)
  const loadPrompt = (_name: string, text: string) => {
    if (form.prompt.trim() && form.prompt !== text) setReplacing(text)
    else setLoraForm({ prompt: text })
  }
  const saveAs = async (name: string) => {
    if (!form.prompt.trim()) {
      setLibStatus({ tone: 'err', text: 'Enter a prompt first.' })
      throw new Error('empty prompt')
    }
    try {
      await savePrompt(qc, name, form.prompt)
      setLibStatus({ tone: 'ok', text: `Saved prompt "${name}".` })
    } catch (e) {
      setLibStatus({ tone: 'err', text: `Error: ${errorText(e)}` })
      throw e
    }
  }
  const remove = async (name: string) => {
    try {
      await deletePrompt(qc, name)
      setLibStatus({ tone: 'ok', text: `Deleted "${name}".` })
    } catch (e) {
      setLibStatus({ tone: 'err', text: `Error: ${errorText(e)}` })
      throw e
    }
  }

  // At mutation level: the job is kept even if the view was left before the answer.
  const start = useMutationWithToast(
    (body: Record<string, unknown>) => api<{ job_id: string }>('/api/comfy/generate', { method: 'POST', json: body }),
    { onSuccess: (r) => startJob('lora', r.job_id), mutationKey: START_KEY },
  )
  // By key, not start.isPending: a start sent before leaving the view and returning is still in flight.
  const starting = useIsMutating({ mutationKey: START_KEY }) > 0
  const running = useComfyJobs().lora.jobId !== null
  const hint = !config
    ? ''
    : !hasWorkflow
      ? 'Upload a workflow above first.'
      : invalid
        ? 'Fix the fields marked above.'
        : !form.prompt.trim()
          ? 'Enter a prompt.'
          : ''
  const ready = !!config && !hint && !starting && !running

  const generate = () => {
    if (!ready) return
    start.mutate({
      prompt: form.prompt,
      width: form.width,
      height: form.height,
      steps: form.steps,
      cfg: form.cfg,
      seed: form.seed < 0 ? null : form.seed,
      // Positional: row i is slot i, a blank row leaves its slot as the workflow has it.
      loras: rows.map((r) => r.trim()),
      batch: form.batch,
    })
  }

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div>
        <h2 id={id('title')} className="text-sm font-semibold">LoRA test</h2>
        <p className="mt-1 text-xs text-text-dim">
          Pick one or more LoRAs (as many as your workflow has LoRA nodes), a prompt and parameters.
        </p>
      </div>

      <LoraRows slots={slots} hasWorkflow={hasWorkflow} rows={rows} onChange={(loras) => setLoraForm({ loras })} />

      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        {NUMBERS.map(({ k, label, min, max, step, decimal }) => (
          <Field key={k} label={label} htmlFor={id(k)}>
            <NumberInput
              id={id(k)}
              field={k}
              min={min}
              max={max}
              step={step}
              decimal={decimal}
              value={form[k]}
              onChange={(v) => setLoraForm({ [k]: v })}
              onValidity={onValidity}
            />
          </Field>
        ))}
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="text-sm font-medium">Prompt library</h3>
        <NamedLibrary title="prompt" items={prompts.data ?? {}} onLoad={loadPrompt} onSave={saveAs} onDelete={remove} />
        <StatusLine status={libStatus} />
      </div>

      <Field label="Prompt (FLUX.2)" htmlFor={id('prompt')}>
        <textarea
          id={id('prompt')}
          placeholder="e.g. A photo of ohwx person, standing in a sunlit park…"
          value={form.prompt}
          onChange={(e) => setLoraForm({ prompt: e.target.value })}
          className="min-h-28 w-full resize-y rounded-lg border border-line bg-bg/60 px-3 py-2.5 text-sm leading-relaxed outline-none focus-visible:border-accent-from/60 focus-visible:shadow-glow"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" disabled={!ready} onClick={generate}>
          <Palette />
          Generate samples
        </Button>
        {hint && <p className="text-sm text-text-dim">{hint}</p>}
      </div>

      <ComfyJobBox slot="lora" />

      <ConfirmDialog
        open={replacing !== null}
        onOpenChange={(open) => !open && setReplacing(null)}
        title="Replace the prompt?"
        action="Replace"
        onConfirm={() => {
          if (replacing !== null) setLoraForm({ prompt: replacing })
        }}
      >
        The prompt you typed will be replaced by the saved one.
      </ConfirmDialog>
    </section>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-text-dim">{label}</label>
      {children}
    </div>
  )
}
