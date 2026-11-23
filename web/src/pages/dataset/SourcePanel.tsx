import { FolderOpen, Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { DropZone } from '@/components/DropZone'
import { FolderPicker } from '@/components/FolderPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** The classic file input's types: browsers do not list HEIC under image/*. */
const ACCEPT = 'image/*,.heic,.heif,image/heic,image/heif'

export interface SourceStatus {
  text: string
  tone: 'dim' | 'ok' | 'warn' | 'err'
}

interface SourcePanelProps {
  /** The saved source folder; the text field follows it. */
  folder: string
  disabled: boolean
  scanning: boolean
  /** An upload is in flight (no scan may start meanwhile). */
  uploading: boolean
  onUploading: (busy: boolean) => void
  status: SourceStatus | null
  onScan: (folder: string) => void
  onUploaded: (folder: string, files: string[]) => void
  onEmptyUpload: (folder: string) => void
}

/** Step 1: a folder on disk (typed or picked, then scanned) or uploaded images. */
export function SourcePanel({ folder, disabled, scanning, uploading, onUploading, status, onScan, onUploaded, onEmptyUpload }: SourcePanelProps) {
  const [path, setPath] = useState(folder)
  const [picking, setPicking] = useState(false)
  // A new source (scan, upload, saved form) replaces the typed text.
  const [shown, setShown] = useState(folder)
  if (folder !== shown) {
    setShown(folder)
    setPath(folder)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const p = path.trim()
    if (p && !uploading) onScan(p)
  }

  return (
    <section aria-label="Source" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold">Source</h2>
      <form onSubmit={submit} className="flex items-center gap-2">
        <Input
          aria-label="Source folder"
          placeholder="/home/user/photos/my-person"
          value={path}
          disabled={disabled}
          onChange={(e) => setPath(e.target.value)}
          className="font-mono text-xs"
        />
        <Button type="submit" variant="outline" size="sm" disabled={disabled || scanning || uploading || !path.trim()}>
          <Search />
          Scan
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Choose folder…"
          title="Choose folder…"
          disabled={disabled || uploading}
          onClick={() => setPicking(true)}
        >
          <FolderOpen />
        </Button>
      </form>
      <DropZone
        accept={ACCEPT}
        // One source at a time: no upload while a scan runs (and no scan while uploading).
        disabled={disabled || scanning}
        onBusyChange={onUploading}
        onUploaded={(f, _count, files) => onUploaded(f, files)}
        onEmpty={onEmptyUpload}
      />
      <p
        data-testid="source-status"
        className={cn(
          'min-h-4 truncate text-xs',
          status?.tone === 'ok' && 'text-success',
          status?.tone === 'warn' && 'text-warning',
          status?.tone === 'err' && 'text-danger',
          (!status || status.tone === 'dim') && 'text-text-dim',
        )}
        title={status?.text}
      >
        {status?.text}
      </p>

      <FolderPicker
        open={picking}
        onOpenChange={setPicking}
        title="Choose the source folder"
        initialPath={folder || undefined}
        requireWritable={false}
        onPick={onScan}
      />
    </section>
  )
}
