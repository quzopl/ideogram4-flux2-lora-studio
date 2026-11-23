import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { dropJob, finishJob, useComfyJobs, useSlotJob, type SlotName } from './comfyJobStore'
import { isJobEnd } from './pollJob'
import { GALLERY_KEY } from './queries'

const SLOTS: SlotName[] = ['lora', 'editor']

/**
 * Follows the running jobs whichever tab is shown (mounted by ComfyPage outside
 * the tab panel): an ended job becomes its slot's outcome and the gallery is
 * fetched again; a job the server no longer knows is dropped.
 */
export function JobObservers() {
  return SLOTS.map((slot) => <SlotObserver key={slot} slot={slot} />)
}

function SlotObserver({ slot }: { slot: SlotName }) {
  const jobId = useComfyJobs()[slot].jobId
  const { data, isGone } = useSlotJob(jobId)
  const qc = useQueryClient()
  useEffect(() => {
    if (!jobId) return
    if (data && isJobEnd(data.state)) {
      if (finishJob(slot, jobId, data)) qc.invalidateQueries({ queryKey: GALLERY_KEY })
    } else if (isGone) {
      toast.error('The ComfyUI job is gone (was the server restarted?)')
      dropJob(slot, jobId)
    }
  }, [slot, jobId, data, isGone, qc])
  return null
}
