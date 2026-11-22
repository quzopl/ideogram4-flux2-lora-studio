import type { CropDoc } from '@/lib/types'

/**
 * Saved as forms.dataset. The crop source (`crop_mode`) is not here: it is
 * stored per folder with the crop plan (useCropPlan).
 */
export interface DatasetForm {
  folder: string
  mode: string
  style: string
  caption_format: string
  resolution: number
  step: number
  square: boolean
  fit: string
  pad_color: string
  centering_x: string
  centering_y: string
  fmt: string
  jpg_quality: number
  /** "" until GET /api/models gives its default. */
  model: string
  quant: string
  max_tokens: number
  do_caption: boolean
  /** "" = off (plain LANCZOS). */
  upscale_model: string
  trigger: string
  prepend_trigger: boolean
  output_folder: string
}

/** The classic view's defaults (inventory §1.2). */
export const DATASET_DEFAULTS: DatasetForm = {
  folder: '',
  mode: 'person',
  style: 'concise',
  caption_format: 'flux',
  resolution: 1024,
  step: 64,
  square: false,
  fit: 'cover',
  pad_color: '#000000',
  centering_x: 'center',
  centering_y: 'center',
  fmt: 'png',
  jpg_quality: 95,
  model: '',
  quant: '4bit',
  max_tokens: 512,
  do_caption: true,
  upscale_model: '',
  trigger: '',
  prepend_trigger: true,
  output_folder: '',
}

type Options = [string, string][]

/** The classic view's options (value, label), in its order. */
export const OPTIONS = {
  mode: [
    ['person', 'Person (variable traits only)'],
    ['person_detail', 'Person — details (scars, moles, hair, facial hair…)'],
    ['style', 'Style (for a style LoRA — content only)'],
    ['architecture', 'Architecture'],
    ['landscape', 'Landscape'],
    ['generic', 'Generic'],
  ],
  style: [
    ['concise', 'Concise (factual, ~3-5 sentences)'],
    ['detailed', 'Detailed (long paragraph)'],
  ],
  caption_format: [
    ['flux', 'FLUX.2 (natural language)'],
    ['ideogram', 'Ideogram 4 (JSON)'],
    ['aitoolkit', 'ai-toolkit (JSON in .txt)'],
  ],
  resolution: [['768', '768'], ['1024', '1024'], ['1280', '1280'], ['1536', '1536']],
  step: [['16', '16'], ['32', '32'], ['64', '64']],
  square: [
    ['false', 'Buckets (keep aspect ratio)'],
    ['true', 'Square (crop to 1:1)'],
  ],
  crop_mode: [
    ['center', 'Centre (whole frame)'],
    ['auto', 'Auto (Florence-2 subject)'],
    ['manual', 'Manual (per-image crops)'],
  ],
  fit: [
    ['cover', 'Cover (crop to fill)'],
    ['contain', 'Contain (pad with colour)'],
  ],
  centering_x: [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']],
  centering_y: [['top', 'Top'], ['center', 'Centre'], ['bottom', 'Bottom']],
  fmt: [['png', 'PNG (lossless)'], ['jpg', 'JPG']],
  quant: [['4bit', '4-bit (saves VRAM)'], ['none', 'None (fp16)']],
} satisfies Record<string, Options>

/** Per run, not per preset: a preset never carries or overwrites these. */
const NOT_IN_PRESETS = ['folder', 'trigger', 'output_folder', 'crop_mode'] as const

/** `values` without the fields presets leave alone. */
export function presetValues(values: object): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values }
  for (const k of NOT_IN_PRESETS) delete out[k]
  return out
}

/**
 * The POST /api/process body: the form (without the export-only fields) plus
 * the folder's crop source and plan.
 */
export function toProcessRequest(form: DatasetForm, cropDoc: Pick<CropDoc, 'plan' | 'mode'>) {
  return {
    folder: form.folder,
    mode: form.mode,
    style: form.style,
    caption_format: form.caption_format,
    resolution: form.resolution,
    step: form.step,
    square: form.square,
    fit: form.fit,
    pad_color: form.pad_color,
    centering_x: form.centering_x,
    centering_y: form.centering_y,
    fmt: form.fmt,
    jpg_quality: form.jpg_quality,
    model: form.model,
    quant: form.quant,
    max_tokens: form.max_tokens,
    do_caption: form.do_caption,
    upscale_model: form.upscale_model,
    crop_mode: cropDoc.mode,
    crops: cropDoc.plan,
  }
}
