import { useQueryClient } from '@tanstack/react-query'
import { Save } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { getComfyForm, setLoraForm, setMappingDraft, useComfyForm } from './formStore'
import { NamedLibrary } from './NamedLibrary'
import {
  activateMapping,
  deleteNamedMapping,
  errorText,
  loraSlots,
  patchConfig,
  saveNamedMapping,
  useComfyConfig,
  useMappings,
  type Mapping,
  type WorkflowUpload,
} from './queries'
import { StatusLine, type Status } from './StatusLine'
import { WorkflowDrop } from './WorkflowDrop'

/** The values the LoRA test and the batch set, each `<k>_node` + `<k>_field` in the mapping. */
const FIELDS = ['positive', 'negative', 'seed', 'width', 'height', 'steps', 'cfg'] as const

function isMapped(m: Mapping, k: (typeof FIELDS)[number]) {
  const node = m[`${k}_node`]
  const field = m[`${k}_field`]
  // As the backend's set_field: a node id (the workflow's keys are strings) and a field, else a no-op.
  return typeof node === 'string' && node !== '' && typeof field === 'string' && field !== ''
}

const pretty = (m: Mapping | null | undefined) => JSON.stringify(m ?? {}, null, 2)
const slotsText = (n: number) => `${n} LoRA slot(s)`

function parseMapping(text: string): { mapping: Mapping } | { error: string } {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch (e) {
    return { error: `Invalid JSON: ${errorText(e)}` }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'The mapping must be a JSON object.' }
  return { mapping: v as Mapping }
}

/** Which fields the active mapping can set, and how many LoRA slots it has. */
function MappingBadges({ mapping }: { mapping: Mapping }) {
  const slots = loraSlots(mapping)
  const pill = 'rounded-full border px-2 py-0.5 text-xs whitespace-nowrap'
  return (
    <ul aria-label="Mapped fields" className="flex flex-wrap gap-1.5">
      {FIELDS.map((k) => {
        const ok = isMapped(mapping, k)
        return (
          <li
            key={k}
            className={cn(pill, ok ? 'border-success/30 bg-success/10 text-success' : 'border-warning/30 bg-warning/10 text-warning')}
          >
            {k}: {ok ? 'mapped' : 'unmapped'}
          </li>
        )
      })}
      <li className={cn(pill, 'border-accent-to/30 bg-accent-to/10 text-accent-to')}>
        {slots} LoRA slot{slots === 1 ? '' : 's'}
      </li>
    </ul>
  )
}

/**
 * The workflow the LoRA test and the batch run: upload it (its node mapping is
 * detected), then fix the mapping as JSON, or keep named mappings.
 */
