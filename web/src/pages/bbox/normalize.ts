import { api, ApiError } from '@/lib/api'

/** POST /api/ideogram/normalize: any pasted prompt JSON as a v15 prompt (a JSON string). */
export interface Normalized {
  prompt: string
  /** The input had the pre-v15 style_description with content, which was dropped. */
  legacy_style: boolean
}

export const normalizePrompt = (text: string) =>
  api<Normalized>('/api/ideogram/normalize', { method: 'POST', json: { text } })

export const LEGACY_WARNING =
  'Loaded the OLD format with style_description — those fields do not exist in v15 and were dropped; rewrite the style as prose into the HLD or background.'

export const errorText = (e: Error) => (e instanceof ApiError ? e.detail : e.message)
