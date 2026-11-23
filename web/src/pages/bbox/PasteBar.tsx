import { useMutation } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { errorText, normalizePrompt, type Normalized } from './normalize'

interface PasteBarProps {
  /** Kept by the page, so it survives closing the bar. */
  text: string
  onText: (text: string) => void
  /** The server normalised the text; the page puts it on the canvas (and closes the bar). */
  onLoaded: (n: Normalized) => void
  onCancel: () => void
}

/** Paste JSON: any prompt JSON goes through the server normaliser; its error stays here. */
export function PasteBar({ text, onText, onLoaded, onCancel }: PasteBarProps) {
  const load = useMutation({ mutationFn: normalizePrompt })
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3"
    >
      <textarea
        aria-label="Prompt JSON"
        placeholder="Paste a prompt JSON (old or new format, even broken/double-encoded — it will be unwrapped and converted to v15)"
        value={text}
        onChange={(e) => {
          onText(e.target.value)
          if (load.isError) load.reset()
        }}
        autoFocus
        spellCheck={false}
        className="min-h-24 w-full resize-y rounded-lg border border-line bg-bg/60 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:border-accent-from/60 focus-visible:shadow-glow"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={load.isPending} onClick={() => load.mutate(text, { onSuccess: onLoaded })}>
          Load
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        {load.isError && (
          <p role="alert" className="min-w-0 text-sm break-words text-danger">{errorText(load.error)}</p>
        )}
      </div>
    </motion.div>
  )
}
