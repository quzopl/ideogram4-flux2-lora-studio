import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, ApiError } from './api'
import type { GpusResponse, GpuStatus, Settings, StoreModelsResponse } from './types'

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') })
}

/** Polls every second while any model is downloading, otherwise not at all. */
export function useStoreModels() {
  return useQuery({
    queryKey: ['store-models'],
    queryFn: () => api<StoreModelsResponse>('/api/store/models'),
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
 * ["store-models"], ["gpus"]) are refetched afterwards.
 */
export function useMutationWithToast<TVars = void, TData = unknown>(
  fn: (vars: TVars) => Promise<TData>,
  opts: { success?: string; invalidate?: QueryKey[] } = {},
) {
  const qc = useQueryClient()
  return useMutation<TData, Error, TVars>({
    mutationFn: fn,
    onSuccess: () => {
      if (opts.success) toast.success(opts.success)
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.detail : err.message)
    },
    onSettled: () =>
      Promise.all((opts.invalidate ?? []).map((queryKey) => qc.invalidateQueries({ queryKey }))),
  })
}
