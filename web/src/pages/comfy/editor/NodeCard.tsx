import { ChevronDown } from 'lucide-react'
import { createContext, memo, useContext, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { setInput, setSubInput } from './editorStore'
import { FieldControl } from './FieldControl'
import { fieldSchema, isDictValue, isLinkValue, type KnownEnums, type ObjectInfo, type WorkflowNode } from './schema'

/** What every card reads besides its own node: the schemas and the class of every node (for link labels). */
export interface CardContext {
  info: ObjectInfo | null
  enums: KnownEnums | null
  classTypes: Record<string, string>
  focusNode: (id: string) => void
}

export const EditorCardContext = createContext<CardContext>({ info: null, enums: null, classTypes: {}, focusNode: () => {} })

interface NodeCardProps {
  id: string
  node: WorkflowNode
  collapsed: boolean
  /** Not matching the filter: shown faded. */
  dimmed: boolean
  /** Just jumped to: highlighted for a moment. */
  flash: boolean
  onToggle: (id: string) => void
}

const domId = (s: string) => s.replace(/[^\w-]/g, '_')

/** How an input is shown: a read-only link, dict sub-rows, JSON (a list that is not a link), or one control. */
type RowKind = 'link' | 'dict' | 'json' | 'scalar'

const rowKind = (v: unknown): RowKind =>
  isLinkValue(v) ? 'link' : isDictValue(v) ? 'dict' : Array.isArray(v) ? 'json' : 'scalar'

/**
 * Each input's row kind as the node had it when the card mounted: a JSON edit
 * that changes the shape (e.g. to `[1, 2]`, a link's shape) keeps its control.
 */
function useRowKinds(values: Record<string, unknown>) {
  const [kinds] = useState(() => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, rowKind(v)])))
  return (k: string) => kinds[k] ?? rowKind(values[k])
}

/** The card's element id (a link or the graph scrolls to it). */
export const nodeCardId = (id: string) => `edn-${domId(id)}`

/** One node: `#id class_type`, its literal inputs as controls, then its links (read only). */
export const NodeCard = memo(function NodeCard({ id, node, collapsed, dimmed, flash, onToggle }: NodeCardProps) {
  const { info, enums, classTypes, focusNode } = useContext(EditorCardContext)
  const cardId = nodeCardId(id)
  const inputs = node.inputs ?? {}
  const kindOf = useRowKinds(inputs)
  const fields = Object.entries(inputs)
  const literals = fields.filter(([k]) => kindOf(k) !== 'link')
  const links = fields.filter(([k, v]) => kindOf(k) === 'link' && isLinkValue(v)) as [string, [string | number, number]][]

  return (
    <section
      id={cardId}
      aria-labelledby={`${cardId}-h`}
      data-class-type={node.class_type ?? ''}
      data-dimmed={dimmed || undefined}
      className={cn(
        'scroll-my-24 rounded-xl border bg-bg/40 transition-[opacity,border-color,box-shadow] duration-300',
        dimmed && 'opacity-25',
        flash ? 'border-accent-to/70 shadow-glow' : 'border-line',
      )}
    >
      <button
        id={`${cardId}-h`}
        type="button"
        aria-expanded={!collapsed}
        onClick={() => onToggle(id)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm outline-none hover:bg-white/[0.02] focus-visible:shadow-glow"
      >
        <span className="font-mono text-xs text-accent-to">#{id}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{node.class_type || '(unknown)'}</span>
        <ChevronDown aria-hidden className={cn('size-4 text-text-dim transition-transform', collapsed && '-rotate-90')} />
      </button>
      {/* Hidden, not unmounted: a field's typed text (and its error) stays while the card is collapsed. */}
      <div hidden={collapsed} className="flex flex-col gap-2 border-t border-line px-3 py-3">
        {fields.length === 0 && <p className="text-xs text-text-dim">No inputs.</p>}
        {literals.map(([field, value]) => {
          const fid = `${cardId}-f-${domId(field)}`
          const key = `${id}.${field}`
          const kind = kindOf(field)
          if (kind === 'dict') {
            return (
              <Row key={field} label={field}>
                <DictRows id={id} field={field} dict={isDictValue(value) ? value : {}} fid={fid} enums={enums} />
              </Row>
            )
          }
          return (
            <Row key={field} label={field} htmlFor={fid}>
              <FieldControl
                id={fid}
                fieldKey={key}
                name={field}
                value={value}
                schema={fieldSchema(info, enums, node.class_type, field, value)}
                json={kind === 'json'}
                onChange={(v, opts) => setInput(id, field, v, opts)}
              />
            </Row>
          )
        })}
        {links.map(([field, [src, out]]) => {
          const source = String(src)
          return (
            <Row key={field} label={field}>
              <button
                type="button"
                title="Click to jump to the source"
                onClick={() => focusNode(source)}
                className="justify-self-start rounded-md px-1.5 py-0.5 text-left font-mono text-xs text-text-dim outline-none hover:bg-white/[0.04] hover:text-accent-to focus-visible:shadow-glow"
              >
                → #{source} ({classTypes[source] ?? '?'}) · output {out}
              </button>
            </Row>
          )
        })}
      </div>
    </section>
  )
})

/** A label and its control (or read-only content). */
function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  const name = <span title={label} className="truncate font-mono text-xs text-text-dim">{label}</span>
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-x-3">
      {htmlFor ? <label htmlFor={htmlFor} className="min-w-0 truncate">{name}</label> : <div className="min-w-0">{name}</div>}
      {children}
    </div>
  )
}

/** A dict input (e.g. rgthree Power Lora Loader `lora_1 = {on, lora, strength}`): one row per key. */
function DictRows({ id, field, dict, fid, enums }: {
  id: string
  field: string
  dict: Record<string, unknown>
  fid: string
  enums: KnownEnums | null
}) {
  const kindOf = useRowKinds(dict)
  const keys = Object.keys(dict)
  if (keys.length === 0) return <p className="text-xs text-text-dim">(empty object)</p>
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-bg/40 p-2">
      {keys.map((k) => {
        const v = dict[k]
        const sid = `${fid}-${domId(k)}`
        return (
          <Row key={k} label={k} htmlFor={sid}>
            <FieldControl
              id={sid}
              fieldKey={`${id}.${field}.${k}`}
              name={k}
              value={v}
              schema={fieldSchema(null, enums, undefined, k, v)}
              json={kindOf(k) !== 'scalar'}
              onChange={(nv, opts) => setSubInput(id, field, k, nv, opts)}
            />
          </Row>
        )
      })}
    </div>
  )
}
