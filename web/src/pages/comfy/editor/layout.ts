// Import-free (the unit tests load it in Node).

/** The node box and the gaps, as the classic graph has them. */
export const NODE_W = 170
export const NODE_H = 36
const COL_GAP = 60
const ROW_GAP = 24
const MARGIN = 12

export interface GraphLayout {
  /** Top-left corner of every node's box, in the workflow's order. */
  nodes: { id: string; x: number; y: number }[]
  /** One per link input (two inputs from one source are two links). */
  links: { from: string; to: string }[]
  width: number
  height: number
}

type Workflow = Record<string, { inputs?: Record<string, unknown> } | undefined>

/** `[source id, output slot]` (the same rule as schema.ts `isLinkValue`). */
const linkSource = (v: unknown) => (Array.isArray(v) && v.length >= 2 && typeof v[0] !== 'object' ? String(v[0]) : null)

/**
 * Layers by the longest path from a source (a node no link feeds): layer i is
 * column i, a column's nodes go down by numeric id. Links to nodes that are
 * not in the workflow are left out; a cycle is cut where it closes.
 */
export function layoutGraph(workflow: Workflow): GraphLayout {
  const ids = Object.keys(workflow)
  const links: GraphLayout['links'] = []
  const incoming = new Map<string, string[]>()
  for (const id of ids) {
    const ups: string[] = []
    for (const v of Object.values(workflow[id]?.inputs ?? {})) {
      const from = linkSource(v)
      if (from !== null && Object.hasOwn(workflow, from)) {
        ups.push(from)
        links.push({ from, to: id })
      }
    }
    incoming.set(id, ups)
  }

  // Memoised, with one set of the nodes on the current path (a source found on it closes a cycle: 0).
  const layer = new Map<string, number>()
  const onPath = new Set<string>()
  const depth = (id: string): number => {
    const known = layer.get(id)
    if (known !== undefined) return known
    if (onPath.has(id)) return 0
    onPath.add(id)
    let d = 0
    for (const up of incoming.get(id) ?? []) d = Math.max(d, depth(up) + 1)
    onPath.delete(id)
    layer.set(id, d)
    return d
  }
  for (const id of ids) depth(id)

  const columns = new Map<number, string[]>()
  for (const id of ids) {
    const l = layer.get(id) ?? 0
    const col = columns.get(l)
    if (col) col.push(id)
    else columns.set(l, [id])
  }
  const pos = new Map<string, { x: number; y: number }>()
  for (const [l, col] of columns) {
    col.sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0))
    col.forEach((id, i) => pos.set(id, { x: MARGIN + l * (NODE_W + COL_GAP), y: MARGIN + i * (NODE_H + ROW_GAP) }))
  }

  const nodes = ids.map((id) => ({ id, ...pos.get(id)! }))
  return {
    nodes,
    links,
    width: Math.max(...nodes.map((n) => n.x + NODE_W), 200) + 16,
    height: Math.max(...nodes.map((n) => n.y + NODE_H), 100) + 16,
  }
}

/** What the layout depends on (the ids and their link sources), so an edited field does not lay it out again. */
export function linkSignature(workflow: Workflow): string {
  return Object.keys(workflow)
    .map((id) => [id, ...Object.values(workflow[id]?.inputs ?? {}).map(linkSource).filter((s) => s !== null)].join('\u0000'))
    .join('\u0001')
}
