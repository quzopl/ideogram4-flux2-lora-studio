import { cn } from '@/lib/utils'

/** A one-line outcome under a control: `ok` green, `err` red, `info` dim. */
export interface Status {
  tone: 'ok' | 'err' | 'info'
  text: string
}

export function StatusLine({ status, className }: { status: Status | null; className?: string }) {
  return (
    <p
      role="status"
      className={cn(
        'min-h-4 text-xs break-words',
        status?.tone === 'ok' ? 'text-success' : status?.tone === 'err' ? 'text-danger' : 'text-text-dim',
        className,
      )}
    >
      {status?.text}
    </p>
  )
}
