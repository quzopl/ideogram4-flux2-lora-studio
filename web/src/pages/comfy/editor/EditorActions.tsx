import { useIsMutating, useQueryClient } from '@tanstack/react-query'
import { FileDown, FolderOpen, Play, RefreshCw, RotateCcw, Save, Trash2, Upload } from 'lucide-react'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { useMutationWithToast } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { startJob, useComfyJobs } from '../comfyJobStore'
import {
  errorText, freshWorkflows, refreshObjectInfo, useObjectInfo, useWorkflows, workflowUrl, WORKFLOWS_KEY, type WorkflowImport,
} from '../queries'
import { StatusLine, type Status } from '../StatusLine'
import { getEditor, loadWorkflow, markSaved, reloadServerWorkflow, setName, useEditor } from './editorStore'
import type { Workflow } from './schema'

const START_KEY = ['comfy-editor-start']

/** A file's name without its extension (as the server's `Path.stem`). */
function fileStem(file: string) {
  const dot = file.lastIndexOf('.')
  return (dot > 0 ? file.slice(0, dot) : file).trim() || 'workflow'
}

/** A question before an action: Discard your edits?, Overwrite …?, Delete workflow?. */
interface Ask {
  title: string
  text: ReactNode
  action: string
  destructive?: boolean
  run: () => void
}

/**
 * Under the node list: Send to ComfyUI, Save .json, Reload from disk and the
 * schemas, then the workflow library (save, import, load, delete).
 * `onLoaded`: another workflow is in the editor now.
 */
