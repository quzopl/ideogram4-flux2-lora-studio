/**
 * Saved as forms.prompts and in presets. The prompt text is not here: it
 * lives in promptRunStore, so it never reaches settings.json or an export.
 */
export interface PromptForm {
  action: 'expand' | 'refine'
  subject: string
  caption_format: string
  /** "" until GET /api/models gives its default. */
  model: string
  quant: string
  max_tokens: number
  elements_detail: string
  desc_detail: string
}

/** The classic view's defaults (inventory §1.1). */
export const PROMPT_DEFAULTS: PromptForm = {
  action: 'expand',
  subject: 'auto',
  caption_format: 'flux',
  model: '',
  quant: '4bit',
  max_tokens: 768,
  elements_detail: 'balanced',
  desc_detail: 'balanced',
}

type Options = [string, string][]

/** The classic view's options (value, label), in its order. */
export const OPTIONS = {
  action: [
    ['expand', 'Expand (from a short idea)'],
    ['refine', 'Refine (clean up an existing one)'],
  ],
  subject: [
    ['auto', 'Auto (detect from the text)'],
    ['person', 'Person / character'],
    ['product', 'Product / object'],
    ['landscape', 'Landscape / scene'],
    ['architecture', 'Architecture'],
  ],
  caption_format: [
    ['flux', 'FLUX.2 (natural language)'],
    ['ideogram', 'Ideogram 4 (JSON)'],
    ['aitoolkit', 'ai-toolkit (JSON)'],
  ],
  quant: [['4bit', '4-bit (saves VRAM)'], ['none', 'None (fp16)']],
  elements_detail: [
    ['few', 'Few (2–3)'],
    ['balanced', 'Balanced (per framework)'],
    ['detailed', 'Detailed (6–10)'],
    ['maximal', 'Maximal (10–16)'],
  ],
  desc_detail: [
    ['brief', 'Brief (15–30 words)'],
    ['balanced', 'Balanced'],
    ['rich', 'Rich (close to 60 words)'],
  ],
} satisfies Record<string, Options>

/** Ideogram and ai-toolkit give a v15 JSON prompt; FLUX.2 gives prose. */
export const isJsonFormat = (format: string) => format !== 'flux'

const FORMAT_NAME: Record<string, string> = {
  flux: 'FLUX.2',
  ideogram: 'Ideogram 4 (JSON)',
  aitoolkit: 'ai-toolkit (JSON)',
}

export function hintFor(action: PromptForm['action'], format: string) {
  const fmt = FORMAT_NAME[format] ?? FORMAT_NAME.flux
  return action === 'refine'
    ? `Paste a longer/existing prompt — the model will clean it up and adapt it to: ${fmt}.`
    : `Type a short idea and the model will expand it into a full prompt: ${fmt}.`
}

export function placeholderFor(action: PromptForm['action']) {
  return action === 'refine'
    ? 'e.g. woman, red hair, cafe, masterpiece, best quality, 8k, detailed'
    : 'e.g. a woman with red hair in a cafe'
}

/** The style presets (inventory §1.4): picking an option appends its instruction. */
export const STYLE_PRESETS: { label: string; options: string[]; guide: (v: string) => string }[] = [
  {
    label: 'Era…',
    options: [
      'Mesopotamia', 'Ancient Egypt', 'Ancient Rome', 'Medieval', 'Renaissance', 'Victorian (1890s)',
      'Roaring 1920s', '1950s Americana', '1970s', '1980s', '1990s', 'Cyberpunk near-future', 'Far future / sci-fi',
    ],
    guide: (v) =>
      `Time travel: keep the exact same composition, framing and element positions, but depict the scene as a period-accurate ${v} version — adjust clothing, technology, vehicles, architecture and materials to that era.`,
  },
  {
    label: 'Style…',
    options: [
      'Oil painting', 'Watercolor', 'Anime', 'Pixel art', 'Comic book', '3D render', 'Pencil sketch', 'Pop art',
      'Low-poly', 'Claymation',
    ],
    guide: (v) =>
      `Re-render the scene in this medium/style: ${v}. Keep the exact same composition and layout; only change the rendering style.`,
  },
  {
    label: 'Genre / mood…',
    options: [
      'Cyberpunk', 'Film noir', 'High fantasy', 'Post-apocalyptic', 'Vaporwave', 'Steampunk', 'Horror', 'Solarpunk',
      'Western', 'Fairy tale',
    ],
    guide: (v) =>
      `Re-theme the scene as ${v}. Keep the exact same composition and layout; restyle the content, lighting and mood to match the theme.`,
  },
]

/** As the classic `appendToInput`: after a blank line, or alone when the text is empty. */
export const appendInstruction = (text: string, instruction: string) =>
  (text.trim() ? `${text.trim()}\n\n` : '') + instruction

/** Only the form's own fields, from a saved preset (which may hold others). */
export function formValues(values: object): Partial<PromptForm> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(PROMPT_DEFAULTS)) if (k in values) out[k] = (values as Record<string, unknown>)[k]
  return out
}

/** The POST /api/prompt/jobs body. */
export function toJobBody(form: PromptForm, text: string) {
  return {
    text: text.trim(),
    action: form.action,
    subject: form.subject,
    caption_format: form.caption_format,
    model: form.model,
    quant: form.quant,
    max_tokens: form.max_tokens,
    elements_detail: form.elements_detail,
    desc_detail: form.desc_detail,
  }
}
