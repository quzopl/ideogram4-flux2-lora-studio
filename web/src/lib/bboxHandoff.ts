import { useCallback } from 'react'
import { useNavigate } from 'react-router'

const KEY = 'flux.bbox.handoff'

/** Opens a v15 JSON prompt in the Bbox editor (/bbox), which takes it from sessionStorage. */
export function useHandOffToBbox(): (json: string) => void {
  const navigate = useNavigate()
  return useCallback(
    (json: string) => {
      try {
        sessionStorage.setItem(KEY, json)
      } catch {
        // Storage blocked: the editor opens with its draft.
      }
      void navigate('/bbox')
    },
    [navigate],
  )
}

// Moved here out of sessionStorage, so a repeated claim (StrictMode calls
// initializers twice) finds the same prompt instead of nothing.
let claimed: string | null = null

/** Moves a handed-over prompt out of sessionStorage (it is used once); returns it. */
export function claimBboxHandoff(): string | null {
  try {
    const json = sessionStorage.getItem(KEY)
    if (json !== null) {
      sessionStorage.removeItem(KEY)
      claimed = json
    }
  } catch {
    // Storage blocked: nothing was handed over.
  }
  return claimed
}

/** The claimed prompt, once: later calls get null. */
export function takeBboxHandoff(): string | null {
  const json = claimed
  claimed = null
  return json
}
