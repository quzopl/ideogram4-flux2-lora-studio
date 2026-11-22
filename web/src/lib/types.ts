// Response shapes of the FastAPI backend, read from backend/*.py.

export type Role = 'vlm' | 'florence' | 'upscale'

/** GET /api/settings (backend/settings.py `defaults`). */
export interface Settings {
  version: number
  models_dir: string
  model_locations: Record<string, string>
  /** "auto", "cpu" or a card's UUID per role. */
  gpu: Record<Role, string>
  forms: Record<string, Record<string, unknown>>
  presets: Record<string, Record<string, Record<string, unknown>>>
}

/** One row of server.py `_gpu_cards`. VRAM is null when nvidia-smi did not report the card. */
export interface GpuCard {
  uuid: string
  /** e.g. "RTX 5080 · 16 GB" (· PCI xx when two cards share a name). */
  label: string
  /** Full name, e.g. "NVIDIA GeForce RTX 5080". */
  name: string
  total_bytes: number
  pci_bus: number
  selected: boolean
  vram_used_gb: number | null
  vram_total_gb: number | null
  /** Roles assigned to this card. */
  roles: Role[]
  /** Roles whose model is loaded on this card. */
  loaded: Role[]
}

/** GET /api/gpus. */
export interface GpusResponse {
  gpus: GpuCard[]
  selected: string | null
  roles: Record<Role, string>
}

/** GET /api/gpu and POST /api/unload (server.py `_gpu_status`). */
export interface GpuStatus {
  loaded: boolean
  model: string | null
  quant: string | null
  cuda: boolean
  upscale_loaded: boolean
  upscale_model: string
  upscale_device: string
  upscale_note: string
  gpu_label: string
  vram_used_gb?: number | null
  vram_total_gb?: number | null
  cards: GpuCard[]
}

/** A download job (backend/model_store.py `start_download`). */
export interface DownloadJob {
  id: string
  model_id: string
  label: string
  dest: string
  state: 'pending' | 'downloading' | 'done' | 'error' | 'cancelled'
  done_bytes: number
  total_bytes: number
  error: string
  path: string
}

/** One row of model_store.py `listing`. */
export interface StoreModel {
  id: string
  kind: Role
  label: string
  repo_id: string
  filename: string
  source: string
  path?: string
  scale?: number
  note?: string
  status: 'ready' | 'missing' | 'downloading'
  local_path: string | null
  download: DownloadJob | null
  /** Error of the latest download when it failed and the model is still missing. */
  last_error: string | null
}

/** GET /api/store/models. */
export interface StoreModelsResponse {
  models_dir: string
  models: StoreModel[]
}

/** GET /api/fs/list (server.py `api_fs_list`). `files` only with `files=weights`. */
export interface FsListing {
  /** Resolved absolute path. */
  path: string
  parent: string | null
  dirs: string[]
  is_model: boolean
  free_bytes: number
  writable: boolean
  files?: string[]
}

export type CropMode = 'center' | 'auto' | 'manual'

/** Source file name -> [x, y, w, h], integers in true source px (after EXIF). */
export type CropPlan = Record<string, [number, number, number, number]>

/** GET /api/crops (crop_store.load); `exists` is false only for a folder never saved. */
export interface CropDoc {
  plan: CropPlan
  mode: CropMode
  exists: boolean
}

/** GET /api/crop/auto/{id}. `error` carries a traceback. */
export interface CropAutoJob {
  state: string
  total: number
  processed: number
  current: string
  error: string
  crops: CropPlan
  skipped: string[]
}

/** One row of GET /api/job/{id} `results`. A failed file has `out_name: ""` and `[ERROR: …]` as caption. */
export interface DatasetResult {
  idx: number
  src_name: string
  out_name: string
  width: number
  height: number
  caption: string
  upscaled: boolean
  upscale_error: string
}

/** GET /api/job/{id} (a Dataset processing job). `error` carries a traceback. */
export interface DatasetJob {
  id: string
  state: string
  total: number
  processed: number
  current: string
  error: string
  /** The ProcessRequest the job runs with. */
  config: { caption_format?: string; mode?: string }
  results: DatasetResult[]
}
