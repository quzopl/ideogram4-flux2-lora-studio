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
  id?: string
}

export function GpuSelect({ value, onChange, includeDefault = false, id }: GpuSelectProps) {
  const gpus = useGpus()
  return (
    <Select
      value={value === '' && includeDefault ? DEFAULT : value}
      onValueChange={(v) => onChange(v === DEFAULT ? '' : v)}
    >
      <SelectTrigger id={id} aria-label="Device" className="min-w-56">
        <SelectValue placeholder="Choose a device" />
      </SelectTrigger>
      <SelectContent>
        {includeDefault && <SelectItem value={DEFAULT}>Role default</SelectItem>}
        <SelectItem value="auto">Auto (most memory)</SelectItem>
        {gpus.isPending && <Skeleton className="mx-1.5 my-1 h-6" />}
        {gpus.data?.gpus.map((g) => (
          <SelectItem key={g.uuid} value={g.uuid}>{g.label}</SelectItem>
        ))}
        <SelectItem value="cpu">CPU</SelectItem>
      </SelectContent>
    </Select>
  )
}
