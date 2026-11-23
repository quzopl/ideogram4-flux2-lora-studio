import type { Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_WORK } from './env.ts'
import { expect, test } from './fixtures.ts'

// Regenerates docs/screenshots/*.png:  SCREENSHOTS=1 pnpm exec playwright test e2e/screenshots.spec.ts
// Runs on the e2e server (temporary FLUX_PREP_WORK, ComfyUI mocked), never on a real instance.
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to regenerate docs/screenshots')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures')
const OUT = path.join(HERE, '..', '..', 'docs', 'screenshots')
const WORK = fs.realpathSync(E2E_WORK)
const PHOTOS = path.join(WORK, 'photos')
const FAKE_COMFY = 'http://127.0.0.1:8188'

test.use({ viewport: { width: 1440, height: 900 } })

const shot = async (page: Page, name: string) => {
  // Let entrance animations and the GPU poller settle.
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(OUT, name) })
}

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(PHOTOS, { recursive: true })
  const files: Record<string, string> = {
    'portrait_01.png': 'a.png',
    'portrait_02.png': 'b.png',
    'street_03.png': 'crop-400x300.png',
    'street_04.png': 'crop-800x600.png',
    'garden_05.png': 'big.png',
    'garden_06.png': 'a.png',
  }
  for (const [to, from] of Object.entries(files)) fs.copyFileSync(path.join(FIXTURES, from), path.join(PHOTOS, to))
})

test('dataset', async ({ page, request }) => {
  await request.put('/api/settings/forms/dataset', { data: { values: {} } })
  await page.goto('/dataset')
  const input = page.getByRole('textbox', { name: 'Source folder', exact: true })
  await expect(input).toBeEnabled()
  await input.fill(PHOTOS)
  await page.getByRole('button', { name: 'Scan', exact: true }).click()
  await expect(page.getByTestId('source-tile')).toHaveCount(6)
  await shot(page, '01-dataset.png')
})

test('prompts', async ({ page, request }) => {
  await request.put('/api/settings/forms/prompts', { data: { values: {} } })
  const ideogram = JSON.stringify({
    aspect_ratio: '4:5',
    high_level_description: 'A woman in a yellow raincoat stands under a street lamp on a wet cobblestone street at dusk.',
    compositional_deconstruction: {
      background: 'A narrow European street with wet cobblestones, shuttered shops and a lamp-lit evening glow.',
      elements: [
        { type: 'obj', bbox: [120, 300, 900, 700], desc: 'A woman in a yellow raincoat holding a black umbrella, looking left.' },
        { type: 'obj', bbox: [40, 640, 520, 760], desc: 'A cast-iron street lamp with a glowing bulb.' },
      ],
    },
  })
  for (const [category, prompt, input_text] of [
    ['ideogram', ideogram, 'woman in a raincoat on a rainy street'],
    ['flux', 'A calm lake at sunrise, mist rising from the water, pine forest on the far shore, soft golden light.', 'lake at sunrise'],
    ['flux', 'A close portrait of an elderly fisherman mending a net on a wooden pier, overcast daylight.', 'old fisherman'],
  ]) {
    await request.post('/api/prompts/library', { data: { category, prompt, input_text, action: 'expand' } })
  }
  const run = {
    text: 'woman in a yellow raincoat on a rainy street at dusk',
    jobId: null,
    format: 'ideogram',
    result: { prompt: ideogram, warnings: [], format: 'ideogram', library_id: 1 },
    edited: null,
  }
  await page.addInitScript((r) => sessionStorage.setItem('flux.prompts.run', r), JSON.stringify(run))
  await page.goto('/prompts')
  await expect(page.getByText('raincoat').first()).toBeVisible()
  await shot(page, '02-prompts.png')
})

test('bbox', async ({ page }) => {
  const draft = {
    doc: {
      aspect_ratio: '4:5',
      hld: 'A woman in a yellow raincoat stands under a street lamp on a wet cobblestone street at dusk.',
      bg: 'A narrow European street with wet cobblestones, shuttered shops and a lamp-lit evening glow.',
      elements: [
        { type: 'obj', bbox: [120, 300, 900, 700], desc: 'A woman in a yellow raincoat holding a black umbrella, looking left.', text: '' },
        { type: 'obj', bbox: [40, 640, 520, 760], desc: 'A cast-iron street lamp with a glowing bulb.', text: '' },
        { type: 'text', bbox: [60, 80, 160, 420], desc: 'Hand-painted shop sign above a doorway.', text: 'CAFE LUNA' },
      ],
    },
    selected: 0,
  }
  await page.addInitScript((d) => sessionStorage.setItem('flux.bbox.draft', d), JSON.stringify(draft))
  await page.goto('/bbox')
  await expect(page.locator('[data-testid="bbox-box"]')).toHaveCount(3)
  await shot(page, '03-bbox.png')
})

test('comfy', async ({ page, request }) => {
  await request.post('/api/comfy/url', { data: { url: FAKE_COMFY } })
  await page.route('**/api/comfy/test', (route) => route.fulfill({ json: { ok: true, url: FAKE_COMFY, stats: { system: { comfyui_version: '0.3.60' } } } }))
  await page.route('**/api/comfy/loras', (route) =>
    route.fulfill({ json: { loras: ['portrait_v1.safetensors', 'style_ink.safetensors', 'my_character.safetensors'] } }),
  )
  await page.goto('/comfy')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await page.waitForTimeout(500)
  await page.getByLabel('Workflow file').setInputFiles(path.join(FIXTURES, 'comfy_api.json'))
  await expect(page.getByText(/Loaded workflow from JSON file/)).toBeVisible()
  await shot(page, '04-comfy.png')
})

test('upscale', async ({ page, request }) => {
  await request.put('/api/settings/forms/upscale', { data: { values: {} } })
  await page.goto('/upscale')
  const folder = page.getByRole('textbox', { name: 'Source folder' })
  await expect(folder).toBeEnabled()
  await folder.fill(PHOTOS)
  await expect(page.getByText('6 images', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Model' }).click()
  await page.getByRole('option').first().click()
  await shot(page, '05-upscale.png')
})

test('models', async ({ page }) => {
  await page.goto('/models')
  await expect(page.getByRole('heading').first()).toBeVisible()
  await shot(page, '06-models.png')
})

test('settings', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading').first()).toBeVisible()
  await shot(page, '07-settings.png')
})
