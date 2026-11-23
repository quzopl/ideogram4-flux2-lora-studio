import type { ReactNode } from 'react'
import { SpringDialogContent } from '@/components/SpringDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
  /** The confirming button's text. */
  action: string
  /** Red confirm button, for removals. */
  destructive?: boolean
  onConfirm: () => void
}

/** A yes/no question in a dialog (instead of `window.confirm`). Confirming closes it. */
export function ConfirmDialog({ open, onOpenChange, title, children, action, destructive = false, onConfirm }: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SpringDialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{children}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mb-0 rounded-none border-0 bg-transparent p-0">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            size="sm"
            variant={destructive ? 'destructive' : 'default'}
            className={destructive ? undefined : 'bg-linear-to-r from-accent-from to-accent-to text-white'}
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            {action}
          </Button>
        </DialogFooter>
      </SpringDialogContent>
    </Dialog>
  )
}
