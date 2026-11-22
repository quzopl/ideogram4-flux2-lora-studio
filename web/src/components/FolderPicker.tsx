import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileBox, Folder, FolderPlus, HardDrive } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { SpringDialogContent } from '@/components/SpringDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { useMutationWithToast } from '@/lib/queries'
import type { FsListing } from '@/lib/types'
import { cn } from '@/lib/utils'

/** `dir` + `name` without doubling the slash at the root. */
export const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`

/** "/a/b" -> [["/", "/"], ["a", "/a"], ["b", "/a/b"]]. */
function crumbs(path: string): [string, string][] {
  const out: [string, string][] = [['/', '/']]
  let acc = ''
  for (const part of path.split('/').filter(Boolean)) {
    acc += `/${part}`
    out.push([part, acc])
  }
  return out
}

export function useFsList(path: string, weights = false, enabled = true) {
  return useQuery({
    queryKey: ['fs-list', path, weights],
    queryFn: () => {
      const q = new URLSearchParams({ path })
      if (weights) q.set('files', 'weights')
      return api<FsListing>(`/api/fs/list?${q}`)
    },
    enabled,
  })
}

interface FolderPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** Where to start; the backend's default (home) when empty. */
  initialPath?: string
  /** "weights": pick a weight file from the folder instead of the folder. */
  mode?: 'dir' | 'weights'
  /** Only offer writable folders (default); false for folders that are only read. */
  requireWritable?: boolean
  onPick: (path: string) => void
}

export function FolderPicker({ open, onOpenChange, title, initialPath, mode = 'dir', requireWritable = true, onPick }: FolderPickerProps) {
  const weights = mode === 'weights'
  const [path, setPath] = useState(initialPath ?? '')
  const [file, setFile] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const qc = useQueryClient()

  // Every opening starts over at initialPath.
  useEffect(() => {
    if (!open) return
    setPath(initialPath ?? '')
    setFile(null)
    setNaming(false)
    setName('')
  }, [open, initialPath])

  const list = useFsList(path, weights, open)
  const here = list.data

  const go = (p: string) => {
    setPath(p)
    setFile(null)
    setNaming(false)
  }

  const mkdir = useMutationWithToast((p: string) => api<{ path: string }>('/api/fs/mkdir', {
    method: 'POST',
    json: { path: p },
  }))

  const create = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!here || !n) return
    mkdir.mutate(joinPath(here.path, n), {
      onSuccess: () => {
        setNaming(false)
        setName('')
        qc.invalidateQueries({ queryKey: ['fs-list', path] })
      },
    })
  }

  const choose = () => {
    if (!here) return
    onPick(weights && file ? joinPath(here.path, file) : here.path)
    onOpenChange(false)
  }

  const canChoose = here ? (weights ? file !== null : here.writable || !requireWritable) : false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SpringDialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {weights ? 'Browse to a folder and pick a weight file.' : 'Browse to a folder and choose it.'}
          </DialogDescription>
        </DialogHeader>

        {/* Breadcrumbs */}
        <nav aria-label="Path" className="flex min-h-7 flex-wrap items-center gap-0.5 font-mono text-xs">
          {here
            ? crumbs(here.path).map(([label, p], i, all) => (
                <span key={p} className="flex items-center gap-0.5">
                  {i > 1 && <span className="text-text-dim">/</span>}
                  <button
                    type="button"
                    onClick={() => go(p)}
                    aria-current={i === all.length - 1 ? 'location' : undefined}
                    className={cn(
                      'rounded-md px-1.5 py-0.5 hover:bg-white/5',
                      i === all.length - 1 ? 'text-text' : 'text-text-dim',
                    )}
                  >
                    {label}
                  </button>
                </span>
              ))
            : <Skeleton className="h-5 w-64" />}
        </nav>

        {here && (
          <div className="-mt-2 flex flex-wrap items-center gap-2 text-xs text-text-dim">
            <span className="flex items-center gap-1 font-mono tabular-nums">
              <HardDrive className="size-3.5" />
              {formatBytes(here.free_bytes)} free
            </span>
            {!here.writable && <Badge variant="outline" className="border-warning/40 text-warning">Read-only</Badge>}
            {here.is_model && <Badge variant="outline" className="border-success/40 text-success">Model folder</Badge>}
          </div>
        )}

        <div className="h-72 overflow-y-auto rounded-xl border border-line bg-bg/60 p-1">
          {list.isPending ? (
            <div className="flex flex-col gap-1 p-1">
              {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : list.isError ? (
            <div className="flex flex-col items-start gap-2 p-3 text-sm">
              <p className="text-danger">
                {list.error instanceof ApiError ? list.error.detail : list.error.message}
              </p>
              <Button size="sm" variant="outline" onClick={() => go('')}>Go to home folder</Button>
            </div>
          ) : (
            <ul className="flex flex-col">
              {here?.parent && (
                <li>
                  <button type="button" onClick={() => go(here.parent!)} className={rowClass(false)}>
                    <Folder className="size-4 text-text-dim" />
                    <span className="text-text-dim">..</span>
                  </button>
                </li>
              )}
              {here?.dirs.map((d) => (
                <li key={d}>
                  <button type="button" onClick={() => go(joinPath(here.path, d))} className={rowClass(false)}>
                    <Folder className="size-4 text-accent-to/80" />
                    <span className="truncate">{d}</span>
                  </button>
                </li>
              ))}
              {weights && here?.files?.map((f) => (
                <li key={f}>
                  <button
                    type="button"
                    onClick={() => setFile(f)}
                    aria-pressed={file === f}
                    className={rowClass(file === f)}
                  >
                    <FileBox className="size-4 text-text-dim" />
                    <span className="truncate font-mono text-xs">{f}</span>
                  </button>
                </li>
              ))}
              {here && here.dirs.length === 0 && !(weights && here.files?.length) && (
                <li className="px-3 py-2 text-sm text-text-dim">
                  {weights ? 'No subfolders or weight files here.' : 'No subfolders here.'}
                </li>
              )}
            </ul>
          )}
        </div>

        {naming && (
          <form onSubmit={create} className="flex items-center gap-2">
            <Input
              autoFocus
              aria-label="Folder name"
              placeholder="Folder name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="font-mono"
            />
            <Button type="submit" size="sm" disabled={!name.trim() || mkdir.isPending}>Create</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
          </form>
        )}

        <DialogFooter className="mx-0 mb-0 items-center rounded-none border-0 bg-transparent p-0 sm:justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={!here?.writable || naming}
            onClick={() => setNaming(true)}
          >
            <FolderPlus />
            New folder
          </Button>
          <Button
            size="sm"
            disabled={!canChoose}
            onClick={choose}
            className="bg-linear-to-r from-accent-from to-accent-to text-white"
          >
            {weights ? 'Choose this file' : 'Choose this folder'}
          </Button>
        </DialogFooter>
      </SpringDialogContent>
    </Dialog>
  )
}

const rowClass = (active: boolean) =>
  cn(
    'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-white/5',
    active && 'bg-accent-from/15 ring-1 ring-accent-from/40',
  )
