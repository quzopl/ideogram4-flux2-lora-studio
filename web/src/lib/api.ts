/** An HTTP error from the backend; `detail` is ready to show to the user. */
export class ApiError extends Error {
  status: number
  detail: string

  constructor(status: number, detail: string) {
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/** FastAPI errors: `{"detail": "..."}`, or a 422 with `{"detail": [{"msg": ...}]}`. */
export function detailOf(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d as { msg?: unknown })?.msg).filter((m) => typeof m === 'string')
    if (msgs.length) return msgs.join('; ')
  }
  return fallback
}

/** fetch() against the backend. `json` becomes the request body (with its Content-Type). */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const headers = new Headers(rest.headers)
  if (json !== undefined) headers.set('Content-Type', 'application/json')
  const res = await fetch(path, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) throw new ApiError(res.status, detailOf(body, `${res.status} ${res.statusText}`.trim()))
  return body as T
}
