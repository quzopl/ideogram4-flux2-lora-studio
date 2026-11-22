import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'

/**
 * A whole-number input that only reports valid numbers (no NaN is ever saved).
 * Text that is not one (empty, a fraction, out of range) stays as typed, is
 * marked invalid with its error, and is reported through `onValidity`.
 */
export function NumberInput<F extends string>({ id, field, value, onChange, onValidity, min, max, step, title }: {
  id: string
  field: F
  value: number
  onChange: (v: number) => void
  onValidity: (field: F, error: string) => void
  min: number
  max: number
  step?: number
  title?: string
}) {
  const [text, setText] = useState(String(value))
  // A value set elsewhere (a preset, the saved form) replaces the typed text.
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setText(String(value))
  }
  const n = text.trim() === '' ? NaN : Number(text)
  const error = Number.isInteger(n) && n >= min && n <= max ? '' : `Enter a whole number from ${min} to ${max}`
  useEffect(() => onValidity(field, error), [field, error, onValidity])
  return (
    <>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
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
          if (Number.isInteger(v) && v >= min && v <= max) onChange(v)
        }}
        // A valid number is shown as saved ("0100" -> "100"); an invalid one stays to be fixed.
        onBlur={() => !error && setText(String(value))}
        className="font-mono"
      />
      {error && <p id={`${id}-error`} className="text-xs text-danger">{error}</p>}
    </>
  )
}
