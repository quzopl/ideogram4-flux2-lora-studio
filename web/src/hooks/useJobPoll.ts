import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'

const gone = (e: unknown) => e instanceof ApiError && e.status === 404

/**
 * Polls `url` (a job) every `intervalMs` while it is not null. A transient
 * error keeps polling (the last data stays); a `terminal` state or a 404 stops
 * it. `isGone` is the 404 (e.g. the server was restarted). With `poll: false`
 * it only reads what another mount of the same key polls (one poll stream per job).
 */
export function useJobPoll<T extends { state: string }>(
  key: unknown[],
  url: string | null,
  opts: { intervalMs?: number; terminal?: string[]; poll?: boolean } = {},
) {
  const { intervalMs = 700, terminal = ['done', 'error'], poll = true } = opts
  const job = useQuery({
    queryKey: key,
    queryFn: () => api<T>(url!),
    enabled: url !== null && poll,
    retry: (count, err) => !gone(err) && count < 1,
    refetchInterval: (q) =>
      !poll || gone(q.state.error) || terminal.includes(q.state.data?.state ?? '') ? false : intervalMs,
  })
  const isGone = url !== null && job.isError && gone(job.error)
  return {
    data: url !== null ? job.data : undefined,
    isGone,
    running: url !== null && !isGone && !terminal.includes(job.data?.state ?? ''),
  }
}
