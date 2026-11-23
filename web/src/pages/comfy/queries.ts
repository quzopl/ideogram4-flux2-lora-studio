import { useQuery, type QueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'

/**
 * The active node mapping (comfy_workflows.autodetect_mapping), edited by the
 * user as free JSON: any key may be missing or of another type.
 */
export type Mapping = Record<string, unknown>

/** GET /api/comfy/config (the workflow itself is not sent). */
export interface ComfyConfig {
  url: string
  has_workflow: boolean
  workflow_node_count: number
  mapping: Mapping | null
}

/** POST /api/comfy/workflow. */
export interface WorkflowUpload {
  node_count: number
  mapping: Mapping
  source: 'png' | 'json'
  current_prompt: string
}

/** POST /api/comfy/test; `stats` is ComfyUI's /system_stats. */
export interface ConnectionTest {
  ok: boolean
  url: string
  stats: { system?: { comfyui_version?: string; os?: string } }
}

export const CONFIG_KEY = ['comfy-config']
const MAPPINGS_KEY = ['comfy-mappings']

/** Shared with Settings (its ComfyUI URL field reads `.url` from the same query). */
export const fetchComfyConfig = () => api<ComfyConfig>('/api/comfy/config')

export function useComfyConfig() {
  return useQuery({ queryKey: CONFIG_KEY, queryFn: fetchComfyConfig })
}

/** Writes part of the config into the cache now; a refetch confirms it. */
export function patchConfig(qc: QueryClient, patch: Partial<ComfyConfig>) {
  qc.setQueryData<ComfyConfig>(CONFIG_KEY, (c) => (c ? { ...c, ...patch } : c))
  return qc.invalidateQueries({ queryKey: CONFIG_KEY })
}

/** Number of LoRA loader slots in a mapping (0 when `lora_nodes` is not a list). */
export function loraSlots(m: Mapping | null | undefined) {
  const nodes = m?.lora_nodes
  return Array.isArray(nodes) ? nodes.length : 0
}

// ---- Named mappings (.work/comfy_mappings.json) ---- //

type Items = Record<string, Mapping>

export function useMappings() {
  return useQuery({
    queryKey: MAPPINGS_KEY,
    queryFn: () => api<{ items: Items }>('/api/comfy/mappings').then((r) => r.items),
  })
}

const storeMappings = (qc: QueryClient, r: { items: Items }) => qc.setQueryData(MAPPINGS_KEY, r.items)

export const saveNamedMapping = (qc: QueryClient, name: string, value: Mapping) =>
  api<{ items: Items }>('/api/comfy/mappings', { method: 'POST', json: { name, value } }).then((r) =>
    storeMappings(qc, r))

export const deleteNamedMapping = (qc: QueryClient, name: string) =>
  api<{ items: Items }>(`/api/comfy/mappings/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
    storeMappings(qc, r))

/** Makes `mapping` the active one (the workflow must be uploaded). */
export const activateMapping = (qc: QueryClient, mapping: Mapping) =>
  api<{ mapping: Mapping }>('/api/comfy/mapping', { method: 'POST', json: { mapping } }).then((r) =>
    patchConfig(qc, { mapping: r.mapping }))

/** What to show for a failed call: the backend's `detail`, else the message. */
export const errorText = (e: unknown) => (e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e))

// ---- Gallery (.work/comfy_gallery: <id>.png + <id>.json) ---- //

/** What made a gallery image (items older than the field come from the LoRA test). */
export type GallerySource = 'lora_test' | 'editor' | 'ideogram'

/** A gallery image's sidecar meta (also a job's `images` entry). */
export interface GalleryItem {
  id: string
  url: string
  /** ComfyUI's own file name (not unique). */
  filename: string
  /** Missing on an item written without one. */
  seed?: number | null
  prompt: string
  /** LoRA names (an old item may hold `{lora}` objects); empty names are unused slots. */
  loras: unknown[]
  ts: number
  source: GallerySource | string
  width?: number
  height?: number
}

export const GALLERY_KEY = ['comfy-gallery']

/** Newest first (the server sorts). */
export function useGallery() {
  return useQuery({
    queryKey: GALLERY_KEY,
    queryFn: () => api<{ items: GalleryItem[] }>('/api/comfy/gallery').then((r) => r.items),
  })
}

export const deleteGalleryItem = (id: string) =>
  api<{ ok: boolean }>(`/api/comfy/gallery/${encodeURIComponent(id)}`, { method: 'DELETE' })

// ---- LoRA list (ComfyUI's /object_info) and the prompt library (.work/comfy_prompts.json) ---- //

/**
 * GET /api/comfy/loras, asked on the first entry, then kept (each ask makes
 * the backend fetch ComfyUI's whole /object_info): the refresh button and a
 * changed server URL ask again. Cached as the server sends it: the bbox render
 * reads the same key. ComfyUI down is a 502, shown at once (no retry).
 */
export function useComfyLoras() {
  return useQuery({
    queryKey: ['comfy-loras'],
    queryFn: () => api<{ loras: string[] }>('/api/comfy/loras'),
    staleTime: Infinity,
    retry: false,
  })
}

type Prompts = Record<string, string>
const PROMPTS_KEY = ['comfy-prompts']

export function usePrompts() {
  return useQuery({
    queryKey: PROMPTS_KEY,
    queryFn: () => api<{ items: Prompts }>('/api/comfy/prompts').then((r) => r.items),
  })
}

const storePrompts = (qc: QueryClient, r: { items: Prompts }) => qc.setQueryData(PROMPTS_KEY, r.items)

export const savePrompt = (qc: QueryClient, name: string, value: string) =>
  api<{ items: Prompts }>('/api/comfy/prompts', { method: 'POST', json: { name, value } }).then((r) => storePrompts(qc, r))

export const deletePrompt = (qc: QueryClient, name: string) =>
  api<{ items: Prompts }>(`/api/comfy/prompts/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
    storePrompts(qc, r))
