import { useEffect, useState } from 'react'
import { NumberInput } from '@/components/NumberInput'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { setInvalid, type WriteOptions } from './editorStore'
import { controlSchema, fixEnumValue, numberSpec, parseJson, type FieldSchema } from './schema'

const box =
  'w-full rounded-lg border border-line bg-bg/60 px-2.5 py-1.5 text-sm outline-none focus-visible:border-accent-from/60 focus-visible:shadow-glow aria-invalid:border-danger/60'

interface FieldControlProps {
  /** The DOM id its label points at. */
  id: string
  /** Its key in the store's `invalid` ("<node id>.<field>[.<key>]"). */
  fieldKey: string
  /** The field name (a number without a schema reads fractions by it). */
  name: string
  value: unknown
  /** From /object_info, else guessed from the name; null: the control follows the value. */
  schema: FieldSchema | null
  /** Only valid values come here; an invalid text is marked in the store instead. */
  onChange: (value: unknown, opts?: WriteOptions) => void
  /** A nested object or list: edited as JSON. */
  json?: boolean
}

/**
 * The control for one literal input of a node: a select for a list of
 * choices, a checkbox, a number field, JSON for nested values, else text.
 */
export function FieldControl({ id, fieldKey, name, value, schema, onChange, json = false }: FieldControlProps) {
  // The kind follows the value the field started with: typing must not swap the control under the cursor.
  const [initial] = useState(value)
  const spec = controlSchema(schema)
  const type = spec?.[0]
  const num = numberSpec(spec, initial, name)
  const kind = json ? 'json' : Array.isArray(type) ? 'enum' : type === 'BOOLEAN' || (!spec && typeof initial === 'boolean') ? 'bool' : num ? 'number' : 'text'
  // A control that goes away (unmounted, or another kind once the schemas arrive) takes its error with it:
  // nothing could clear it later. The new control reports its own validity.
  useEffect(() => () => setInvalid(fieldKey, null), [fieldKey, kind])

  if (json) return <JsonField id={id} fieldKey={fieldKey} value={value} onChange={onChange} />
  if (Array.isArray(type)) return <EnumField id={id} choices={type} value={value} onChange={onChange} />
  if (kind === 'bool') {
    return (
      <input
        id={id}
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 justify-self-start accent-accent-from"
      />
    )
  }
  if (num) {
    return (
      <NumberInput
        id={id}
        field={fieldKey}
        value={typeof value === 'number' ? value : null}
        onChange={onChange}
        onValidity={setInvalid}
        min={num.min}
        max={num.max}
        step={num.step}
        decimal={num.decimal}
      />
    )
  }
  if (!spec && initial == null) {
    return (
      <Input
        id={id}
        placeholder="(null)"
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="font-mono"
      />
    )
  }
  const start = typeof initial === 'string' ? initial : String(initial ?? '')
  const multi = (type === 'STRING' && spec?.[1]?.multiline === true) || start.length > 60 || start.includes('\n')
  const text = value == null ? '' : String(value)
  return multi ? (
    <textarea id={id} rows={3} value={text} onChange={(e) => onChange(e.target.value)} className={cn(box, 'min-h-16 resize-y')} />
  ) : (
    <Input id={id} value={text} onChange={(e) => onChange(e.target.value)} />
  )
}

/** A list of choices; a value not on it stays, marked "(from workflow)". */
function EnumField({ id, choices, value, onChange }: {
  id: string
  choices: unknown[]
  value: unknown
  onChange: (value: unknown, opts?: WriteOptions) => void
}) {
  const shown = fixEnumValue(choices, value)
  // A Windows path the list has with "/" is saved as listed (ComfyUI would not find it); not an edit.
  useEffect(() => {
    if (typeof value === 'string' && shown !== value) onChange(shown, { normalize: true })
  }, [value, shown, onChange])
  const listed = choices.map(String)
  const extra = shown !== '' && !listed.includes(shown)
  return (
    <select
      id={id}
      value={shown}
      onChange={(e) => {
        const i = listed.indexOf(e.target.value)
        // A choice keeps its own type; the workflow's own value is kept as it was.
        onChange(i >= 0 ? choices[i] : value)
      }}
      className={cn(box, 'font-mono text-xs')}
    >
      {extra && <option value={shown}>{shown} (from workflow)</option>}
      {listed.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  )
}

/** A nested value as JSON: taken only while it parses (else the field is invalid). */
function JsonField({ id, fieldKey, value, onChange }: {
  id: string
  fieldKey: string
  value: unknown
  onChange: (value: unknown) => void
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const parsed = parseJson(text)
  const error = 'error' in parsed ? parsed.error : ''
  useEffect(() => setInvalid(fieldKey, error), [fieldKey, error])
  return (
    <div className="flex flex-col gap-1">
      <textarea
        id={id}
        rows={3}
        spellCheck={false}
        value={text}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => {
          setText(e.target.value)
          const r = parseJson(e.target.value)
          if ('value' in r) onChange(r.value)
        }}
        className={cn(box, 'min-h-16 resize-y font-mono text-xs')}
      />
      {error && <p id={`${id}-error`} className="text-xs text-danger">{error}</p>}
    </div>
  )
}
