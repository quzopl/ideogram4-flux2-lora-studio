import { useQueryClient } from '@tanstack/react-query'
import { Bookmark, ChevronDown, Save, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useMutationWithToast, useSettings } from '@/lib/queries'
import type { Settings } from '@/lib/types'

type Values = Record<string, unknown>

interface PresetBarProps {
  view: string
  /** The form as it is now; what "Save as…" stores. */
  current: object
  onLoad: (form: Values) => void
}

export function PresetBar({ view, current, onLoad }: PresetBarProps) {
  const qc = useQueryClient()
  const settings = useSettings()
  const presets = settings.data?.presets[view] ?? {}
  const names = Object.keys(presets).sort((a, b) => a.localeCompare(b))
  const [selected, setSelected] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  const url = (n: string) => `/api/settings/presets/${encodeURIComponent(view)}/${encodeURIComponent(n)}`
  const store = (doc: Settings) => qc.setQueryData(['settings'], doc)

  const save = useMutationWithToast(
    (n: string) => api<Settings>(url(n), { method: 'PUT', json: { values: current } }),
    { success: 'Preset saved' },
  )
  const remove = useMutationWithToast(
    (n: string) => api<Settings>(url(n), { method: 'DELETE' }),
    { success: 'Preset deleted' },
  )

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    save.mutate(n, {
      onSuccess: (doc) => {
        store(doc)
        setSelected(n)
        setNaming(false)
        setName('')
      },
    })
  }

  const load = (n: string) => {
    setSelected(n)
    onLoad(presets[n])
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label="Presets" className="min-w-40 justify-between">
            <span className="flex items-center gap-1.5 truncate">
              <Bookmark className="text-text-dim" />
              {selected && presets[selected] ? selected : 'Presets'}
            </span>
            <ChevronDown className="text-text-dim" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-48">
          {settings.isPending ? (
            <div className="flex flex-col gap-1 p-1">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : names.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-text-dim">No presets yet</div>
          ) : (
            names.map((n) => (
              <DropdownMenuItem key={n} onSelect={() => load(n)}>
                {n}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {naming ? (
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            autoFocus
            aria-label="Preset name"
            placeholder="Preset name"
            maxLength={64}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setNaming(false)}
            className="h-7 w-44"
          />
          <Button type="submit" size="sm" aria-label="Save preset" disabled={!name.trim() || save.isPending}>
            <Save />
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
        </form>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setNaming(true)}>Save as…</Button>
      )}

      <Button
        variant="ghost"
        size="sm"
        aria-label="Delete preset"
        disabled={!selected || !presets[selected] || remove.isPending}
        onClick={() =>
          selected && remove.mutate(selected, {
            onSuccess: (doc) => {
              store(doc)
              setSelected(null)
            },
          })}
        className="text-text-dim hover:text-danger"
      >
        <Trash2 />
        Delete
      </Button>
    </div>
  )
}
