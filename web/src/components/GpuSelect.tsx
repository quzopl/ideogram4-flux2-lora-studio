import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useGpus } from '@/lib/queries'

// Radix Select forbids an empty item value, so "" (role default) travels as this.
const DEFAULT = '__role_default__'

interface GpuSelectProps {
  /** "auto", "cpu", a card UUID, or "" for the role default. */
  value: string
  onChange: (value: string) => void
  /** Adds "Role default" (value ""). */
  includeDefault?: boolean
  /** Leaves out "CPU" (for roles that must not run there) unless it is the value. */
  hideCpu?: boolean
  /** Leaves out "Auto" (for callers that take only "", "cpu" or a UUID) unless it is the value. */
  hideAuto?: boolean
  /** Accessible name of the trigger. */
  label?: string
  id?: string
}

export function GpuSelect({ value, onChange, includeDefault = false, hideCpu = false, hideAuto = false, label = 'Device', id }: GpuSelectProps) {
  const gpus = useGpus()
  return (
    <Select
      value={value === '' && includeDefault ? DEFAULT : value}
      onValueChange={(v) => onChange(v === DEFAULT ? '' : v)}
    >
      <SelectTrigger id={id} aria-label={label} className="min-w-56">
        <SelectValue placeholder="Choose a device" />
      </SelectTrigger>
      <SelectContent>
        {includeDefault && <SelectItem value={DEFAULT}>Role default</SelectItem>}
        {(!hideAuto || value === 'auto') && <SelectItem value="auto">Auto (most memory)</SelectItem>}
        {gpus.isPending && <Skeleton className="mx-1.5 my-1 h-6" />}
        {gpus.data?.gpus.map((g) => (
          <SelectItem key={g.uuid} value={g.uuid}>{g.label}</SelectItem>
        ))}
        {(!hideCpu || value === 'cpu') && <SelectItem value="cpu">CPU</SelectItem>}
      </SelectContent>
    </Select>
  )
}
