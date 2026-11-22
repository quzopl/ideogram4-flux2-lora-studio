import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useId, type ReactNode, type Ref } from 'react'
import { NumberInput } from '@/components/NumberInput'
import { PresetBar } from '@/components/PresetBar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { VlmSelect } from '@/components/VlmSelect'
import { cn } from '@/lib/utils'
import {
  appendInstruction,
  formValues,
  hintFor,
  isJsonFormat,
  OPTIONS,
  placeholderFor,
  STYLE_PRESETS,
  type PromptForm as Form,
} from './promptForm'

function Field({ label, htmlFor, wide, children }: { label: string; htmlFor?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', wide && 'sm:col-span-2')}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-text-dim">{label}</label>
      {children}
    </div>
  )
}

function Choice({ id, options, value, onChange }: {
  id: string
  options: [string, string][]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, text]) => <SelectItem key={v} value={v}>{text}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** Expand / Refine; the active pill slides between them. */
function ActionSwitch({ value, onChange }: { value: Form['action']; onChange: (v: Form['action']) => void }) {
  return (
    <div role="group" aria-label="Action" className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-bg/60 p-1">
      {(OPTIONS.action as [Form['action'], string][]).map(([v, text]) => {
        const active = v === value
        return (
          <button
            key={v}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(v)}
            className={cn(
              'relative rounded-lg px-3 py-2 text-sm transition-colors outline-none focus-visible:shadow-glow',
              active ? 'text-white' : 'text-text-dim hover:text-text',
            )}
          >
            {active && (
              <motion.span
                layoutId="prompt-action"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                className="absolute inset-0 rounded-lg bg-linear-to-r from-accent-from to-accent-to shadow-[0_0_16px_rgba(139,92,246,0.35)]"
              />
            )}
            <span className="relative">{text}</span>
          </button>
        )
      })}
    </div>
  )
}

interface PromptFormProps {
  form: Form
  setForm: (fn: (f: Form) => Form) => void
  text: string
  onText: (text: string) => void
  /** Shown under the prompt (e.g. it is empty); "" for none. */
  textError: string
  inputRef: Ref<HTMLTextAreaElement>
  /** Told when Max length becomes invalid ("" when it is fine again). Must be stable. */
  onValidity: (field: 'max_tokens', error: string) => void
}

/** The prompt, its style presets and the generation settings. */
export function PromptForm({ form, setForm, text, onText, textError, inputRef, onValidity }: PromptFormProps) {
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setModel = useCallback((v: string) => setForm((f) => ({ ...f, model: v })), [setForm])
  const choice = (k: 'subject' | 'caption_format' | 'quant' | 'elements_detail' | 'desc_detail', label: string) => (
    <Field label={label} htmlFor={id(k)}>
      <Choice id={id(k)} options={OPTIONS[k]} value={form[k]} onChange={(v) => set(k, v)} />
    </Field>
  )

  return (
    <section aria-label="Your prompt" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Your prompt</h2>
        <PresetBar view="prompts" current={form} onLoad={(v) => setForm((f) => ({ ...f, ...formValues(v) }))} />
      </div>

      <ActionSwitch value={form.action} onChange={(v) => set('action', v)} />
      <p data-testid="prompt-hint" className="text-xs text-text-dim">{hintFor(form.action, form.caption_format)}</p>

      <div className="flex flex-col gap-1.5">
        <textarea
          ref={inputRef}
          aria-label="Your prompt"
          placeholder={placeholderFor(form.action)}
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={6}
          aria-invalid={textError ? true : undefined}
          aria-describedby={textError ? id('text-error') : undefined}
          className="min-h-32 w-full resize-y rounded-lg border border-line bg-bg/60 px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-text-dim focus-visible:border-accent-from/60 focus-visible:shadow-glow aria-invalid:border-danger/60"
        />
        {textError && <p id={id('text-error')} className="text-xs text-danger">{textError}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-text-dim">
          Style presets (append a composition-preserving instruction)
        </span>
        <div className="grid gap-2 sm:grid-cols-3">
          {STYLE_PRESETS.map((p) => (
            // Always at its placeholder: a pick appends its instruction and is not kept.
            <Select key={p.label} value="" onValueChange={(v) => onText(appendInstruction(text, p.guide(v)))}>
              <SelectTrigger
                aria-label={p.label}
                title="Appends a composition-preserving instruction to the prompt"
                className="w-full min-w-0"
              >
                <SelectValue placeholder={p.label} />
              </SelectTrigger>
              <SelectContent>
                {p.options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
              </SelectContent>
            </Select>
          ))}
        </div>
      </div>

      <div className="grid gap-x-4 gap-y-3.5 border-t border-line pt-4 sm:grid-cols-2">
        {choice('subject', 'Subject type')}
        {choice('caption_format', 'Target format')}
        <Field label="Model" htmlFor={id('model')} wide>
          <VlmSelect id={id('model')} value={form.model} onChange={setModel} />
        </Field>
        {choice('quant', 'Quantization')}
        <Field label="Max length (tokens)" htmlFor={id('maxtok')}>
          <NumberInput
            id={id('maxtok')}
            field="max_tokens"
            onValidity={onValidity}
            min={64}
            max={8192}
            step={32}
            title="Reasoning models (Qwen3 and friends) count their thinking against this limit — give them 2048+ or they return nothing."
            value={form.max_tokens}
            onChange={(v) => set('max_tokens', v)}
          />
        </Field>
        <AnimatePresence initial={false}>
          {isJsonFormat(form.caption_format) && (
            <motion.div
              key="ideogram"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="grid gap-x-4 gap-y-3.5 sm:col-span-2 sm:grid-cols-2"
            >
              {choice('elements_detail', 'Element count (Ideogram)')}
              {choice('desc_detail', 'Description density (Ideogram)')}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  )
}
