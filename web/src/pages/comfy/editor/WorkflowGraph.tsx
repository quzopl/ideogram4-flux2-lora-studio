import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { useComfyJobs, useSlotJob } from '../comfyJobStore'
import { layoutGraph, linkSignature, NODE_H, NODE_W } from './layout'
import type { Workflow } from './schema'

interface WorkflowGraphProps {
  workflow: Workflow
  /** The class of every node (memoised by the editor: new only when a class changes). */
  classTypes: Record<string, string>
  /** Opens and shows the node's card. */
  onFocus: (id: string) => void
  /** The node just jumped to, outlined. */
  selected: string | null
}

const label = (s: string) => (s.length > 22 ? `${s.slice(0, 21)}…` : s)

/**
 * The workflow as a layered graph (sources on the left): a node opens its card,
 * and the editor job's executing node is highlighted (class `active`).
 */
export function WorkflowGraph({ workflow, classTypes, onFocus, selected }: WorkflowGraphProps) {
  // Laid out again only when the links change, not when a field is edited.
  const sig = linkSignature(workflow)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` is all of the workflow the layout reads
  const layout = useMemo(() => layoutGraph(workflow), [sig])
  const jobId = useComfyJobs().editor.jobId
  const current = useSlotJob(jobId, { poll: false }).data?.current_node
  const active = jobId && current ? String(current) : null

  const svg = useMemo(() => {
    const pos = new Map(layout.nodes.map((n) => [n.id, n]))
    return (
      <svg
        role="group"
        aria-label="Workflow graph"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="font-mono text-[11px]"
      >
        {/* Links first, under the nodes: right middle of the source to left middle of the target. */}
        {layout.links.map(({ from, to }, i) => {
          const a = pos.get(from)!
          const b = pos.get(to)!
          const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2
          const x2 = b.x, y2 = b.y + NODE_H / 2
          const cp = Math.max(30, Math.abs(x2 - x1) * 0.4)
          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`}
              strokeWidth={1.2}
              className="fill-none stroke-text-dim/60"
            />
          )
        })}
        {layout.nodes.map(({ id, x, y }) => {
          const cls = classTypes[id] || '?'
          const on = active === id
          return (
            <g
              key={id}
              data-node-id={id}
              transform={`translate(${x}, ${y})`}
              role="button"
              tabIndex={0}
              aria-label={`#${id} ${cls}`}
              onClick={() => onFocus(id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onFocus(id)
                }
              }}
              className={cn('group cursor-pointer outline-none', on && 'active')}
            >
              <title>{cls}</title>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={6}
                strokeWidth={1.5}
                className={cn(
                  'transition-colors group-hover:stroke-accent-to/70 group-focus-visible:stroke-accent-to',
                  on ? 'fill-accent-from/25 stroke-accent-to' : 'fill-surface-2',
                  !on && (selected === id ? 'stroke-accent-to/70' : 'stroke-white/15'),
                )}
              />
              <text x={8} y={14} className="fill-text-dim">#{id}</text>
              <text x={8} y={28} className="fill-text">{label(cls)}</text>
            </g>
          )
        })}
      </svg>
    )
  }, [layout, classTypes, onFocus, selected, active])

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-text-dim">Click a node in the graph to jump to its parameters below.</p>
      <div className="max-h-[480px] overflow-auto rounded-lg border border-line bg-bg/60">{svg}</div>
    </div>
  )
}
