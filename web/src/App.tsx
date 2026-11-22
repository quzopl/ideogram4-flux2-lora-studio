import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'motion/react'
import { BrowserRouter } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Shell } from './app/Shell'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <TooltipProvider delayDuration={300}>
          <BrowserRouter>
            <Shell />
          </BrowserRouter>
          <Toaster theme="dark" richColors />
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  )
}
