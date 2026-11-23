// The workflow editor's schema helpers (port of the classic editor). No imports: the unit spec loads this file in Node.

/** One node of an API-format workflow. */
export interface WorkflowNode {
  class_type?: string
  inputs?: Record<string, unknown>
  [k: string]: unknown
}

/** An API-format ComfyUI workflow: node id -> node. */
export type Workflow = Record<string, WorkflowNode>

/** One input's spec in ComfyUI's /object_info: `[type or choices, meta]`. */
export type FieldSchema = [unknown, Record<string, unknown>?]

interface NodeInfo {
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }
}

/** ComfyUI's /object_info: class_type -> its schema. */
export type ObjectInfo = Record<string, NodeInfo>

/** Field name -> the union of its choices over every node type (sorted). */
export type KnownEnums = Record<string, string[]>

/** A link to another node's output: `[source id, output index]`. */
export const isLinkValue = (v: unknown): v is [string | number, number] =>
  Array.isArray(v) && v.length >= 2 && typeof v[0] !== 'object'

export const isDictValue = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const sections = (node: NodeInfo | undefined) => [node?.input?.required ?? {}, node?.input?.optional ?? {}]

/**
 * Every enum field of every node type, by field name: a field of the same name
 * usually shares its choices across nodes (e.g. `lora_name`).
 */
export function buildKnownEnums(info: ObjectInfo | null | undefined): KnownEnums {
  const map: Record<string, Set<string>> = {}
  for (const node of Object.values(info ?? {})) {
    for (const fields of sections(node)) {
      for (const [name, spec] of Object.entries(fields)) {
        if (Array.isArray(spec) && Array.isArray(spec[0])) {
          const set = (map[name] ??= new Set())
          for (const c of spec[0]) set.add(String(c))
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v].sort()]))
}

/** The field's spec from the node type's schema (required, then optional). */
export function getSchema(info: ObjectInfo | null | undefined, classType: string | undefined, field: string): FieldSchema | null {
  if (!info || !classType) return null
  for (const fields of sections(info[classType])) {
    const spec = fields[field]
    if (Array.isArray(spec)) return spec as FieldSchema
  }
  return null
}

/** Name heuristics, in order: a field containing the first matches the enum named second. */
const BY_NAME: [(n: string) => boolean, string][] = [
  [(n) => n.includes('lora'), 'lora_name'],
  [(n) => n.includes('ckpt') || n.includes('checkpoint') || n === 'model', 'ckpt_name'],
  [(n) => n.includes('unet'), 'unet_name'],
  [(n) => n.includes('vae'), 'vae_name'],
  [(n) => n.includes('clip_name'), 'clip_name1'],
  [(n) => n.includes('sampler'), 'sampler_name'],
  [(n) => n.includes('scheduler'), 'scheduler'],
]

/** A dropdown guessed from the field name (for a node type ComfyUI has no schema for, e.g. a custom node). */
export function getSchemaForName(enums: KnownEnums | null | undefined, field: string): FieldSchema | null {
  if (!enums) return null
  if (enums[field]) return [enums[field], {}]
  const n = field.toLowerCase()
  for (const [match, name] of BY_NAME) {
    if (match(n) && enums[name]) return [enums[name], {}]
  }
  return null
}

/**
 * The spec when it picks a control (a list of choices, BOOLEAN, INT, FLOAT,
 * STRING); null for anything else (e.g. a connection type), so the control
 * follows the value.
 */
export function controlSchema(schema: FieldSchema | null): FieldSchema | null {
  if (!schema) return null
  const t = schema[0]
  return Array.isArray(t) || t === 'BOOLEAN' || t === 'INT' || t === 'FLOAT' || t === 'STRING' ? schema : null
}

/** How a number field is read: fractions or whole numbers, within optional bounds. */
export interface NumberSpec {
  decimal: boolean
  min?: number
  max?: number
  step?: number
}

/** Names whose value is a fraction even when the workflow holds a whole one (`1.0` arrives as `1`). */
const DECIMAL_NAME = /^(cfg|denoise|shift|strength.*|.*_strength)$/i

/** ComfyUI's "no limit" maxima (e.g. the seed's 2^64) are not bounds a field can show. */
const NO_MAX = 1e15

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * The number field for `value`: from an INT or FLOAT schema (its min, max and
 * step; FLOAT steps 0.01 by default), else from the value and the field name
 * (a fraction, or a name like `cfg` or `*_strength`, takes fractions). Null
 * when the field is not a number.
 */
export function numberSpec(schema: FieldSchema | null, value: unknown, field: string): NumberSpec | null {
  const type = schema?.[0]
  if (type === 'INT' || type === 'FLOAT') {
    const meta = schema?.[1] ?? {}
    const min = num(meta.min), max = num(meta.max), step = num(meta.step)
    return {
      decimal: type === 'FLOAT',
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined && max < NO_MAX ? { max } : {}),
      ...(step !== undefined ? { step } : type === 'FLOAT' ? { step: 0.01 } : {}),
    }
  }
  if (schema || typeof value !== 'number') return null
  const decimal = !Number.isInteger(value) || DECIMAL_NAME.test(field)
  return { decimal, step: decimal ? 0.01 : 1 }
}

/** A JSON field's text: its value, or why it is not JSON. */
export function parseJson(text: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text) }
  } catch (e) {
    return { error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Node ids by number when both are numbers, else alphabetically (classic). */
export function sortNodeIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
    return a.localeCompare(b)
  })
}

/** The enum value to show and save: a Windows path (`a\b`) becomes the listed `a/b`. */
export function fixEnumValue(choices: unknown[], value: unknown): string {
  const s = value == null ? '' : String(value)
  const listed = choices.map(String)
  if (s && !listed.includes(s)) {
    const fixed = s.replace(/\\/g, '/')
    if (listed.includes(fixed)) return fixed
  }
  return s
}
