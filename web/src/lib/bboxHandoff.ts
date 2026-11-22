const KEY = 'flux.bbox.handoff'

/**
 * Opens a v15 JSON prompt in the Bbox editor. Until /bbox is ported that is
 * the classic editor, which picks the prompt up from sessionStorage.
 */
export function handOffToBbox(json: string): void {
  try {
    sessionStorage.setItem(KEY, json)
  } catch {
    // Storage blocked: the editor opens empty.
  }
  window.location.assign('/legacy/#bbox')
}
