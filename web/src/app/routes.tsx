import { Navigate, Route, Routes, type Location } from 'react-router'
import { ClassicPlaceholder } from '@/pages/ClassicPlaceholder'
import { ModelsPage } from '@/pages/ModelsPage'
import { Playground } from '@/pages/Playground'
import { SettingsPage } from '@/pages/SettingsPage'

/** Stand-in for a v2 view that a later task builds. */
function Placeholder({ title }: { title: string }) {
  return (
    <div className="px-10 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-text-dim">Coming soon.</p>
    </div>
  )
}

/** `location` is passed in so an exiting view keeps rendering its own route. */
export function AppRoutes({ location }: { location: Location }) {
  return (
    <Routes location={location}>
      <Route index element={<Navigate to="/upscale" replace />} />
      <Route path="/dataset" element={<ClassicPlaceholder view="dataset" title="Dataset" />} />
      <Route path="/prompts" element={<ClassicPlaceholder view="prompts" title="Prompt studio" />} />
      <Route path="/bbox" element={<ClassicPlaceholder view="bbox" title="Bbox editor" />} />
      <Route path="/comfy" element={<ClassicPlaceholder view="comfy" title="ComfyUI" />} />
      <Route path="/upscale" element={<Placeholder title="Upscale" />} />
      <Route path="/models" element={<ModelsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      {/* Component harness for e2e; deliberately not in the sidebar. */}
      <Route path="/_playground" element={<Playground />} />
      <Route path="*" element={<Navigate to="/upscale" replace />} />
    </Routes>
  )
}
