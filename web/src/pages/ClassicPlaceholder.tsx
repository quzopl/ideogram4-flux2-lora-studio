import { ExternalLink, History } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** A view not ported to v2 yet: points at the same view in the classic UI. */
export function ClassicPlaceholder({ view, title }: { view: string; title: string }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-8 pt-24 text-center">
      <div className="mb-6 grid size-14 place-items-center rounded-2xl bg-linear-to-br from-accent-from/20 to-accent-to/10 ring-1 ring-white/10">
        <History className="size-6 text-accent-to" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-text-dim">
        This view has not moved to the new studio yet. It works as before in the classic UI.
      </p>
      <Button asChild size="lg" className="mt-8 px-4">
        <a href={`/legacy/#${view}`}>
          Open in classic UI
          <ExternalLink data-icon="inline-end" />
        </a>
      </Button>
    </div>
  )
}
