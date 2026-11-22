import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { CropEditorDialog } from '@/components/CropEditorDialog'
import { FolderPicker } from '@/components/FolderPicker'
import { GpuSelect } from '@/components/GpuSelect'
import { JobProgress } from '@/components/JobProgress'
import { ModelSelect } from '@/components/ModelSelect'
import { PresetBar } from '@/components/PresetBar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSavedForm } from '@/hooks/useAutosave'
import { useCropPlan } from '@/hooks/useCropPlan'

function Demo({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <h2 className="text-sm font-medium text-text-dim">{title}</h2>
      {children}
    </section>
  )
}

/**
 * Harness for the shared components (e2e only; not in the sidebar). `?path=` sets
 * the picker's start; `?cropFolder=<abs>&cropFiles=a.png,b.png[&cropSquare=1]`
 * sets up the crop editor (the bundle does not know the e2e work folder).
 */
export function Playground() {
  const [params] = useSearchParams()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [picked, setPicked] = useState('')
  const [form, setForm, loaded] = useSavedForm('upscale', { alpha: '' })
  const [gpu, setGpu] = useState('auto')
  const [roleGpu, setRoleGpu] = useState('')
  const [cpuGpu, setCpuGpu] = useState('cpu')
  const [model, setModel] = useState('')
  const cropFolder = params.get('cropFolder')
  const cropFiles = (params.get('cropFiles') ?? '').split(',').filter(Boolean)
  const crops = useCropPlan(cropFolder)
  const [cropping, setCropping] = useState<string | null>(null)

  return (
    <div className="flex max-w-3xl flex-col gap-4 px-10 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Playground</h1>

      <Demo title="FolderPicker">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>Pick a folder</Button>
          <span data-testid="picked-path" className="font-mono text-xs">{picked}</span>
        </div>
        <FolderPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          title="Pick a folder"
          initialPath={params.get('path') ?? undefined}
          onPick={setPicked}
        />
      </Demo>

      <Demo title="PresetBar + useSavedForm (view: upscale)">
        <label className="flex items-center gap-3 text-sm">
          <span className="w-12 text-text-dim">alpha</span>
          <Input
            aria-label="alpha"
            disabled={!loaded}
            value={form.alpha}
            onChange={(e) => setForm({ ...form, alpha: e.target.value })}
            className="w-64"
          />
        </label>
        <PresetBar view="upscale" current={form} onLoad={(v) => setForm((f) => ({ ...f, ...v }))} />
      </Demo>

      <Demo title="GpuSelect">
        <div className="flex flex-wrap gap-3">
          <GpuSelect value={gpu} onChange={setGpu} />
          <GpuSelect value={roleGpu} onChange={setRoleGpu} includeDefault />
          <GpuSelect value={cpuGpu} onChange={setCpuGpu} hideCpu label="Hidden CPU" />
        </div>
      </Demo>

      <Demo title="ModelSelect (upscale)">
        <ModelSelect kind="upscale" value={model} onChange={setModel} />
      </Demo>

      <Demo title="JobProgress">
        <JobProgress state="running" processed={7} total={20} current="IMG_0007.png" />
        <JobProgress state="error" processed={3} total={20} current="IMG_0003.png" error="CUDA out of memory" />
      </Demo>

      <Demo title="CropEditorDialog + useCropPlan">
        {cropFolder ? (
          <>
            <div className="flex flex-wrap gap-2">
              {cropFiles.map((f) => (
                <Button key={f} variant="outline" size="sm" disabled={!crops.loaded} onClick={() => setCropping(f)}>
                  Edit {f}
                </Button>
              ))}
            </div>
            <pre data-testid="crop-plan" className="font-mono text-xs whitespace-pre-wrap text-text-dim">
              {crops.loaded ? JSON.stringify({ mode: crops.mode, plan: crops.plan }) : 'loading…'}
            </pre>
            {cropping && (
              <CropEditorDialog
                key={cropping}
                folder={cropFolder}
                name={cropping}
                files={cropFiles}
                square={params.get('cropSquare') === '1'}
                autoCrop={{ mode: 'person', resolution: 1024, step: 64 }}
                onClose={() => setCropping(null)}
              />
            )}
          </>
        ) : (
          <p className="text-xs text-text-dim">Pass ?cropFolder=&lt;abs&gt;&amp;cropFiles=a.png,b.png</p>
        )}
      </Demo>
    </div>
  )
}
