import { useEffect, useState } from 'react'

/** `value`, once it has not changed for `ms`. */
export function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}
