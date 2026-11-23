import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { ensureRunning } from '@/pages/comfy/batchRunner'
import { GpuBar } from './GpuBar'
import { Onboarding } from './Onboarding'
import { AppRoutes } from './routes'
import { Sidebar } from './Sidebar'

/** One view in the transition. While it exits it takes no clicks or focus. */
function View({ children }: { children: ReactNode }) {
  const present = useIsPresent()
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      style={{ pointerEvents: present ? undefined : 'none' }}
      inert={!present}
      className="w-full"
    >
      {children}
    </motion.div>
  )
}

export function Shell() {
  const location = useLocation()
  // A ComfyUI batch left running before a reload goes on, whichever view the app opens on.
  const qc = useQueryClient()
  useEffect(() => ensureRunning(qc), [qc])
  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-text">
      <Sidebar />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <GpuBar />
        <main className="relative flex-1 overflow-x-hidden overflow-y-auto bg-[radial-gradient(60rem_24rem_at_30%_-6rem,rgba(139,92,246,0.10),transparent_70%)]">
          <AnimatePresence mode="popLayout" initial={false}>
            <View key={location.pathname}>
              <AppRoutes location={location} />
            </View>
          </AnimatePresence>
        </main>
      </div>
      <Onboarding />
    </div>
  )
}
