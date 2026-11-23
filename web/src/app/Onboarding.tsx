import { FolderDown } from 'lucide-react'
import { useState } from 'react'
import { useLocation } from 'react-router'
import { FolderPicker } from '@/components/FolderPicker'
import { SpringDialogContent } from '@/components/SpringDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useSetModelsDir, useSettings } from '@/lib/queries'

const DISMISSED = 'flux.onboarding.dismissed'

function dismissedThisSession(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED) === '1'
  } catch {
    return false
  }
}

/** First run: asks for the models folder until one is set or "Later" is clicked (per session). */
export function Onboarding() {
  const { pathname } = useLocation()
  const settings = useSettings()
  const setModelsDir = useSetModelsDir()
  const [dismissed, setDismissed] = useState(dismissedThisSession)
  const [picking, setPicking] = useState(false)

  const later = () => {
    try {
      sessionStorage.setItem(DISMISSED, '1')
    } catch {
      // Storage blocked: it stays closed until the next reload.
    }
    setDismissed(true)
  }

  const open =
    settings.isSuccess &&
    settings.data.models_dir === '' &&
    !dismissed &&
    pathname !== '/_playground'

  return (
    <Dialog open={open} onOpenChange={(o) => !o && later()}>
      <SpringDialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-linear-to-br from-accent-from/25 to-accent-to/25 ring-1 ring-line">
            <FolderDown className="size-5 text-accent-to" />
          </div>
          <DialogTitle>Where should models be downloaded?</DialogTitle>
          <DialogDescription>
            Captioning, Florence-2 and upscale models go into one folder you choose. Nothing is
            downloaded until you do. You can change it later in Settings.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mb-0 rounded-none border-0 bg-transparent p-0">
          <Button variant="ghost" size="sm" onClick={later}>Later</Button>
          <Button
            size="sm"
            disabled={setModelsDir.isPending}
            onClick={() => setPicking(true)}
            className="bg-linear-to-r from-accent-from to-accent-to text-white"
          >
            Choose folder
          </Button>
        </DialogFooter>

        {/* Inside this dialog's tree, so its clicks are not "outside" this dialog. */}
        <FolderPicker
          open={picking}
          onOpenChange={setPicking}
          title="Choose the models folder"
          onPick={(dir) => setModelsDir.mutate(dir)}
        />
      </SpringDialogContent>
    </Dialog>
  )
}
