import { ChevronsDownUp, ChevronsUpDown, List, Network, Search } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ComfyJobBox } from '../ComfyJobBox'
import { errorText, useObjectInfo } from '../queries'
import { StatusLine, type Status } from '../StatusLine'
import { WorkflowDrop } from '../WorkflowDrop'
import { EditorActions } from './EditorActions'
import { flushEditor, getEditor, loadServerWorkflow, loadWorkflow, useEditor } from './editorStore'
import { EditorCardContext, NodeCard, nodeCardId, type CardContext } from './NodeCard'
import { buildKnownEnums, sortNodeIds, type Workflow } from './schema'
import { WorkflowGraph } from './WorkflowGraph'

type Mode = 'list' | 'hybrid'

/** POST /api/comfy/editor/load. */
interface EditorLoad {
  node_count: number
  workflow: Workflow
  source: 'png' | 'json'
}

const FLASH_MS = 1500

/**
 * The workflow editor tab: load a workflow (a file, else the server's last
 * one), then edit any node's literal inputs on its card.
 */
export function EditorTab() {
  const uid = useId()
  const { workflow, loads } = useEditor()
  const info = useObjectInfo(!!workflow)
  const [mode, setMode] = useState<Mode>('list')
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  // A file dropped over edits, waiting for "Discard your edits?" (kept while the dialog closes).
  const [pending, setPending] = useState<File | null>(null)
  const [asking, setAsking] = useState(false)

  useEffect(() => flushEditor, [])
  // First entry without a draft: the workflow the server last had in the editor.
  useEffect(() => {
    let live = true
    void loadServerWorkflow().then((n) => {
      if (live && n !== null) setStatus({ tone: 'info', text: `Loaded the workflow from the last session: ${n} nodes.` })
    })
    return () => {
      live = false
    }
  }, [])

  const resetView = useCallback(() => setCollapsed(new Set()), [])

  const upload = async (file: File) => {
    setLoading(true)
    setStatus({ tone: 'info', text: `Loading ${file.name}…` })
    const body = new FormData()
    body.append('file', file)
    try {
      const r = await api<EditorLoad>('/api/comfy/editor/load', { method: 'POST', body })
      loadWorkflow(r.workflow)
      resetView()
      const from = r.source === 'png' ? 'from PNG metadata' : 'from JSON file'
      setStatus({ tone: 'ok', text: `Loaded workflow ${from}: ${r.node_count} nodes.` })
    } catch (e) {
      setStatus({ tone: 'err', text: `Error: ${errorText(e)}` })
    } finally {
      setLoading(false)
    }
  }

  const ids = useMemo(() => sortNodeIds(Object.keys(workflow ?? {})), [workflow])
  // The class of every node, for the link labels: a new object only when a node's class changes, so an
  // edit re-renders only its own card.
  const typesSig = ids.map((id) => `${id}\u0000${workflow?.[id]?.class_type ?? ''}`).join('\u0001')
  const classTypes = useMemo(
    () => Object.fromEntries(typesSig ? typesSig.split('\u0001').map((e) => e.split('\u0000')) : []) as Record<string, string>,
    [typesSig],
  )
  const enums = useMemo(() => (info.data ? buildKnownEnums(info.data) : null), [info.data])

  const focusNode = useCallback((id: string) => {
    setCollapsed((c) => {
      if (!c.has(id)) return c
      const next = new Set(c)
      next.delete(id)
      return next
    })
    setFlash((f) => ({ id, n: (f?.n ?? 0) + 1 }))
  }, [])
  // After the card is expanded: scroll to it, then let the highlight fade.
  useEffect(() => {
    if (!flash) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(nodeCardId(flash.id))?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
    const t = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(t)
  }, [flash])

  const toggle = useCallback((id: string) => {
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const ctx = useMemo<CardContext>(
    () => ({ info: info.data ?? null, enums, classTypes, focusNode }),
    [info.data, enums, classTypes, focusNode],
  )

  const q = filter.trim().toLowerCase()
  const matches = (id: string) => !q || id.toLowerCase().includes(q) || (workflow?.[id]?.class_type ?? '').toLowerCase().includes(q)

  return (
    <section aria-labelledby={`${uid}-title`} className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={`${uid}-title`} className="text-sm font-semibold">Workflow editor</h2>
          <p className="mt-1 text-xs text-text-dim">
            Load a <code className="font-mono">.json</code> or <code className="font-mono">.png</code> with a ComfyUI
            workflow, edit any node's parameters, generate. Independent of the mapping on the LoRA test tab.
          </p>
        </div>
        <div role="group" aria-label="Editor view" className="flex gap-1 rounded-lg border border-line bg-bg/60 p-0.5">
          {([['list', 'Node list', List], ['hybrid', 'Graph + parameters', Network]] as const).map(([m, label, Icon]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors outline-none focus-visible:shadow-glow',
                mode === m ? 'bg-white/[0.08] text-text' : 'text-text-dim hover:text-text',
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <WorkflowDrop
        onFile={(f) => {
          if (!getEditor().dirty) return void upload(f)
          setPending(f)
          setAsking(true)
        }}
        busy={loading}
      />
      <StatusLine status={status} />

      {workflow && (
        <>
          <SchemaStatus info={info} enumCount={enums ? Object.keys(enums).length : 0} />
          {mode === 'hybrid' && (
            <WorkflowGraph workflow={workflow} classTypes={classTypes} onFocus={focusNode} selected={flash?.id ?? null} />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-dim" />
              <Input
                aria-label="Filter nodes"
                placeholder="filter nodes (name/type/ID)…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="pl-8"
              />
            </div>
            <Button size="sm" variant="outline" onClick={() => setCollapsed(new Set())}>
              <ChevronsUpDown />
              Expand all
            </Button>
            <Button size="sm" variant="outline" onClick={() => setCollapsed(new Set(ids))}>
              <ChevronsDownUp />
              Collapse all
            </Button>
          </div>
          <EditorCardContext value={ctx}>
            {/* Keyed by the load: a new workflow gets new controls (their kind follows the value they start with). */}
            <div key={loads} className="flex flex-col gap-2">
              {ids.map((id) => (
                <NodeCard
                  key={id}
                  id={id}
                  node={workflow[id]}
                  collapsed={collapsed.has(id)}
                  dimmed={!matches(id)}
                  flash={flash?.id === id}
                  onToggle={toggle}
                />
              ))}
            </div>
          </EditorCardContext>
          <EditorActions onLoaded={resetView} />
        </>
      )}
      <ComfyJobBox slot="editor" />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Discard your edits?"
        action="Load"
        onConfirm={() => pending && void upload(pending)}
      >
        The edits you made to this workflow will be lost.
      </ConfirmDialog>
    </section>
  )
}

/** Whether the cards have ComfyUI's schemas (dropdowns), or why not. */
function SchemaStatus({ info, enumCount }: { info: ReturnType<typeof useObjectInfo>; enumCount: number }) {
  // A failed refresh is shown even while the older schemas still give the dropdowns.
  const status: Status | null = info.isError
    ? {
      tone: 'info',
      text: `Note: /object_info unavailable (${errorText(info.error)}). Start ComfyUI and click ↻ ComfyUI schemas to get dropdowns for lora/model/sampler.`,
    }
    : info.data
      ? { tone: 'ok', text: `ComfyUI schemas: ${Object.keys(info.data).length} node types, ${enumCount} fields with dropdowns.` }
      : info.isFetching
        ? { tone: 'info', text: 'Fetching /object_info from ComfyUI…' }
        : null
  return <StatusLine status={status} />
}
