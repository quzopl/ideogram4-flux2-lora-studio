import { useSyncExternalStore } from 'react'

/**
 * This tab's "Auto-crop all" job: its id, the folder it ran on and whether its
 * boxes were merged into that folder's plan. Outlives the view (and a reload),
 * so a job that finishes while the view is closed is merged on return, once.
 */
export interface CropAutoRun {
  id: string
  folder: string
  merged: boolean
}

const KEY = 'flux.dataset.cropAuto'

function load(): CropAutoRun | null {
  try {
    const r = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as CropAutoRun | null
    if (!r || typeof r.id !== 'string' || typeof r.folder !== 'string') return null
    return { id: r.id, folder: r.folder, merged: r.merged === true }
  } catch {
    return null
  }
}

let current: CropAutoRun | null = load()
const listeners = new Set<() => void>()

function update(next: CropAutoRun | null) {
  current = next
  listeners.forEach((l) => l())
  try {
    if (next) sessionStorage.setItem(KEY, JSON.stringify(next))
    else sessionStorage.removeItem(KEY)
  } catch {
    // Storage blocked: the job lives until the tab closes.
  }
}

export function startCropAuto(id: string, folder: string) {
  update({ id, folder, merged: false })
}

/** Marks the job merged; false if it already was (or is no longer the job). */
export function markCropAutoMerged(id: string) {
  if (!current || current.id !== id || current.merged) return false
  update({ ...current, merged: true })
  return true
}

/** Forgets the job (it is gone). */
export function clearCropAuto() {
  update(null)
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useCropAuto() {
  return useSyncExternalStore(subscribe, () => current)
}