export function WorkflowCard() {
  const qc = useQueryClient()
  const config = useComfyConfig()
  const mappings = useMappings()
  const id = useId()
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<Status | null>(null)
  const [jsonError, setJsonError] = useState('')
  const [mappingStatus, setMappingStatus] = useState<Status | null>(null)

  const c = config.data
  const active = c?.has_workflow && c.mapping ? c.mapping : null
  // The mapping text as edited (kept in formStore); none follows the active mapping.
  const draft = useComfyForm().mapping
  const text = draft ?? pretty(active)

  const status: Status | null =
    uploadStatus ??
    (!c
      ? null
      : c.has_workflow
        ? {
          tone: 'ok',
          text: `Workflow in memory: ${c.workflow_node_count} nodes, ${slotsText(loraSlots(c.mapping))}. Upload another one to replace it.`,
        }
        : { tone: 'info', text: 'No workflow uploaded yet.' })

  const upload = async (file: File) => {
    setUploading(true)
    setUploadStatus({ tone: 'info', text: `Loading ${file.name}…` })
    const body = new FormData()
    body.append('file', file)
    try {
      const r = await api<WorkflowUpload>('/api/comfy/workflow', { method: 'POST', body })
      void patchConfig(qc, { has_workflow: true, workflow_node_count: r.node_count, mapping: r.mapping })
      setMappingDraft(undefined)
      setJsonError('')
      setMappingStatus(null)
      if (r.current_prompt && !getComfyForm().lora.prompt.trim()) setLoraForm({ prompt: r.current_prompt })
      const from = r.source === 'png' ? 'from PNG metadata' : 'from JSON file'
      setUploadStatus({ tone: 'ok', text: `Loaded workflow ${from}: ${r.node_count} nodes, ${slotsText(loraSlots(r.mapping))}.` })
    } catch (e) {
      setUploadStatus({ tone: 'err', text: `Error: ${errorText(e)}` })
    } finally {
      setUploading(false)
    }
  }

  /** The edited mapping, or null after showing why it is not one. */
  const parsed = () => {
    const r = parseMapping(text)
    if ('error' in r) {
      setJsonError(r.error)
      return null
    }
    return r.mapping
  }

  const activate = async (mapping: Mapping, done: string) => {
    try {
      await activateMapping(qc, mapping)
      setMappingDraft(undefined)
      setMappingStatus({ tone: 'ok', text: done })
    } catch (e) {
      setMappingStatus({ tone: 'err', text: `Save error: ${errorText(e)}` })
    }
  }

  const saveActive = () => {
    const mapping = parsed()
    if (mapping) void activate(mapping, 'Mapping saved.')
  }

  /** Rejects (keeping the typed name) when the mapping is not saved; the reason is shown here. */
  const saveAs = async (name: string) => {
    const mapping = parsed()
    if (!mapping) throw new Error('invalid mapping')
    try {
      await saveNamedMapping(qc, name, mapping)
      setMappingStatus({ tone: 'ok', text: `Saved "${name}".` })
    } catch (e) {
      setMappingStatus({ tone: 'err', text: `Error: ${errorText(e)}` })
      throw e
    }
  }

  const remove = async (name: string) => {
    try {
      await deleteNamedMapping(qc, name)
      setMappingStatus({ tone: 'ok', text: `Deleted "${name}".` })
    } catch (e) {
      setMappingStatus({ tone: 'err', text: `Error: ${errorText(e)}` })
      throw e
    }
  }

  const load = (name: string, mapping: Mapping) => {
    setMappingDraft(pretty(mapping))
    setJsonError('')
    void activate(mapping, `Loaded "${name}".`)
  }

  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5">
      <div>
        <h2 id={id} className="text-sm font-semibold">Workflow</h2>
        <p className="mt-1 text-xs text-text-dim">
          Upload a workflow (a <code className="font-mono">.json</code> from ComfyUI — Save "API Format" — or any{' '}
          <code className="font-mono">.png</code> generated by ComfyUI; the workflow lives in its metadata)
        </p>
      </div>
      <WorkflowDrop onFile={(f) => void upload(f)} busy={uploading} />
      <StatusLine status={status} />

      {active && (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <h3 className="text-sm font-medium">Detected node mapping (you can override and save)</h3>
          <MappingBadges mapping={active} />
          <NamedLibrary
            title="mapping"
            items={mappings.data ?? {}}
            onLoad={load}
            onSave={saveAs}
            onDelete={remove}
            describe={(m) => slotsText(loraSlots(m))}
          />
          <div className="flex flex-col gap-1.5">
            <textarea
              aria-label="Mapping JSON"
              spellCheck={false}
              value={text}
              onChange={(e) => {
                setMappingDraft(e.target.value)
                setJsonError('')
              }}
              aria-invalid={jsonError ? true : undefined}
              aria-describedby={jsonError ? `${id}-json-error` : undefined}
              className="min-h-56 w-full resize-y rounded-lg border border-line bg-bg/60 px-3 py-2.5 font-mono text-xs leading-relaxed outline-none focus-visible:border-accent-from/60 focus-visible:shadow-glow aria-invalid:border-danger/60"
            />
            {jsonError && <p id={`${id}-json-error`} className="text-xs text-danger">{jsonError}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" onClick={saveActive}>
              <Save />
              Save mapping (active)
            </Button>
            <StatusLine status={mappingStatus} />
          </div>
        </div>
      )}
    </section>
  )
}
