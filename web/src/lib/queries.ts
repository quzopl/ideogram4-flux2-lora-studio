import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, ApiError } from './api'
import type { GpusResponse, GpuStatus, Settings, StoreModelsResponse } from './types'

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') })
}

/**
 * Polls every second while any model is downloading, otherwise not at all.
 * A download that failed since the previous fetch toasts its error once (here
 * in the shared fetch, not per component using the hook).
 */
export function useStoreModels() {
  const qc = useQueryClient()
  return useQuery({
    queryKey: ['store-models'],
    queryFn: async () => {
      const prev = qc.getQueryData<StoreModelsResponse>(['store-models'])
      const next = await api<StoreModelsResponse>('/api/store/models')
      const wasDownloading = new Set(prev?.models.filter((m) => m.status === 'downloading').map((m) => m.id))
      for (const m of next.models) {
        if (wasDownloading.has(m.id) && m.status !== 'downloading' && m.last_error) {
          toast.error(`${m.label}: download failed — ${m.last_error}`)
        }
      }
      return next
    },
    refetchInterval: (query) =>
      query.state.data?.models.some((m) => m.status === 'downloading') ? 1000 : false,
  })
}

export function useGpus() {
  return useQuery({
    queryKey: ['gpus'],
    queryFn: () => api<GpusResponse>('/api/gpus'),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
  })
}

export function useGpuStatus() {
  return useQuery({ queryKey: ['gpu'], queryFn: () => api<GpuStatus>('/api/gpu') })
}

/**
 * A mutation that toasts: `success` (if given) when it resolves, the error's
 * `detail` when it fails. Either way the `invalidate` keys (e.g. ["settings"],
 * ["store-models"], ["gpus"]) are refetched afterwards. `onSuccess` runs even
 * if the component unmounted meanwhile (unlike a callback passed to `mutate`).
 */
export function useMutationWithToast<TVars = void, TData = unknown>(
  fn: (vars: TVars) => Promise<TData>,
  opts: { success?: string; invalidate?: QueryKey[]; onSuccess?: (data: TData, vars: TVars) => void } = {},
) {
  const qc = useQueryClient()
  return useMutation<TData, Error, TVars>({
    mutationFn: fn,
    onSuccess: (data, vars) => {
      if (opts.success) toast.success(opts.success)
      opts.onSuccess?.(data, vars)
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.detail : err.message)
    },
    onSettled: () =>
      Promise.all((opts.invalidate ?? []).map((queryKey) => qc.invalidateQueries({ queryKey }))),
  })
}

/** PATCH the models folder (an absolute path; the backend creates it). */
export function useSetModelsDir() {
  return useMutationWithToast(
    (models_dir: string) => api<Settings>('/api/settings', { method: 'PATCH', json: { models_dir } }),
    { success: 'Models folder saved', invalidate: [['settings'], ['store-models']] },
  )
}
