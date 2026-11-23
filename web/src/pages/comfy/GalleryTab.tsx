import { Images, RefreshCw, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { useMutationWithToast } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { promptPreview } from './format'
import { GalleryDialog, SourceBadge } from './GalleryDialog'
import { deleteGalleryItem, errorText, GALLERY_KEY, useGallery, type GalleryItem } from './queries'

/** Cards shown at first, and added by each "Show more". */
const PAGE = 48
const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

/**
 * Everything the ComfyUI jobs saved, newest first, 48 at a time. A card opens
 * the image's dialog, which follows `?image=<id>` (so a link can open it).
 */
export function GalleryTab() {
  const gallery = useGallery()
  const items = gallery.data ?? []
  const [shown, setShown] = useState(PAGE)
  const [asking, setAsking] = useState<GalleryItem | null>(null)
  const [params, setParams] = useSearchParams()

  // Looked up in the whole gallery, not the cards shown: a link may open any image.
  const imageId = params.get('image')
  const index = imageId ? items.findIndex((i) => i.id === imageId) : -1
  const item = index >= 0 ? items[index] : null
  // The dialog keeps showing the last image while it closes.
  const [kept, setKept] = useState<GalleryItem | null>(null)
  if (item && item !== kept) setKept(item)

  const openImage = (id: string | null, replace = false) =>
    setParams((p) => {
      const next = new URLSearchParams(p)
      if (id) next.set('image', id)
      else next.delete('image')
      return next
    }, { replace })

  const del = useMutationWithToast((id: string) => deleteGalleryItem(id), { invalidate: [GALLERY_KEY] })

  return (
    <section aria-labelledby="comfy-gallery-title" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="comfy-gallery-title" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Images className="size-5 text-accent-from" />
          Gallery
          {gallery.data && <span className="font-mono text-sm font-normal text-text-dim tabular-nums">({items.length})</span>}
        </h2>
        <Button size="sm" variant="outline" disabled={gallery.isFetching} onClick={() => gallery.refetch()}>
          <RefreshCw className={cn(gallery.isFetching && 'animate-spin motion-reduce:animate-none')} />
          Refresh
        </Button>
      </div>

      {gallery.isError ? (
        <p role="alert" className="text-sm text-danger">Could not load the gallery: {errorText(gallery.error)}</p>
      ) : gallery.isPending ? (
        <p className="text-sm text-text-dim">Loading the gallery…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-dim">
          No images yet. What the LoRA test, the batch, the workflow editor and Ideogram renders make lands here.
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
          <AnimatePresence>
            {items.slice(0, shown).map((im, i) => (
              <motion.li
                key={im.id}
                data-testid="gallery-card"
                layout="position"
                initial={{ opacity: 0, y: 10, scale: 0.97 }}
                // A cascade per page: each "Show more" starts it again.
                animate={{ opacity: 1, y: 0, scale: 1, transition: { ...SPRING, delay: Math.min(i % PAGE, 16) * 0.025 } }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={SPRING}
                className="group relative flex flex-col overflow-hidden rounded-lg border border-line bg-bg/60"
              >
                <button
                  type="button"
                  aria-label={`Open image (seed ${im.seed})`}
                  title="Click to see the prompt"
                  onClick={() => openImage(im.id)}
                  className="block outline-none focus-visible:shadow-glow"
                >
                  <img src={im.url} alt="" loading="lazy" className="aspect-square w-full bg-bg object-contain" />
                </button>
                <Button
                  size="icon-xs"
                  variant="outline"
                  aria-label="Delete image"
                  title="Delete"
                  onClick={() => setAsking(im)}
                  className="absolute top-2 right-2 bg-surface/80 backdrop-blur hover:text-danger"
                >
                  <X />
                </Button>
                <div className="flex flex-col gap-1.5 px-2.5 py-2">
                  <p className="truncate text-xs text-text" title={im.prompt}>{promptPreview(im.prompt, im.filename)}</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-text-dim tabular-nums">seed: {im.seed}</span>
                    <SourceBadge source={im.source} />
                  </div>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {items.length > shown && (
        <Button variant="outline" className="self-center" onClick={() => setShown((n) => n + PAGE)}>
          Show more
          <span className="font-mono text-text-dim tabular-nums">({items.length - shown} left)</span>
        </Button>
      )}

      <GalleryDialog
        item={item ?? kept}
        open={item !== null}
        onClose={() => openImage(null)}
        onPrev={index > 0 ? () => openImage(items[index - 1].id, true) : null}
        onNext={index >= 0 && index < items.length - 1 ? () => openImage(items[index + 1].id, true) : null}
        onDelete={(im) => {
          openImage(null)
          del.mutate(im.id)
        }}
      />
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(o) => !o && setAsking(null)}
        title="Delete this image?"
        action="Delete"
        destructive
        onConfirm={() => asking && del.mutate(asking.id)}
      >
        The PNG and its metadata are removed from the gallery folder.
      </ConfirmDialog>
    </section>
  )
}
