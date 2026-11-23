import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { V15Finding } from '@/components/V15Findings'
import { useDebounced } from '@/hooks/useDebounced'
import { api } from '@/lib/api'

/**
 * The server's v15 lint of the canvas JSON, 400 ms after the last change. The
 * side panel shows it and the Render card is gated on it: one query (one key)
 * for both, so they always agree. `checking` is true until the answer belongs
 * to `json` itself, so the gate never passes on an older JSON's answer.
 */
export function useBboxLint(json: string) {
  const settled = useDebounced(json, 400)
  // Keyed by the JSON, so an older answer never overwrites a newer one.
  const query = useQuery({
    queryKey: ['lint', settled],
    queryFn: () => api<{ warnings: V15Finding[] }>('/api/prompts/lint', { method: 'POST', json: { prompt: settled } }),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  })
  // No answer for this very JSON yet: still typing (not settled), in flight
  // (only the previous JSON's answer is shown) or never answered.
  const checking = settled !== json || (!query.isError && (query.isPlaceholderData || query.data === undefined))
  return { ...query, checking }
}
