import { Navigate, Route, Routes, type Location } from 'react-router'
import { BboxPage } from '@/pages/bbox/BboxPage'
import { ClassicPlaceholder } from '@/pages/ClassicPlaceholder'
import { DatasetPage } from '@/pages/dataset/DatasetPage'
import { ModelsPage } from '@/pages/ModelsPage'
import { Playground } from '@/pages/Playground'
import { PromptsPage } from '@/pages/prompts/PromptsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { UpscalePage } from '@/pages/UpscalePage'

/** `location` is passed in so an exiting view keeps rendering its own route. */
export function AppRoutes({ location }: { location: Location }) {
  return (
    <Routes location={location}>
      <Route index element={<Navigate to="/upscale" replace />} />
      <Route path="/dataset" element={<DatasetPage />} />
      <Route path="/prompts" element={<PromptsPage />} />
      <Route path="/bbox" element={<BboxPage />} />
      <Route path="/comfy" element={<ClassicPlaceholder view="comfy" title="ComfyUI" />} />
      <Route path="/upscale" element={<UpscalePage />} />
      <Route path="/models" element={<ModelsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      {/* Component harness for e2e; deliberately not in the sidebar. */}
      <Route path="/_playground" element={<Playground />} />
      <Route path="*" element={<Navigate to="/upscale" replace />} />
    </Routes>
  )
}
