import { useCallback, useId, useState, type ReactNode } from 'react'
import { ModelSelect } from '@/components/ModelSelect'
import { PresetBar } from '@/components/PresetBar'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { CropMode } from '@/lib/types'
import { cn } from '@/lib/utils'
import { OPTIONS, presetValues, type DatasetForm } from './datasetForm'
import { VlmSelect } from './VlmSelect'

function Field({ label, htmlFor, hint, wide, children }: {
  label: string
  htmlFor?: string
  hint?: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', wide && 'sm:col-span-2')}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-text-dim">{label}</label>
      {children}
      {hint && <p className="text-xs text-text-dim">{hint}</p>}
    </div>
  )
}

function Choice({ id, label, options, value, onChange, disabled }: {
  id?: string
  /** Accessible name when there is no <label for>. */
  label?: string
  options: [string, string][]
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} className="w-full min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, text]) => <SelectItem key={v} value={v}>{text}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** A whole-number input that only reports valid numbers (no NaN is ever saved). */
function NumberInput({ id, value, onChange, min, max, step, title }: {
  id: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  title?: string
}) {
  const [text, setText] = useState(String(value))
  // A value set elsewhere (a preset, the saved form) replaces the typed text.
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setText(String(value))
  }
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={step}
      title={title}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = e.target.valueAsNumber
        if (Number.isInteger(n)) onChange(n)
      }}
      onBlur={() => setText(String(value))}
      className="font-mono"
    />
  )
}

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2.5">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <label htmlFor={id} className="text-sm">{label}</label>
    </div>
  )
}

interface SettingsPanelProps {
  form: DatasetForm
  setForm: (fn: (f: DatasetForm) => DatasetForm) => void
  /** The source folder's crop source; owned by its crop plan, not the form. */
  cropMode: CropMode
  onCropMode: (m: CropMode) => void
  /** False while there is no source or its crop plan has not loaded. */
  cropReady: boolean
  /** True when the plan has no crops (Auto then falls back to the centre crop). */
  planEmpty: boolean
}

export function SettingsPanel({ form, setForm, cropMode, onCropMode, cropReady, planEmpty }: SettingsPanelProps) {
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const set = <K extends keyof DatasetForm>(k: K, v: DatasetForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setModel = useCallback((v: string) => setForm((f) => ({ ...f, model: v })), [setForm])
  const choice = <K extends keyof typeof OPTIONS & keyof DatasetForm>(k: K, label: string) => (
    <Field label={label} htmlFor={id(k)}>
      <Choice id={id(k)} options={OPTIONS[k]} value={String(form[k])} onChange={(v) => set(k, v as DatasetForm[K])} />
    </Field>
  )

  return (
    <section aria-label="Settings" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Settings</h2>
        <PresetBar
          view="dataset"
          current={presetValues(form)}
          onLoad={(v) => setForm((f) => ({ ...f, ...presetValues(v) }))}
        />
      </div>

      <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
        {choice('mode', 'Caption mode')}
        {choice('style', 'Caption style')}
        {choice('caption_format', 'Target format')}
        <Field label="Target resolution" htmlFor={id('resolution')}>
          <Choice id={id('resolution')} options={OPTIONS.resolution} value={String(form.resolution)} onChange={(v) => set('resolution', Number(v))} />
        </Field>
        <Field label="Bucket step (px)" htmlFor={id('step')}>
          <Choice id={id('step')} options={OPTIONS.step} value={String(form.step)} onChange={(v) => set('step', Number(v))} />
        </Field>
        <Field label="Cropping" htmlFor={id('square')}>
          <Choice id={id('square')} options={OPTIONS.square} value={String(form.square)} onChange={(v) => set('square', v === 'true')} />
        </Field>
        <Field
          label="Crop source"
          htmlFor={id('crop')}
          wide
          hint={cropReady && cropMode === 'auto' && planEmpty
            ? <span className="text-warning">Run "Auto-crop all" to compute crops — without them the centre crop is used.</span>
            : undefined}
        >
          <Choice
            id={id('crop')}
            options={OPTIONS.crop_mode}
            value={cropMode}
            onChange={(v) => onCropMode(v as CropMode)}
            disabled={!cropReady}
          />
        </Field>
        {choice('fit', 'Fit')}
        <Field label="Pad colour" htmlFor={id('pad')}>
          <div className="flex items-center gap-2">
            <input
              id={id('pad')}
              type="color"
              value={form.pad_color}
              onChange={(e) => set('pad_color', e.target.value)}
              className="h-8 w-12 cursor-pointer rounded-lg border border-line bg-bg/60 p-0.5"
            />
            <span className="font-mono text-xs text-text-dim">{form.pad_color}</span>
          </div>
        </Field>
        <Field label="Centering (horizontal / vertical)" wide>
          <div className="grid grid-cols-2 gap-2">
            <Choice label="Centering horizontal" options={OPTIONS.centering_x} value={form.centering_x} onChange={(v) => set('centering_x', v)} />
            <Choice label="Centering vertical" options={OPTIONS.centering_y} value={form.centering_y} onChange={(v) => set('centering_y', v)} />
          </div>
        </Field>
        {choice('fmt', 'Format')}
        <Field label="JPG quality" htmlFor={id('jpgq')}>
          <NumberInput id={id('jpgq')} min={50} max={100} value={form.jpg_quality} onChange={(v) => set('jpg_quality', v)} />
        </Field>

        <Field label="VLM model" htmlFor={id('model')} wide>
          <VlmSelect id={id('model')} value={form.model} onChange={setModel} />
        </Field>
        {choice('quant', 'Quantization')}
        <Field label="Max caption length (tokens)" htmlFor={id('maxtok')}>
          <NumberInput
            id={id('maxtok')}
            min={64}
            max={8192}
            step={32}
            title="Reasoning models (Qwen3 and friends) count their thinking against this limit — give them 2048+ or they return nothing."
            value={form.max_tokens}
            onChange={(v) => set('max_tokens', v)}
          />
        </Field>
        <Field label="Upscale model" wide hint="Used when the crop is smaller than the target.">
          <ModelSelect
            kind="upscale"
            label="Upscale model"
            noneLabel="Off (plain LANCZOS)"
            value={form.upscale_model}
            onChange={(v) => set('upscale_model', v)}
          />
        </Field>

        <Field label="Trigger word" htmlFor={id('trigger')} wide>
          <Input
            id={id('trigger')}
            placeholder="e.g. ohwx person"
            value={form.trigger}
            onChange={(e) => set('trigger', e.target.value)}
          />
        </Field>
        <Toggle id={id('caption')} label="Generate captions (VLM)" checked={form.do_caption} onChange={(v) => set('do_caption', v)} />
        <Toggle id={id('prepend')} label="Prepend trigger to captions" checked={form.prepend_trigger} onChange={(v) => set('prepend_trigger', v)} />
      </div>
    </section>
  )
}