export function EditorActions({ onLoaded }: { onLoaded: () => void }) {
  const qc = useQueryClient()
  const { workflow, name, invalid } = useEditor()
  const info = useObjectInfo(!!workflow)
  const library = useWorkflows()
  const items = library.data ?? []
  const [picked, setPicked] = useState('')
  const selected = items.some((i) => i.name === picked) ? picked : ''
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  // Kept after closing, so the closing dialog keeps its text; a confirmed question may ask the next one.
  const [ask, setAsk] = useState<Ask | null>(null)
  const [asking, setAsking] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)

  // At mutation level: the job is kept even if the view was left before the answer.
  const start = useMutationWithToast(
    (wf: Workflow) => api<{ job_id: string }>('/api/comfy/editor/generate', { method: 'POST', json: { workflow: wf } }),
    { onSuccess: (r) => startJob('editor', r.job_id), mutationKey: START_KEY },
  )
  const starting = useIsMutating({ mutationKey: START_KEY }) > 0
  const running = useComfyJobs().editor.jobId !== null
  const hasInvalid = Object.keys(invalid).length > 0
  const ready = !!workflow && !hasInvalid && !starting && !running

  const generate = () => {
    const wf = getEditor().workflow
    if (ready && wf) start.mutate(wf)
  }

  /** Runs `fn` with the library buttons off; its error is the status. */
  const act = async (prefix: string, fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setStatus({ tone: 'err', text: `${prefix}${errorText(e)}` })
    } finally {
      setBusy(false)
    }
  }
  const refreshList = () => qc.invalidateQueries({ queryKey: WORKFLOWS_KEY })
  const confirm = (a: Ask) => {
    setAsk(a)
    setAsking(true)
  }
  /** Replacing the workflow asks first over edits. */
  const replace = (action: string, run: () => void) => {
    if (getEditor().dirty) {
      confirm({ title: 'Discard your edits?', text: 'The edits you made to this workflow will be lost.', action, run })
    } else run()
  }
  /** Import (after the edits question) opens the file picker; the name is decided once a file is picked. */
  const startImport = () => replace('Import', () => importInput.current?.click())

  const saveFile = () => {
    const wf = getEditor().workflow
    if (!wf) return
    const file = `${name.trim() || 'workflow_api'}.json`
    const url = URL.createObjectURL(new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = file
    a.style.display = 'none'
    // Some browsers download only from an anchor in the document; revoked once the download started.
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      a.remove()
      URL.revokeObjectURL(url)
    }, 1000)
    setStatus({ tone: 'ok', text: `Downloaded ${file} (ComfyUI API format).` })
  }

  const reload = () =>
    act('Error: ', async () => {
      const n = await reloadServerWorkflow()
      if (n === null) {
        setStatus({ tone: 'err', text: 'The server has no editor workflow yet.' })
        return
      }
      onLoaded()
      setStatus({ tone: 'ok', text: `Reloaded the workflow from disk: ${n} nodes.` })
    })

  const save = (e: FormEvent) => {
    e.preventDefault()
    const wf = getEditor().workflow
    const n = name.trim()
    if (!wf || busy) return
    if (!n) {
      setStatus({ tone: 'err', text: 'Enter a workflow name.' })
      return
    }
    void act('Save error: ', async () => {
      await api('/api/comfy/workflows', { method: 'POST', json: { name: n, value: wf } })
      markSaved(n, wf)
      setPicked(n)
      setStatus({ tone: 'ok', text: `Saved workflow "${n}" to the library.` })
      await refreshList()
    })
  }

  const importFile = (file: File, n: string) =>
    act('Import error: ', async () => {
      setStatus({ tone: 'info', text: 'Importing workflow…' })
      const body = new FormData()
      body.append('file', file)
      body.append('name', n)
      const r = await api<WorkflowImport>('/api/comfy/workflows/import', { method: 'POST', body })
      loadWorkflow(r.workflow, r.name)
      onLoaded()
      setPicked(r.name)
      setStatus({ tone: 'ok', text: `Imported "${r.name}" (${r.node_count} nodes) and saved to the library.` })
      await refreshList()
    })

  /**
   * Under the typed name, else the file's; one the library has (asked again
   * now: another tab may have saved it) asks before it is overwritten.
   */
  const pickedImport = (file: File) =>
    act('Import error: ', async () => {
      const n = getEditor().name.trim() || fileStem(file.name)
      if ((await freshWorkflows(qc)).some((i) => i.name === n)) {
        confirm({
          title: `Overwrite workflow “${n}”?`,
          text: 'The saved workflow will be replaced by the imported file.',
          action: 'Overwrite',
          destructive: true,
          run: () => void importFile(file, n),
        })
      } else await importFile(file, n)
    })

  const load = (n: string) =>
    act('Load error: ', async () => {
      const r = await api<{ name: string; workflow: Workflow }>(workflowUrl(n))
      loadWorkflow(r.workflow, r.name)
      onLoaded()
      setStatus({ tone: 'ok', text: `Loaded "${n}" (${Object.keys(r.workflow).length} nodes).` })
    })

  const remove = (n: string) =>
    act('Error: ', async () => {
      await api(workflowUrl(n), { method: 'DELETE' })
      setPicked((p) => (p === n ? '' : p))
      setStatus({ tone: 'ok', text: `Deleted "${n}".` })
      await refreshList()
    })

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="lg" disabled={!ready} onClick={generate} title="Queue this workflow on ComfyUI and generate">
          <Play />
          Send to ComfyUI (generate)
        </Button>
        <Button size="sm" variant="outline" onClick={saveFile} title="Download the edited workflow as a .json file (API format)">
          <FileDown />
          Save .json
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => replace('Reload', () => void reload())}>
          <RotateCcw />
          Reload from disk
        </Button>
        <Button
          size="sm"
          variant="outline"
          title="Fetch /object_info from ComfyUI — enables dropdowns for lora/ckpt/sampler"
          disabled={info.isFetching}
          onClick={() => void refreshObjectInfo(qc).catch(() => {})}
        >
          <RefreshCw className={cn(info.isFetching && 'animate-spin')} />
          ComfyUI schemas
        </Button>
        {hasInvalid && <p className="text-sm text-text-dim">Fix the fields marked above.</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={save} className="flex min-w-64 flex-1 items-center gap-2">
          <Input
            aria-label="Workflow name"
            placeholder="name for the saved workflow…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-7 min-w-40 flex-1"
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            <Save />
            Save to library
          </Button>
        </form>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          title="Load a .json / .png file and save it to the library"
          onClick={startImport}
        >
          <Upload />
          Import from JSON
        </Button>
        <input
          ref={importInput}
          type="file"
          accept=".json,.png,image/png,application/json"
          aria-label="JSON or PNG to import"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            // Reset, so the same file can be imported again.
            e.target.value = ''
            if (f) void pickedImport(f)
          }}
        />
        <Select value={selected} onValueChange={setPicked}>
          <SelectTrigger size="sm" aria-label="Saved workflows" className="min-w-52">
            <SelectValue placeholder="— saved workflows —" />
          </SelectTrigger>
          <SelectContent>
            {items.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-text-dim">Nothing saved yet</div>
            ) : (
              items.map((it) => (
                <SelectItem key={it.name} value={it.name}>
                  {it.node_count ? `${it.name} (${it.node_count} nodes)` : it.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={!selected || busy} onClick={() => replace('Load', () => void load(selected))}>
          <FolderOpen />
          Load
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!selected || busy}
          onClick={() => {
            const n = selected
            confirm({
              title: 'Delete workflow?',
              text: `Delete workflow “${n}” from the library? This cannot be undone.`,
              action: 'Delete',
              destructive: true,
              run: () => void remove(n),
            })
          }}
          className="text-text-dim hover:text-danger"
        >
          <Trash2 />
          Delete
        </Button>
      </div>
      <StatusLine status={status} />

      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={ask?.title ?? ''}
        action={ask?.action ?? ''}
        destructive={ask?.destructive}
        onConfirm={() => ask?.run()}
      >
        {ask?.text}
      </ConfirmDialog>
    </div>
  )
}
