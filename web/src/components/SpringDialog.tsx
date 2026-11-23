import { motion } from 'motion/react'
import type { ComponentProps } from 'react'
import { DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/** shadcn DialogContent whose body springs in (scale 0.96 → 1). */
export function SpringDialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      className={cn('border border-line bg-surface p-0 data-open:animate-none', className)}
      {...props}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        className="flex min-w-0 flex-col gap-4 p-5"
      >
        {children}
      </motion.div>
    </DialogContent>
  )
}
