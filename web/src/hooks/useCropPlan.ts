import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import type { CropDoc, CropMode, CropPlan } from '@/lib/types'

type Doc = Pick<CropDoc, 'plan' | 'mode'>

const MODES: CropMode[] = ['center', 'auto', 'manual']
const DEBOUNCE_MS = 300
const keyOf = (folder: string) => ['crops', folder]

/**
 * The classic UI's `localStorage["cropPlan:" + folder]`: `{plan, mode}`, or a
 * bare plan from before the mode was stored. Same load rules as
 * crop_editor.js: no mode but some crops means "manual".
 */
function readLegacy(folder: string): Doc | null {
  let rec: unknown
  try {
    rec = JSON.parse(localStorage.getItem(`cropPlan:${folder}`) ?? 'null')
  } catch {
    return null
  }
  if (!rec || typeof rec !== 'object') return null
  const r = rec as { plan?: unknown; mode?: unknown }
  const plan = (r.plan && typeof r.plan === 'object' ? r.plan : rec) as CropPlan
  const mode = MODES.includes(r.mode as CropMode) ? (r.mode as CropMode) : Object.keys(plan).length ? 'manual' : 'center'
  return { plan, mode }
}

async function load(folder: string): Promise<Doc> {
  const doc = await api<CropDoc>(`/api/crops?${new URLSearchParams({ folder })}`)
  if (doc.exists) return { plan: doc.plan, mode: doc.mode }
  const legacy = readLegacy(folder)
  if (!legacy) return { plan: {}, mode: 'center' }
  // Adopted once: from now on the server copy exists. The classic entry stays.
  try {
    await api('/api/crops', { method: 'PUT', json: { folder, ...legacy } })
  } catch (e) {
    toast.error(`Classic crop plan not imported: ${e instanceof ApiError ? e.detail : String(e)}`)
    return { plan: {}, mode: 'center' }
  }
  return legacy
}

// Shared by every hook instance (the page and the editor dialog edit one plan):
// the pending debounce per folder, and a queue so an older PUT never lands last.
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const queues = new Map<string, Promise<unknown>>()

function put(qc: QueryClient, folder: string) {
  const prev = queues.get(folder) ?? Promise.resolve()
  const next = prev.then(async () => {
    // The latest state when this PUT goes out, not when it was queued.
    const doc = qc.getQueryData<Doc>(keyOf(folder))
    if (!doc) return
    try {
      await api('/api/crops', { method: 'PUT', json: { folder, plan: doc.plan, mode: doc.mode } })
    } catch (e) {
      toast.error(`Crop plan not saved: ${e instanceof ApiError ? e.detail : String(e)}`)
    }
  })
  queues.set(folder, next)
}

function schedule(qc: QueryClient, folder: string) {
  clearTimeout(timers.get(folder))
  timers.set(
    folder,
    setTimeout(() => {
      timers.delete(folder)
      put(qc, folder)
    }, DEBOUNCE_MS),
  )
}

/** Sends a pending save now (a closing dialog must not lose its last edit). */
function flush(qc: QueryClient, folder: string) {
  const t = timers.get(folder)
  if (t === undefined) return
  clearTimeout(t)
  timers.delete(folder)
  put(qc, folder)
}

/**
 * The crop plan and crop source (`mode`) of a folder, stored on the server
 * (`/api/crops`); edits are saved 300 ms after the last one. A folder the
 * server has nothing for adopts the classic UI's localStorage plan once.
 * Mutators are no-ops until `loaded`, so nothing is written before that check.
 */
export function useCropPlan(folder: string | null) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: keyOf(folder ?? ''),
    queryFn: () => load(folder!),
    enabled: folder !== null && folder !== '',
    // This hook owns the data once loaded; a refetch would drop unsaved edits.
    staleTime: Infinity,
  })

  useEffect(() => {
    if (!folder) return
    return () => flush(qc, folder)
  }, [qc, folder])

  const update = useCallback(
    (fn: (d: Doc) => Doc) => {
      if (!folder) return
      const cur = qc.getQueryData<Doc>(keyOf(folder))
      if (!cur) return
      qc.setQueryData<Doc>(keyOf(folder), fn(cur))
      schedule(qc, folder)
    },
    [qc, folder],
  )

  const set = useCallback(
    (name: string, box: CropPlan[string]) => update((d) => ({ ...d, plan: { ...d.plan, [name]: box } })),
    [update],
  )
  const merge = useCallback((boxes: CropPlan) => update((d) => ({ ...d, plan: { ...d.plan, ...boxes } })), [update])
  const clear = useCallback(() => update((d) => ({ ...d, plan: {} })), [update])
  const setMode = useCallback((mode: CropMode) => update((d) => ({ ...d, mode })), [update])

  return {
    plan: query.data?.plan ?? {},
    mode: query.data?.mode ?? 'center',
    loaded: query.isSuccess,
    set,
    merge,
    clear,
    setMode,
  }
}
