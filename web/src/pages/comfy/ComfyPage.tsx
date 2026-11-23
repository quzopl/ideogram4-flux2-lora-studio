import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useId } from 'react'
import { useSearchParams } from 'react-router'
import { cn } from '@/lib/utils'
import { ConnectionCard } from './ConnectionCard'
import { flushComfyForm } from './formStore'
import { GalleryTab } from './GalleryTab'
import { JobObservers } from './JobObservers'
import { LoraTestTab } from './LoraTestTab'

const TABS = [
  ['lora', 'LoRA test'],
  ['batch', 'Reference batch'],
  ['editor', 'Workflow editor'],
  ['gallery', 'Gallery'],
] as const

type Tab = (typeof TABS)[number][0]

const isTab = (v: string | null): v is Tab => TABS.some(([t]) => t === v)

/** The ComfyUI view: the connection, then one tab at a time (the active one is `?tab=`). */
export function ComfyPage() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = isTab(raw) ? raw : 'lora'
  const uid = useId()
  useEffect(() => flushComfyForm, [])

  return (
    <div className="flex flex-col gap-6 px-10 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">ComfyUI</h1>
        <p className="mt-1 text-sm text-text-dim">
          Test LoRAs and generate images on a ComfyUI server, edit workflows and browse what they made.
        </p>
      </div>

      <ConnectionCard />
      {/* Outside the tab panel: a job is followed (and the gallery refreshed) whichever tab is shown. */}
      <JobObservers />

      <div role="tablist" aria-label="ComfyUI sections" className="flex w-fit flex-wrap gap-1 rounded-xl border border-line bg-bg/60 p-1">
        {TABS.map(([t, label]) => {
          const active = t === tab
          return (
            <button
              key={t}
              type="button"
              role="tab"
              id={`${uid}-tab-${t}`}
              aria-selected={active}
              aria-controls={`${uid}-panel`}
              // Only the tab: any other parameter (e.g. a gallery image) belongs to the tab being left.
              onClick={() => setParams(new URLSearchParams({ tab: t }))}
              className={cn(
                'relative rounded-lg px-3.5 py-1.5 text-sm transition-colors outline-none focus-visible:shadow-glow',
                active ? 'text-white' : 'text-text-dim hover:text-text',
              )}
            >
              {active && (
                <motion.span
                  layoutId="comfy-tab"
                  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  className="absolute inset-0 rounded-lg bg-linear-to-r from-accent-from to-accent-to shadow-[0_0_16px_rgba(139,92,246,0.35)]"
                />
              )}
              <span className="relative">{label}</span>
            </button>
          )
        })}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          id={`${uid}-panel`}
          role="tabpanel"
          aria-labelledby={`${uid}-tab-${tab}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
          className="flex flex-col gap-6"
        >
          {tab === 'lora' ? (
            <LoraTestTab />
          ) : tab === 'gallery' ? (
            <GalleryTab />
          ) : (
            <p className="text-sm text-text-dim">Not in the new studio yet — use the classic UI for now.</p>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
