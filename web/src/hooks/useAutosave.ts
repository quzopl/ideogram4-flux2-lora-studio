import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { useSettings } from '@/lib/queries'
import type { Settings } from '@/lib/types'

/**
 * Debounced `PUT /api/settings/forms/{view}` of `value` while `enabled`. The
 * value seen when saving becomes enabled is the baseline and is not written;
 * a save still pending on unmount is sent right away.
 */
function useFormSaver<T>(view: string, value: T, delayMs: number, enabled: boolean) {
  const qc = useQueryClient()
  const json = JSON.stringify(value)
  const saved = useRef<string | null>(null)
  const pending = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (saved.current === null) {
      saved.current = json
      return
    }
    if (json === saved.current) {
      pending.current = null // an edit reverted within the delay: nothing to flush
      return
    }
    const save = () => {
      pending.current = null
      saved.current = json
      api<Settings>(`/api/settings/forms/${encodeURIComponent(view)}`, {
        method: 'PUT',
        json: { values: JSON.parse(json) },
      })
        .then((doc) => qc.setQueryData(['settings'], doc))
        .catch((err) => toast.error(err instanceof ApiError ? err.detail : String(err)))
    }
    pending.current = save
    const timer = setTimeout(save, delayMs)
    return () => clearTimeout(timer)
  }, [view, json, delayMs, enabled, qc])

  // Flush on unmount so leaving a view within the delay loses nothing.
  useEffect(() => () => pending.current?.(), [])
}

/** Saves `value` as the view's form `delayMs` after it last changed (not on mount). */
export function useAutosave<T>(view: string, value: T, delayMs = 500): void {
  useFormSaver(view, value, delayMs, true)
}

/**
 * Form state for a view: starts at `defaults`, then once the settings arrive
 * becomes `{...defaults, ...settings.forms[view]}` (once; later refetches do
 * not overwrite edits) and autosaves from then on. Do not combine with
 * useAutosave for the same view.
 */
export function useSavedForm<T extends object>(
  view: string,
  defaults: T,
): [T, Dispatch<SetStateAction<T>>, boolean] {
  const settings = useSettings()
  const [form, setForm] = useState<T>(defaults)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (loaded || !settings.data) return
    setForm((f) => ({ ...f, ...(settings.data.forms[view] as Partial<T> | undefined) }))
    setLoaded(true)
  }, [loaded, settings.data, view])

  useFormSaver(view, form, 500, loaded)
  return [form, setForm, loaded]
}
