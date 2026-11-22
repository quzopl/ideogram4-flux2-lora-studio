/**
 * Copies `text`. navigator.clipboard needs a secure context (not plain http
 * on the LAN), so it falls back to execCommand("copy") on a temporary
 * textarea, as the classic UI does. Rejects if neither works.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Denied: try the fallback.
    }
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  if (!ok) throw new Error('The browser did not allow copying.')
}
