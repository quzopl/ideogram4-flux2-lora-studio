import { Minus, Plus, RefreshCw } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { errorText, useComfyLoras } from './queries'

interface LoraRowsProps {
  /** The workflow's LoRA loaders (0 also while it is not known). */
  slots: number
  hasWorkflow: boolean
  /** The rows shown, at most `slots`; row i goes to slot i. */
  rows: string[]
  onChange: (rows: string[]) => void
}

/**
 * The LoRA picker: one row per LoRA slot of the workflow, each a free-text
 * name with ComfyUI's LoRA list as suggestions (asked on entry; the search
 * narrows them). Rows are positional: − clears a row and leaves its slot as
 * the workflow has it.
 */
export function LoraRows({ slots, hasWorkflow, rows, onChange }: LoraRowsProps) {
  const uid = useId()
  const listId = `${uid}-loras`
  const loras = useComfyLoras()
  const [search, setSearch] = useState('')
  const [capped, setCapped] = useState(false)

  const known = loras.data?.loras
  const q = search.trim().toLowerCase()
  const options = (known ?? []).filter((l) => !q || l.toLowerCase().includes(q))

  const setRow = (i: number, value: string) => onChange(rows.map((r, j) => (j === i ? value : r)))
  const add = () => {
    if (rows.length >= slots) return setCapped(true)
    setCapped(false)
    onChange([...rows, ''])
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-text-dim">LoRAs</span>
        {known && <span className="text-xs text-text-dim">({known.length} available)</span>}
        <Button size="xs" variant="outline" onClick={() => void loras.refetch()} disabled={loras.isFetching}>
          <RefreshCw className={cn(loras.isFetching && 'animate-spin motion-reduce:animate-none')} />
          refresh list from ComfyUI
        </Button>
        <Input
          aria-label="Search LoRAs"
          placeholder="search LoRAs by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 max-w-64 min-w-40 flex-1 text-xs"
        />
      </div>
      {loras.isError && (
        <p className="text-xs text-danger">LoRA list error: {errorText(loras.error)} — you can still type the names.</p>
      )}
      <datalist id={listId}>
        {options.map((l) => <option key={l} value={l} />)}
      </datalist>

      {hasWorkflow && slots === 0 ? (
        <p className="text-xs text-text-dim">This workflow has no LoRA loader — add one in ComfyUI.</p>
      ) : (
        rows.length > 0 && (
          <ol className="flex flex-col gap-1.5">
            {rows.map((value, i) => {
              const name = value.trim()
              const unknown = known !== undefined && name !== '' && !known.includes(name)
              return (
                <li key={i} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <span className="w-4 text-right font-mono text-xs text-text-dim tabular-nums">{i + 1}</span>
                    <Input
                      aria-label={`LoRA ${i + 1}`}
                      placeholder="pick or type a name…"
                      list={listId}
                      value={value}
                      onChange={(e) => setRow(i, e.target.value)}
                      aria-describedby={unknown ? `${uid}-unknown-${i}` : undefined}
                      className="h-8 font-mono text-xs"
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Clear LoRA ${i + 1}`}
                      title="Clear this slot (the workflow's own LoRA stays)"
                      disabled={value === ''}
                      onClick={() => setRow(i, '')}
                      className="text-text-dim hover:text-danger"
                    >
                      <Minus />
                    </Button>
                  </div>
                  {unknown && (
                    <p id={`${uid}-unknown-${i}`} className="pl-5.5 text-xs text-warning">not on the ComfyUI list</p>
                  )}
                </li>
              )
            })}
          </ol>
        )
      )}

      {slots > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" onClick={add}>
            <Plus />
            add LoRA
          </Button>
          {capped && rows.length >= slots && (
            <p className="text-xs text-danger">
              The workflow has only {slots} LoRA loader(s). Add more LoRA loaders in ComfyUI to stack more.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
