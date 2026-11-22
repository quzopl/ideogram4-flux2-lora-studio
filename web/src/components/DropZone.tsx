import { ImageUp, LoaderCircle } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useMutationWithToast } from '@/lib/queries'
import { cn } from '@/lib/utils'

interface UploadResult {
  folder: string
  count: number
  files: string[]
}

interface DropZoneProps {
  /** Called with the server folder that now holds the uploaded images. */
  onUploaded: (folder: string, count: number, files: string[]) => void
  /** Called (instead of a toast) when none of the files is a supported image. */
  onEmpty?: (folder: string) => void
  /** The file input's `accept`. */
  accept?: string
  disabled?: boolean
  /** Told when an upload starts (true) and when it ends (false). */
  onBusyChange?: (busy: boolean) => void
}

/** Drop (or pick) images; they go to POST /api/upload and become a source folder. */
export function DropZone({ onUploaded, onEmpty, accept = 'image/*', disabled = false, onBusyChange }: DropZoneProps) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const upload = useMutationWithToast((files: File[]) => {
    const body = new FormData()
    for (const f of files) body.append('files', f)
    return api<UploadResult>('/api/upload', { method: 'POST', body })
  })

  const send = (list: FileList | null) => {
    const files = Array.from(list ?? [])
    if (!files.length || disabled) return
    upload.mutate(files, {
      onSuccess: (r) => {
        if (r.count > 0) onUploaded(r.folder, r.count, r.files)
        else if (onEmpty) onEmpty(r.folder)
        else toast.error('None of those files is a supported image.')
      },
    })
  }

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    send(e.dataTransfer.files)
  }

  const busy = upload.isPending
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange])
  const pick = () => !busy && !disabled && input.current?.click()
  return (
    <>
      <motion.div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            pick()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        onClick={pick}
        animate={{ scale: over ? 1.015 : 1 }}
        transition={{ type: 'spring', stiffness: 400, damping: 28 }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-5 text-center transition-colors outline-none focus-visible:shadow-glow',
          over
            ? 'border-accent-to/70 bg-accent-to/[0.06] shadow-glow'
            : 'border-white/15 bg-bg/40 hover:border-white/25 hover:bg-white/[0.02]',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        {busy ? (
          <LoaderCircle className="size-5 animate-spin text-accent-to" />
        ) : (
          <ImageUp className={cn('size-5', over ? 'text-accent-to' : 'text-text-dim')} />
        )}
        <p className="text-sm">{busy ? 'Uploading…' : 'Drop images here'}</p>
        <p className="text-xs text-text-dim">or click to pick files</p>
      </motion.div>
      <input
        ref={input}
        type="file"
        multiple
        accept={accept}
        aria-label="Upload images"
        className="hidden"
        onChange={(e) => {
          send(e.target.files)
          e.target.value = ''
        }}
      />
    </>
  )
}
