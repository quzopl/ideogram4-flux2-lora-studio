import { FolderOpen, Save, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface NamedLibraryProps<T> {
  /** Singular, lower case: "mapping" gives "— saved mappings —" and "name for the new mapping". */
  title: string
  items: Record<string, T>
  onLoad: (name: string, value: T) => void
  /** Stores the current value under `name`; a rejection (shown by the caller) keeps the typed name. */
  onSave: (name: string) => Promise<unknown>
  onDelete: (name: string) => Promise<unknown>
  /** A short note on the selected item. */
  describe?: (value: T) => string
}

/**
 * A server-side library of named values: pick one to Load or Delete (asks
 * first), or Save the current value as a new name. The selection stays while
 * the list is refreshed, until its item is gone.
 */
export function NamedLibrary<T>({ title, items, onLoad, onSave, onDelete, describe }: NamedLibraryProps<T>) {
  const names = Object.keys(items).sort((a, b) => a.localeCompare(b))
  const [picked, setPicked] = useState('')
  const selected = Object.hasOwn(items, picked) ? picked : ''
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      return true
    } catch {
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n || busy) return
    if (await act(() => onSave(n))) setName('')
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selected} onValueChange={setPicked}>
          <SelectTrigger size="sm" aria-label={`Saved ${title}s`} className="min-w-52">
            <SelectValue placeholder={`— saved ${title}s —`} />
          </SelectTrigger>
          <SelectContent>
            {names.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-text-dim">Nothing saved yet</div>
            ) : (
              names.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)
            )}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={!selected || busy} onClick={() => onLoad(selected, items[selected])}>
          <FolderOpen />
          Load
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!selected || busy}
          onClick={() => setConfirming(true)}
          className="text-text-dim hover:text-danger"
        >
          <Trash2 />
          Delete
        </Button>
        <form onSubmit={save} className="flex flex-1 items-center gap-2">
          <Input
            aria-label={`Name for the new ${title}`}
            placeholder={`name for the new ${title}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-7 min-w-40 flex-1"
          />
          <Button type="submit" size="sm" variant="outline" disabled={!name.trim() || busy}>
            <Save />
            Save as
          </Button>
        </form>
      </div>
      {selected && describe && <p className="text-xs text-text-dim">{describe(items[selected])}</p>}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${title}?`}
        action="Delete"
        destructive
        onConfirm={() => {
          const n = selected
          void act(() => onDelete(n)).then((ok) => ok && setPicked((p) => (p === n ? '' : p)))
        }}
      >
        Delete {title} “{selected}”? This cannot be undone.
      </ConfirmDialog>
    </div>
  )
}
