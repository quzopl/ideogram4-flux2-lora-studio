import { useQuery } from '@tanstack/react-query'
import { Copy, Download, LayoutTemplate, RefreshCw, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, ApiError } from '@/lib/api'
import { useHandOffToBbox } from '@/lib/bboxHandoff'
import { copyText } from '@/lib/clipboard'
import { useMutationWithToast } from '@/lib/queries'
import { cn } from '@/lib/utils'

type Category = 'all' | 'flux' | 'ideogram'

/** A row of GET /api/prompts/library (newest first). */
interface LibraryPrompt {
  id: number
  category: 'flux' | 'ideogram'
  action: string
  input_text: string
  prompt: string
  /** Unix seconds. */
  created: number
}

const TABS: [Category, string][] = [['all', 'All'], ['flux', 'FLUX.2'], ['ideogram', 'Ideogram (JSON)']]

const query = (category: Category) => new URLSearchParams({ category }).toString()

/** Every saved prompt: category tabs (server side), a text filter (client side), copy, open on canvas, delete. */
export function LibraryPanel() {
  const [category, setCategory] = useState<Category>('all')
  const [filter, setFilter] = useState('')
  // Kept after the dialog closes, so its title does not change while it animates out.
  const [deleting, setDeleting] = useState<LibraryPrompt | null>(null)
  const [confirming, setConfirming] = useState(false)

  const list = useQuery({
    queryKey: ['prompt-library', category],
    queryFn: () => api<{ prompts: LibraryPrompt[] }>(`/api/prompts/library?${query(category)}`),
  })
  const remove = useMutationWithToast(
    (id: number) => api(`/api/prompts/library/${id}`, { method: 'DELETE' }),
    { success: 'Prompt deleted.', invalidate: [['prompt-library']] },
  )

  const all = list.data?.prompts ?? []
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? all.filter((p) => p.prompt.toLowerCase().includes(needle) || p.input_text.toLowerCase().includes(needle))
    : all

  return (
    <section aria-label="Prompt library" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Prompt library</h2>
        {list.data && (
          <span className="text-xs text-text-dim">Items: {needle ? `${shown.length} of ${all.length}` : all.length}</span>
        )}
      </div>
      <p className="-mt-2 text-xs text-text-dim">Every generated prompt is saved here automatically (SQLite).</p>

      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Category" className="flex gap-1 rounded-xl border border-line bg-bg/60 p-1">
          {TABS.map(([v, text]) => {
            const active = v === category
            return (
              <button
                key={v}
                type="button"
                aria-pressed={active}
                onClick={() => setCategory(v)}
                className={cn(
                  'relative rounded-lg px-3 py-1.5 text-sm transition-colors outline-none focus-visible:shadow-glow',
                  active ? 'text-white' : 'text-text-dim hover:text-text',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="library-category"
                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                    className="absolute inset-0 rounded-lg bg-linear-to-r from-accent-from to-accent-to shadow-[0_0_16px_rgba(139,92,246,0.35)]"
                  />
                )}
                <span className="relative">{text}</span>
              </button>
            )
          })}
        </div>
        <Input
          aria-label="Filter…"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-56 max-w-full"
        />
        <div className="ml-auto flex gap-2">
          <a
            href={`/api/prompts/library/export?${query(category)}`}
            download
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <Download />
            Export .sql
          </a>
          <Button type="button" variant="outline" size="sm" onClick={() => list.refetch()}>
            <RefreshCw className={cn(list.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {list.isError ? (
        <p role="alert" className="rounded-lg border border-danger/25 bg-danger/[0.06] px-3 py-2 text-sm text-danger">
          Library load error: {list.error instanceof ApiError ? list.error.detail : list.error.message}
        </p>
      ) : list.data && all.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-dim">The library is empty — generate your first prompt above.</p>
      ) : list.data && shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-dim">No prompts match the filter.</p>
      ) : (
        <ul key={category} className="flex max-h-[480px] flex-col gap-2 overflow-y-auto pr-1">
          <AnimatePresence>
            {shown.map((p, i) => (
              <LibraryRow
                key={p.id}
                prompt={p}
                index={i}
                onDelete={() => {
                  setDeleting(p)
                  setConfirming(true)
                }}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete prompt #${deleting?.id ?? ''}?`}
        action="Delete"
        destructive
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      >
        This cannot be undone.
      </ConfirmDialog>
    </section>
  )
}

function LibraryRow({ prompt: p, index, onDelete }: { prompt: LibraryPrompt; index: number; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const handOffToBbox = useHandOffToBbox()
  const ideogram = p.category === 'ideogram'

  const copy = () =>
    copyText(p.prompt).then(
      () => toast.success('Copied to clipboard.'),
      (e: Error) => toast.error(e.message),
    )

  return (
    <motion.li
      data-testid="library-row"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { delay: Math.min(index, 12) * 0.03, duration: 0.2 } }}
      exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
      className="flex gap-3 rounded-lg border border-line bg-bg/40 p-3"
    >
      <span
        className={cn(
          'h-fit shrink-0 rounded-md px-2 py-0.5 text-[0.7rem] font-medium',
          ideogram ? 'bg-accent-from/15 text-accent-from' : 'bg-accent-to/10 text-accent-to',
        )}
      >
        {ideogram ? 'Ideogram JSON' : 'FLUX.2'}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          title="Click to expand/collapse"
          onClick={() => setExpanded((x) => !x)}
          className={cn(
            'rounded text-left text-sm break-words whitespace-pre-wrap outline-none focus-visible:shadow-glow',
            ideogram && 'font-mono text-xs',
            !expanded && 'line-clamp-3',
          )}
        >
          {p.prompt}
        </button>
        <p className="text-xs text-text-dim">
          #{p.id} · {new Date(p.created * 1000).toLocaleString()}
          {p.input_text && ` · "${p.input_text.slice(0, 60)}"`}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-start">
        <Button type="button" variant="outline" size="xs" onClick={copy}>
          <Copy />
          Copy
        </Button>
        {ideogram && (
          <Button type="button" variant="outline" size="xs" onClick={() => handOffToBbox(p.prompt)}>
            <LayoutTemplate />
            Open on canvas
          </Button>
        )}
        <Button type="button" variant="ghost" size="xs" onClick={onDelete} className="text-danger hover:text-danger">
          <Trash2 />
          Delete
        </Button>
      </div>
    </motion.li>
  )
}
