const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** One decimal below 10 of a unit, none above: "1.2 GB", "67 MB" (1024 steps, like the backend's GB). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  let i = 0
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  const digits = i === 0 || n >= 10 ? 0 : 1
  return `${n.toFixed(digits)} ${UNITS[i]}`
}

/** A size already in GB (nvidia-smi VRAM): "7.4 GB", "16 GB". */
export function formatGb(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)} GB`
}
