// Pure text helpers of the ComfyUI page. No imports: the unit spec loads this file in Node.

/** A job's progress (GET /api/comfy/job/{id} `progress`); `speed` in it/s, `eta` in seconds. */
export interface JobProgressInfo {
  value?: number
  max?: number
  speed?: number
  eta?: number
}

/** Seconds as "Ns", "Mm SSs" or "Hh MMm" (classic fmtEta). */
export function fmtEta(sec: number): string {
  sec = Math.round(sec)
  if (sec < 60) return sec + 's'
  const m = Math.floor(sec / 60), r = sec % 60
  if (m < 60) return m + 'm ' + (r < 10 ? '0' : '') + r + 's'
  const h = Math.floor(m / 60), mm = m % 60
  return h + 'h ' + (mm < 10 ? '0' : '') + mm + 'm'
}

/** "  ·  v/m  ·  X.XX it/s  ·  ~ETA left", each part only when known (classic fmtProgress). */
export function fmtProgress(p: JobProgressInfo | null | undefined): string {
  if (!p) return ''
  const parts: string[] = []
  if (p.max) parts.push(`${p.value || 0}/${p.max}`)
  if (p.speed && p.speed > 0) parts.push(`${p.speed.toFixed(2)} it/s`)
  if (p.eta && p.eta > 0) parts.push(`~${fmtEta(p.eta)} left`)
  return parts.length ? '  ·  ' + parts.join('  ·  ') : ''
}

const PREVIEW_CHARS = 70

/** A gallery card's prompt: its first 70 characters (then "…"), or the file name when there is none. */
export function promptPreview(prompt: string, filename: string): string {
  if (!prompt) return filename
  return prompt.length > PREVIEW_CHARS ? prompt.slice(0, PREVIEW_CHARS) + '…' : prompt
}

const SOURCES: Record<string, string> = { lora_test: 'LoRA test', editor: 'Editor', ideogram: 'Ideogram' }

/** What made a gallery image, as shown on its badge (an unknown source as it is). */
export const sourceLabel = (source: string) => SOURCES[source] ?? source

/** The name a downloaded gallery image is saved under: its ComfyUI file name, ".png" added when it has no extension. */
export function downloadName(item: { id: string; filename: string }): string {
  const name = item.filename || item.id || 'image'
  return /\.\w+$/.test(item.filename) ? name : name + '.png'
}

/** Where a gallery image opens (the gallery tab with its dialog), as a router location. */
export const galleryLink = (id: string) => ({ search: `?${new URLSearchParams({ tab: 'gallery', image: id })}` })
