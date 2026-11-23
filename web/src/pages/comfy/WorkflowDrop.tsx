import { FileJson, LoaderCircle } from 'lucide-react'
import { motion } from 'motion/react'
import { useRef, useState, type DragEvent } from 'react'
import { cn } from '@/lib/utils'

interface WorkflowDropProps {
  /** A dropped or picked workflow file (API-format `.json` or a ComfyUI `.png`). */
  onFile: (file: File) => void
  busy?: boolean
}

/** Drop or pick one workflow file; the same file can be picked again. */
export function WorkflowDrop({ onFile, busy = false }: WorkflowDropProps) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const send = (f: File | undefined) => {
    if (f && !busy) onFile(f)
  }
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    send(e.dataTransfer.files[0])
  }
  const pick = () => !busy && input.current?.click()

  return (
    <>
      <motion.div
        role="button"
        tabIndex={0}
        aria-busy={busy || undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            pick()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
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
        )}
      >
        {busy ? (
          <LoaderCircle className="size-5 animate-spin text-accent-to" />
        ) : (
          <FileJson className={cn('size-5', over ? 'text-accent-to' : 'text-text-dim')} />
        )}
        <p className="text-sm">Drop a .json or .png file here…</p>
        <p className="text-xs text-text-dim">or click to pick one</p>
      </motion.div>
      <input
        ref={input}
        type="file"
        accept=".json,.png,image/png,application/json"
        aria-label="Workflow file"
        className="hidden"
        onChange={(e) => {
          send(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </>
  )
}
