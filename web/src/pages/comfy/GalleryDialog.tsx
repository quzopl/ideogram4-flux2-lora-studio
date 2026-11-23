import { ChevronLeft, ChevronRight, Copy, Download, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { downloadName, sourceLabel } from './format'
import type { GalleryItem } from './queries'

/** Badge colours per source (an unknown one is plain). */
const SOURCE_TONE: Record<string, string> = {
  lora_test: 'border-accent-from/30 bg-accent-from/10 text-accent-from',
  editor: 'border-accent-to/30 bg-accent-to/10 text-accent-to',
  ideogram: 'border-warning/30 bg-warning/10 text-warning',
}

export function SourceBadge({ source }: { source: string }) {
  return (
    <span className={cn('rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap', SOURCE_TONE[source] ?? 'border-line text-text-dim')}>
      {sourceLabel(source)}
    </span>
  )
}

/** A LoRA entry's name: a string, or an old item's `{lora}` object. */
const loraName = (l: unknown) =>
  typeof l === 'string' ? l : l && typeof l === 'object' && typeof (l as { lora?: unknown }).lora === 'string'
    ? (l as { lora: string }).lora
    : JSON.stringify(l)

const tag = 'rounded-md border border-line bg-bg/60 px-2 py-0.5 font-mono text-[11px] text-text-dim tabular-nums'

interface GalleryDialogProps {
  /** The image shown; kept while the dialog closes. */
  item: GalleryItem | null
  open: boolean
  onClose: () => void
  /** The newer (←) and older (→) image, null at an end. */
  onPrev: (() => void) | null
  onNext: (() => void) | null
  onDelete: (item: GalleryItem) => void
}

/**
 * One gallery image large, with its seed, source, file, size, prompt (Copy)
 * and LoRAs; Download and Delete (asks first). ← and → step through the
 * gallery; Esc or the backdrop closes.
 */
export function GalleryDialog({ item, open, onClose, onPrev, onNext, onDelete }: GalleryDialogProps) {
  const [asking, setAsking] = useState(false)

  // On the document, not the dialog: at either end the focused arrow button is disabled, and focus leaves the dialog.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      // Not while the prompt field takes the arrows, nor behind the delete question.
      if (asking || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      const step = e.key === 'ArrowLeft' ? onPrev : e.key === 'ArrowRight' ? onNext : null
      if (!step) return
      e.preventDefault()
      step()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, asking, onPrev, onNext])

  const copy = () =>
    item && copyText(item.prompt).then(
      () => toast.success('Copied to clipboard.'),
      (e: Error) => toast.error(e.message),
    )

  const loras = (item?.loras ?? []).map(loraName).filter((n) => n.trim())
  const size = item?.width && item.height ? `${item.width}×${item.height}` : null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto border border-line bg-surface p-0 sm:max-w-6xl"
      >
        <DialogTitle className="sr-only">Gallery image</DialogTitle>
        {item && (
          <div className="grid min-w-0 md:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="relative flex min-h-48 items-center justify-center bg-bg/80 p-3 md:rounded-l-xl">
              <img
                key={item.id}
                src={item.url}
                alt={item.prompt || item.filename}
                className="max-h-[80dvh] w-full rounded-lg object-contain"
              />
              <NavButton side="left" label="Previous image" onClick={onPrev} />
              <NavButton side="right" label="Next image" onClick={onNext} />
            </div>

            <div className="flex min-w-0 flex-col gap-4 p-5 pt-10">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={tag}>seed: {item.seed ?? '—'}</span>
                <SourceBadge source={item.source} />
                {size && <span className={tag}>{size}</span>}
              </div>
              {item.filename && <p className="font-mono text-xs break-all text-text-dim">{item.filename}</p>}

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={`gal-prompt-${item.id}`} className="text-xs font-medium text-text-dim">Prompt</label>
                  <Button size="xs" variant="ghost" disabled={!item.prompt} onClick={copy}>
                    <Copy />
                    Copy
                  </Button>
                </div>
                <textarea
                  id={`gal-prompt-${item.id}`}
                  readOnly
                  rows={6}
                  value={item.prompt || '(no prompt)'}
                  className="w-full resize-y rounded-lg border border-line bg-bg/60 px-3 py-2 text-sm text-text outline-none focus-visible:shadow-glow"
                />
              </div>

              {loras.length > 0 && (
                <ul aria-label="LoRAs" className="flex flex-wrap gap-1.5">
                  {loras.map((name, i) => (
                    <li key={`${i}-${name}`} data-testid="gallery-lora" className={cn(tag, 'break-all')}>
                      LoRA: {name}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-auto flex flex-wrap gap-2">
                <Button asChild className="bg-linear-to-r from-accent-from to-accent-to text-white">
                  <a href={item.url} download={downloadName(item)}>
                    <Download />
                    Download image
                  </a>
                </Button>
                <Button variant="destructive" onClick={() => setAsking(true)}>
                  <Trash2 />
                  Delete
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Delete this image?"
        action="Delete"
        destructive
        onConfirm={() => item && onDelete(item)}
      >
        The PNG and its metadata are removed from the gallery folder.
      </ConfirmDialog>
    </Dialog>
  )
}

function NavButton({ side, label, onClick }: { side: 'left' | 'right'; label: string; onClick: (() => void) | null }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={label}
      title={`${label} (${side === 'left' ? '←' : '→'})`}
      disabled={!onClick}
      onClick={() => onClick?.()}
      className={cn('absolute top-1/2 -translate-y-1/2 rounded-full bg-surface/80 backdrop-blur', side === 'left' ? 'left-3' : 'right-3')}
    >
      <Icon />
    </Button>
  )
}
