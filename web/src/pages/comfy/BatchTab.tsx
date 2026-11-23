import { useQueryClient } from '@tanstack/react-query'
import { Images, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useCallback, useId, useState } from 'react'
import { Link } from 'react-router'
import { NumberInput } from '@/components/NumberInput'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { cancelBatch, startBatch, UNKNOWN } from './batchRunner'
import { ErrorText } from './ComfyJobBox'
import { useComfyJobs, type BatchLine, type BatchState } from './comfyJobStore'
import { setBatchForm, SIZE_FIELDS, useComfyForm } from './formStore'
import { Field } from './LoraTestTab'
import { galleryLink } from './format'
import { useComfyConfig } from './queries'

const PLACEHOLDER = [
  'A photo of a red sports car on a coastal road at sunset.',
  'A photo of a wooden cabin in a snowy forest, morning light.',
  'A close-up of a steaming mug of coffee on a marble table.',
].join('\n')

/** The prompt lines: trimmed, blank ones dropped (classic). */
const promptLines = (text: string) => text.split('\n').map((s) => s.trim()).filter(Boolean)

/**
 * The reference batch tab: one image per prompt line, one line after another.
 * The batch itself runs in batchRunner (it goes on while the view is left).
 */
export function BatchTab() {
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const qc = useQueryClient()
  const config = useComfyConfig().data
  const form = useComfyForm().batch
  const b = useComfyJobs().batch

  const [errors, setErrors] = useState<Record<string, string>>({})
  const onValidity = useCallback(
    (field: string, error: string) => setErrors((e) => (e[field] === error ? e : { ...e, [field]: error })),
    [],
  )
  const invalid = Object.values(errors).some(Boolean)

  const lines = promptLines(form.prompts)
  const hint = !config
    ? ''
    : !config.has_workflow
      ? 'Upload a workflow on the LoRA test tab first.'
      : invalid
        ? 'Fix the fields marked above.'
        : lines.length === 0
          ? 'Enter at least one prompt.'
          : ''
  const ready = !!config && !hint && !b.running

  const generate = () => {
    if (!ready) return
    startBatch(qc, lines, { width: form.width, height: form.height, steps: form.steps, cfg: form.cfg })
  }

  return (
    <section aria-labelledby={id('title')} className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div>
        <h2 id={id('title')} className="text-sm font-semibold">Reference batch</h2>
        <p className="mt-1 text-xs text-text-dim">
          A list of prompts (one per line) — each line produces one image, sequentially.
        </p>
      </div>

      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-4">
        {SIZE_FIELDS.map(({ k, label, min, max, step, decimal }) => (
          <Field key={k} label={label} htmlFor={id(k)}>
            <NumberInput
              id={id(k)}
              field={k}
              min={min}
              max={max}
              step={step}
              decimal={decimal}
              value={form[k]}
              onChange={(v) => setBatchForm({ [k]: v })}
              onValidity={onValidity}
            />
          </Field>
        ))}
      </div>

      <Field label="Prompts (one per line)" htmlFor={id('prompts')}>
        <textarea
          id={id('prompts')}
          rows={6}
          placeholder={PLACEHOLDER}
          value={form.prompts}
          onChange={(e) => setBatchForm({ prompts: e.target.value })}
          className="w-full resize-y rounded-lg border border-line bg-bg/60 px-3 py-2.5 text-sm leading-relaxed outline-none focus-visible:border-accent-from/60 focus-visible:shadow-glow"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" disabled={!ready} onClick={generate}>
          <Images />
          Generate batch
        </Button>
        {b.running && (
          <Button variant="outline" disabled={b.cancelled && !b.cancelFailed} onClick={() => void cancelBatch()}>
            <X />
            {b.cancelled && !b.cancelFailed ? 'Cancelling…' : 'Cancel'}
          </Button>
        )}
        {hint && <p className="text-sm text-text-dim">{hint}</p>}
      </div>

      <Summary batch={b} />
      {b.results.length > 0 && (
        <ol aria-label="Batch lines" className="flex flex-col gap-2">
          {b.results.map((r, i) => <Line key={i} n={i + 1} result={r} />)}
        </ol>
      )}
    </section>
  )
}

/** While it runs, the line being generated; afterwards how the batch ended. */
function Summary({ batch: b }: { batch: BatchState }) {
  if (b.running) {
    const line = b.lines[b.index] ?? ''
    return (
      <p role="status" className="text-sm break-words text-text">
        Generating {Math.min(b.index + 1, b.lines.length)}/{b.lines.length}: "{line.slice(0, 60)}…"
      </p>
    )
  }
  if (b.results.length === 0) return null
  const stop = b.results.findIndex((r) => r.state === 'error' || r.state === 'gone')
  if (stop >= 0) return <ErrorText text={b.results[stop].error} prefix={`Stopped at line ${stop + 1}: `} className="text-danger" />
  if (b.cancelled) return <p className="text-sm text-text-dim">Cancelled.</p>
  return <p className="text-sm text-success">Done: {b.lines.length}.</p>
}

const STATE_TONE: Record<string, string> = {
  done: 'text-success',
  error: 'text-danger',
  gone: 'text-danger',
  queueing: 'text-accent-to',
  pending: 'text-accent-to',
  running: 'text-accent-to',
  [UNKNOWN]: 'text-warning',
}

/** One prompt line: its text, its state and, once done, its images. */
function Line({ n, result }: { n: number; result: BatchLine }) {
  const warning = result.state === 'done' && result.error ? result.error : ''
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-bg/40 px-3 py-2">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="w-5 shrink-0 text-right font-mono text-xs text-text-dim tabular-nums">{n}</span>
        <span title={result.line} className="min-w-0 flex-1 truncate">{result.line}</span>
        <span data-testid="batch-line-state" className={cn('shrink-0 font-mono text-xs', STATE_TONE[result.state] ?? 'text-text-dim')}>
          {result.state}
        </span>
      </div>
      {/* Done, but e.g. an image could not be fetched from ComfyUI. */}
      {warning && <p title={warning} className="pl-7 text-xs break-words text-warning">Warning: {warning.split('\n')[0]}</p>}
      {result.images.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2 pl-7">
          {result.images.map((img, i) => (
            <motion.li
              key={img.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i, 8) * 0.04 }}
              className="overflow-hidden rounded-md border border-line bg-bg/60"
            >
              <Link to={galleryLink(img.id)} title="Open in the gallery" className="block outline-none focus-visible:shadow-glow">
                <img src={img.url} alt={`Seed ${img.seed ?? '—'}`} loading="lazy" className="aspect-square w-full object-contain" />
              </Link>
            </motion.li>
          ))}
        </ul>
      )}
    </li>
  )
}
