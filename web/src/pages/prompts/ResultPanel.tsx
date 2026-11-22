import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowUpToLine, Copy, LayoutTemplate, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { V15Findings, type V15Finding } from '@/components/V15Findings'
import { api, ApiError } from '@/lib/api'
import { handOffToBbox } from '@/lib/bboxHandoff'
import { copyText } from '@/lib/clipboard'
import { isJsonFormat } from './promptForm'
import type { PromptResult } from './promptRunStore'

/** `value`, once it has not changed for `ms`. */
function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

interface ResultPanelProps {
  result: PromptResult
  /** The user's edit of the result; null while unedited. */
  edited: string | null
  onEdit: (text: string) => void
  onRegenerate: () => void
  regenerateDisabled: boolean
  onUseAsInput: (text: string) => void
  /** A new job is running: this is the previous result, shown dimmed until it is replaced. */
  stale: boolean
}

/**
 * The generated prompt, editable. A JSON result (its own format, not the
 * form's current one) shows its v15 findings, re-linted on the server 500 ms
 * after an edit.
 */
export function ResultPanel({ result, edited, onEdit, onRegenerate, regenerateDisabled, onUseAsInput, stale }: ResultPanelProps) {
  const text = edited ?? result.prompt
  const json = isJsonFormat(result.format)
  // A blank prompt has nothing to check, so it must not read as "compliant".
  const blank = !text.trim()
  const settled = useDebounced(text, 500)
  const relint = json && edited !== null && settled.trim() !== '' && settled !== result.prompt
  // Keyed by the text, so an older answer never overwrites a newer one.
  const lint = useQuery({
    queryKey: ['lint', settled],
    queryFn: () => api<{ warnings: V15Finding[] }>('/api/prompts/lint', { method: 'POST', json: { prompt: settled } }),
    enabled: relint,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  })
  const findings = relint ? lint.data?.warnings ?? result.warnings : result.warnings
  // A failed check must not leave the pre-edit findings (maybe "compliant") under the edit.
  const lintError = relint && lint.isError
    ? lint.error instanceof ApiError ? lint.error.detail : lint.error.message
    : ''

  const copy = () => {
    if (!text) return
    copyText(text).then(
      () => toast.success('Copied to clipboard.'),
      (e: Error) => toast.error(e.message),
    )
  }

  return (
    <section
      aria-label="Result"
      data-stale={stale}
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 transition-opacity data-[stale=true]:opacity-60"
    >
      <h2 className="text-sm font-semibold">Result</h2>
      <textarea
        aria-label="Result"
        value={text}
        onChange={(e) => onEdit(e.target.value)}
        rows={json ? 14 : 8}
        spellCheck={!json}
        className="min-h-40 w-full resize-y rounded-lg border border-line bg-bg/60 px-3 py-2.5 text-sm leading-relaxed outline-none focus-visible:border-accent-from/60 focus-visible:shadow-glow data-[json=true]:font-mono data-[json=true]:text-xs"
        data-json={json}
      />
      {json && !blank && (lintError ? (
        <p role="alert" className="rounded-lg border border-danger/25 bg-danger/[0.06] px-3 py-2 text-sm text-danger">
          Could not check the edited prompt: {lintError}
        </p>
      ) : <V15Findings findings={findings} />)}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          <Copy />
          Copy
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onRegenerate} disabled={regenerateDisabled}>
          <RotateCw />
          Regenerate
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => onUseAsInput(text.trim())}>
          <ArrowUpToLine />
          Use as input
        </Button>
        {json && (
          <Button
            type="button"
            size="sm"
            onClick={() => text.trim() && handOffToBbox(text.trim())}
            className="bg-linear-to-r from-accent-from to-accent-to text-white"
          >
            <LayoutTemplate />
            Edit on canvas
          </Button>
        )}
      </div>
    </section>
  )
}
