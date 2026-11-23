import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'

/**
 * A whole-number input (any number with `decimal`) that only reports valid
 * numbers (no NaN is ever saved). Text that is not one (empty, a fraction, out
 * of range) stays as typed, is marked invalid with its error, and is reported
 * through `onValidity`. A missing bound is no limit; a null value shows empty.
 */
export function NumberInput<F extends string>({ id, field, value, onChange, onValidity, min, max, step, title, decimal }: {
  id: string
  field: F
  value: number | null
  onChange: (v: number) => void
  onValidity: (field: F, error: string) => void
  min?: number
  max?: number
  step?: number
  title?: string
  decimal?: boolean
}) {
  const [text, setText] = useState(String(value ?? ''))
  // A value set elsewhere (a preset, the saved form) replaces the typed text.
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setText(String(value ?? ''))
  }
  const valid = (v: number) =>
    (decimal ? Number.isFinite(v) : Number.isInteger(v)) && (min === undefined || v >= min) && (max === undefined || v <= max)
  const n = text.trim() === '' ? NaN : Number(text)
  const range =
    min !== undefined && max !== undefined ? ` from ${min} to ${max}`
      : min !== undefined ? ` of at least ${min}`
        : max !== undefined ? ` of at most ${max}`
          : ''
  const error = valid(n) ? '' : `Enter a ${decimal ? '' : 'whole '}number${range}`
  useEffect(() => onValidity(field, error), [field, error, onValidity])
  return (
    <>
      <Input
        id={id}
        type="number"
        inputMode={decimal ? 'decimal' : 'numeric'}
        min={min}
        max={max}
        step={step}
        title={title}
        value={text}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => {
          setText(e.target.value)
          const v = e.target.valueAsNumber
          if (valid(v)) onChange(v)
        }}
        // A valid number is shown as saved ("0100" -> "100"); an invalid one stays to be fixed.
        onBlur={() => !error && setText(String(value ?? ''))}
        className="font-mono"
      />
      {error && <p id={`${id}-error`} className="text-xs text-danger">{error}</p>}
    </>
  )
}
