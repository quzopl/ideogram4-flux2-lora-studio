import type { Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_WORK } from './env.ts'
import { expect, test } from './fixtures.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const WORKFLOW = path.join(FIXTURES, 'comfy_api.json')
const WORKFLOW_PROMPT = 'a photo of ohwx person in a park'

const urlField = (page: Page) => page.getByRole('textbox', { name: 'ComfyUI address (server URL)' })
const mappingJson = (page: Page) => page.getByRole('textbox', { name: 'Mapping JSON' })
const pathOf = (url: string) => new URL(url).pathname

async function uploadWorkflow(page: Page) {
  const file = page.getByLabel('Workflow file')
  await file.setInputFiles(WORKFLOW)
  await expect(page.getByText('Loaded workflow from JSON file: 9 nodes, 2 LoRA slot(s).')).toBeVisible()
  // Reset, so picking the same file again uploads it again.
  await expect(file).toHaveValue('')
}

/** This tab's `flux.comfy.form` (written 300 ms after the last change). */
const savedForm = (page: Page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('flux.comfy.form') ?? 'null'))

test('test connection saves then tests', async ({ page }) => {
  // A saved URL other than the one typed below; both are dead ports.
  await page.request.post('/api/comfy/url', { data: { url: 'http://127.0.0.1:9/before' } })
  const events: string[] = []
  page.on('request', (r) => {
    if (pathOf(r.url()) === '/api/comfy/url') events.push(`url ${r.postData()}`)
  })
  page.on('response', (r) => {
    if (pathOf(r.url()) === '/api/comfy/url') events.push(`url ${r.status()}`)
  })
  await page.route('**/api/comfy/test', (route) => {
    events.push('test')
    return route.fulfill({
      json: { ok: true, url: 'http://127.0.0.1:9', stats: { system: { comfyui_version: '0.3.99', os: 'posix' } } },
    })
  })

  await page.goto('/comfy')
  await expect(urlField(page)).toHaveValue('http://127.0.0.1:9/before')
  await urlField(page).fill('http://127.0.0.1:9')
  await page.getByRole('button', { name: 'Test connection' }).click()

  await expect(page.getByText('Connected to http://127.0.0.1:9 (0.3.99).')).toBeVisible()
  expect(events).toEqual(['url {"url":"http://127.0.0.1:9"}', 'url 200', 'test'])
  // Saved: the field follows the stored URL again and Settings sees it.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(urlField(page)).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'ComfyUI URL' })).toHaveValue('http://127.0.0.1:9')

  // Unchanged field: Test connection does not save again.
  await nav.getByRole('link', { name: 'ComfyUI', exact: true }).click()
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect.poll(() => events.filter((e) => e === 'test').length).toBe(2)
  expect(events.filter((e) => e.startsWith('url {'))).toHaveLength(1)
})

test('test connection shows the error', async ({ page }) => {
  await page.goto('/comfy')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('No connection: ComfyUI is not reachable from e2e tests.')).toBeVisible()
})

test('url edit survives navigation', async ({ page }) => {
  await page.goto('/comfy')
  await expect(urlField(page)).not.toHaveValue('')
  await urlField(page).fill('http://127.0.0.1:9/unsaved')

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page).toHaveURL(/\/models$/)
  // Wait until the exit transition has unmounted the view (a quick return would revive it).
  await expect(urlField(page)).toHaveCount(0)
  await nav.getByRole('link', { name: 'ComfyUI', exact: true }).click()
  await expect(urlField(page)).toHaveValue('http://127.0.0.1:9/unsaved')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()

  await page.reload()
  await expect(urlField(page)).toHaveValue('http://127.0.0.1:9/unsaved')
})

test('tabs follow ?tab=', async ({ page }) => {
  await page.goto('/comfy?tab=gallery')
  await expect(page.getByRole('tab', { name: 'Gallery' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Reference batch' }).click()
  await expect(page).toHaveURL(/\/comfy\?tab=batch$/)
  await expect(page.getByRole('tab', { name: 'Reference batch' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Gallery' })).toHaveAttribute('aria-selected', 'false')

  await page.goto('/comfy?tab=nonsense')
  await expect(page.getByRole('tab', { name: 'LoRA test' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('Workflow file')).toBeAttached()
})

test('no workflow shows the empty state', async ({ page }) => {
  await page.route('**/api/comfy/config', (route) =>
    route.fulfill({ json: { url: 'http://127.0.0.1:9', has_workflow: false, workflow_node_count: 0, mapping: null } }))
  await page.goto('/comfy')
  await expect(page.getByText('No workflow uploaded yet.')).toBeVisible()
  await expect(mappingJson(page)).toHaveCount(0)
})

test('workflow upload shows mapping and badges', async ({ page }) => {
  await page.goto('/comfy')
  await uploadWorkflow(page)

  const mapping = JSON.parse(await mappingJson(page).inputValue())
  expect(mapping.positive_node).toBe('6')
  expect(mapping.lora_nodes).toHaveLength(2)
  for (const k of ['positive', 'negative', 'seed', 'width', 'height', 'steps', 'cfg']) {
    await expect(page.getByText(`${k}: mapped`, { exact: true })).toBeVisible()
  }
  await expect(page.getByText('2 LoRA slots', { exact: true })).toBeVisible()
  // The workflow's prompt fills the (empty) LoRA test prompt.
  await expect.poll(async () => (await savedForm(page))?.lora?.prompt).toBe(WORKFLOW_PROMPT)

  // Back on the page later: the stored workflow is described.
  await page.reload()
  await expect(page.getByText('Workflow in memory: 9 nodes, 2 LoRA slot(s). Upload another one to replace it.')).toBeVisible()
  await expect(page.getByText('positive: mapped', { exact: true })).toBeVisible()
})

test('workflow prompt does not replace a typed one', async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('flux.comfy.form', JSON.stringify({ lora: { prompt: 'mine' }, batch: {} })))
  await page.goto('/comfy')
  await uploadWorkflow(page)
  // Let a (wrong) debounced write land before reading.
  await page.waitForTimeout(400)
  expect((await savedForm(page)).lora.prompt).toBe('mine')
})

test('invalid mapping json is rejected locally', async ({ page }) => {
  const posts: string[] = []
  page.on('request', (r) => {
    if (pathOf(r.url()).startsWith('/api/comfy/mapping') && r.method() === 'POST') posts.push(pathOf(r.url()))
  })
  await page.goto('/comfy')
  await uploadWorkflow(page)

  await mappingJson(page).fill('{"positive_node": ')
  await page.getByRole('button', { name: 'Save mapping (active)' }).click()
  await expect(mappingJson(page)).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText(/^Invalid JSON: /)).toBeVisible()

  await mappingJson(page).fill('[1, 2]')
  await page.getByRole('textbox', { name: 'Name for the new mapping' }).fill('e2e-never-saved')
  await page.getByRole('button', { name: 'Save as', exact: true }).click()
  await expect(page.getByText('The mapping must be a JSON object.')).toBeVisible()
  expect(posts).toEqual([])

  // A valid one goes through and clears the error.
  await mappingJson(page).fill('{"positive_node": null, "lora_nodes": []}')
  await page.getByRole('button', { name: 'Save mapping (active)' }).click()
  await expect(page.getByText('Mapping saved.')).toBeVisible()
  await expect(mappingJson(page)).not.toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('positive: unmapped', { exact: true })).toBeVisible()
  await expect(page.getByText('0 LoRA slots', { exact: true })).toBeVisible()
  expect(posts).toEqual(['/api/comfy/mapping'])
})

test('mapping library save, load activates, delete asks', async ({ page }) => {
  const name = `e2e-map-${Date.now()}`
  const activated: unknown[] = []
  page.on('request', (r) => {
    if (pathOf(r.url()) === '/api/comfy/mapping' && r.method() === 'POST') activated.push(r.postDataJSON())
  })
  await page.goto('/comfy')
  await uploadWorkflow(page)

  // Save as: stored under the name, not activated.
  const edited = { ...JSON.parse(await mappingJson(page).inputValue()), positive_node: null }
  await mappingJson(page).fill(JSON.stringify(edited))
  await page.getByRole('textbox', { name: 'Name for the new mapping' }).fill(name)
  await page.getByRole('button', { name: 'Save as', exact: true }).click()
  await expect(page.getByText(`Saved "${name}".`)).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Name for the new mapping' })).toHaveValue('')
  await expect(page.getByText('positive: mapped', { exact: true })).toBeVisible()
  expect(activated).toEqual([])
  const library = page.getByRole('combobox', { name: 'Saved mappings' })
  await expect(library).toHaveText('— saved mappings —')

  // Load: into the editor, and active.
  await mappingJson(page).fill('{"scratch": true}')
  await library.click()
  await page.getByRole('option', { name, exact: true }).click()
  await page.getByRole('button', { name: 'Load', exact: true }).click()
  await expect(page.getByText(`Loaded "${name}".`)).toBeVisible()
  expect(JSON.parse(await mappingJson(page).inputValue())).toEqual(edited)
  await expect(page.getByText('positive: unmapped', { exact: true })).toBeVisible()
  expect(activated).toEqual([{ mapping: edited }])
  // The selection outlives a refresh of the list.
  await page.getByRole('textbox', { name: 'Name for the new mapping' }).fill(`${name}-b`)
  await page.getByRole('button', { name: 'Save as', exact: true }).click()
  await expect(page.getByText(`Saved "${name}-b".`)).toBeVisible()
  await expect(library).toHaveText(name)

  // Delete asks first.
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete mapping?' })
  await expect(dialog).toContainText(name)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(Object.keys((await (await page.request.get('/api/comfy/mappings')).json()).items)).toContain(name)

  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete mapping?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText(`Deleted "${name}".`)).toBeVisible()
  await expect(library).toHaveText('— saved mappings —')
  const items = (await (await page.request.get('/api/comfy/mappings')).json()).items
  expect(Object.keys(items)).not.toContain(name)
  expect(Object.keys(items)).toContain(`${name}-b`)
})

test('mapping edit survives a tab switch and navigation', async ({ page }) => {
  await page.goto('/comfy')
  await uploadWorkflow(page)
  await mappingJson(page).fill('{"edited": true}')

  await page.getByRole('tab', { name: 'Reference batch' }).click()
  await expect(mappingJson(page)).toHaveCount(0)
  await page.getByRole('tab', { name: 'LoRA test' }).click()
  await expect(mappingJson(page)).toHaveValue('{"edited": true}')

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page).toHaveURL(/\/models$/)
  await expect(mappingJson(page)).toHaveCount(0)
  await nav.getByRole('link', { name: 'ComfyUI', exact: true }).click()
  await expect(mappingJson(page)).toHaveValue('{"edited": true}')

  // Activating it ends the draft: the field follows the active mapping again.
  await page.getByRole('button', { name: 'Save mapping (active)' }).click()
  await expect(page.getByText('Mapping saved.')).toBeVisible()
  await expect.poll(async () => (await savedForm(page))?.mapping).toBeUndefined()
})

test('url typed back to the saved one is not a draft', async ({ page }) => {
  await page.request.post('/api/comfy/url', { data: { url: 'http://127.0.0.1:9/a' } })
  await page.goto('/comfy')
  await expect(urlField(page)).toHaveValue('http://127.0.0.1:9/a')
  await urlField(page).fill('http://127.0.0.1:9/b')
  await expect.poll(async () => (await savedForm(page))?.url).toBe('http://127.0.0.1:9/b')
  await urlField(page).fill('http://127.0.0.1:9/a')
  await expect.poll(async () => (await savedForm(page))?.url).toBeUndefined()

  // Changed elsewhere (e.g. Settings): the field follows it.
  await page.request.post('/api/comfy/url', { data: { url: 'http://127.0.0.1:9/c' } })
  await page.reload()
  await expect(urlField(page)).toHaveValue('http://127.0.0.1:9/c')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
})

test('url field is locked while saving', async ({ page }) => {
  await page.request.post('/api/comfy/url', { data: { url: 'http://127.0.0.1:9/a' } })
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route('**/api/comfy/url', async (route) => {
    await held
    await route.continue()
  })
  await page.goto('/comfy')
  await expect(urlField(page)).toHaveValue('http://127.0.0.1:9/a')
  await urlField(page).fill('http://127.0.0.1:9/d')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(urlField(page)).toBeDisabled()
  release()
  await expect(page.getByText('Saved: http://127.0.0.1:9/d')).toBeVisible()
  await expect(urlField(page)).toBeEnabled()
  await expect(urlField(page)).toHaveValue('http://127.0.0.1:9/d')
})

// ---- Jobs and the gallery (the gallery is the real one in E2E_WORK; jobs are mocked) ----

const GALLERY_DIR = path.join(E2E_WORK, 'comfy_gallery')
const IMAGE = path.join(FIXTURES, 'a.png')

interface Sidecar {
  id: string
  ts: number
  prompt?: string
  seed?: number
  source?: string
  filename?: string
  loras?: unknown[]
  width?: number
  height?: number
}

/** Gallery ids this test wrote (removed after it). */
let written: string[] = []

test.afterEach(() => {
  for (const id of written) {
    for (const ext of ['.png', '.json']) fs.rmSync(path.join(GALLERY_DIR, id + ext), { force: true })
  }
  written = []
})

/** A unique gallery id. */
const galleryId = (tag: string) => `e2e${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** The sidecar meta as the server writes it (`source` left out when not given, like items older than it). */
function metaOf(s: Sidecar) {
  return { filename: `${s.id}.png`, prompt: '', seed: 0, loras: [], url: `/api/comfy/gallery/${s.id}`, ...s }
}

/** A gallery image as a job saves it: the PNG and its JSON sidecar. */
function addImage(s: Sidecar) {
  fs.mkdirSync(GALLERY_DIR, { recursive: true })
  fs.copyFileSync(IMAGE, path.join(GALLERY_DIR, `${s.id}.png`))
  fs.writeFileSync(path.join(GALLERY_DIR, `${s.id}.json`), JSON.stringify(metaOf(s)))
  written.push(s.id)
  return metaOf(s)
}

/** Far in the future, so this test's images are the newest. */
const FUTURE = 4_000_000_000

const galleryCards = (page: Page) => page.getByTestId('gallery-card')
const galleryDialog = (page: Page) => page.getByRole('dialog', { name: 'Gallery image' })

/** Starts the tab with `flux.comfy.jobs` holding these jobs (only on the first load: a reload keeps what the page stored). */
async function seedJobs(page: Page, jobs: Record<string, unknown>) {
  await page.addInitScript((value) => {
    if (sessionStorage.getItem('flux.comfy.jobs') === null) sessionStorage.setItem('flux.comfy.jobs', value)
  }, JSON.stringify(jobs))
}

const savedJobs = (page: Page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('flux.comfy.jobs') ?? 'null'))

/** GET /api/comfy/job/{id} answers `job()` at the time of the poll (with the fields a real job has). */
async function mockJob(page: Page, id: string, job: () => Record<string, unknown>) {
  await page.route(`**/api/comfy/job/${id}`, (route) =>
    route.fulfill({
      json: {
        id, total: 1, done_count: 0, current: '', current_node: '', progress: { value: 0, max: 0, speed: 0, eta: 0 },
        has_preview: false, preview_ts: 0, images: [], error: '', ...job(),
      },
    }))
  await page.route(`**/api/comfy/job/${id}/preview**`, (route) => route.fulfill({ path: IMAGE, contentType: 'image/png' }))
}

test('gallery lists newest first with source badges', async ({ page }) => {
  const long = `gallery-order ${'a long prompt that goes on '.repeat(4)}`
  addImage({ id: galleryId('a'), ts: FUTURE + 1, prompt: long, seed: 7, source: 'lora_test' })
  const b = addImage({ id: galleryId('b'), ts: FUTURE + 3, prompt: 'gallery-order editor', seed: 8, source: 'editor' })
  addImage({ id: galleryId('c'), ts: FUTURE + 2, prompt: 'gallery-order ideogram', seed: 9, source: 'ideogram' })
  // Written before `source` existed: a LoRA test image.
  addImage({ id: galleryId('d'), ts: FUTURE, prompt: '', seed: 10, filename: 'ComfyUI_old_.png' })

  await page.goto('/comfy?tab=gallery')
  const cards = galleryCards(page)
  await expect(cards.nth(0)).toContainText('gallery-order editor')
  await expect(cards.nth(0)).toContainText('Editor')
  await expect(cards.nth(0)).toContainText('seed: 8')
  await expect(cards.nth(1)).toContainText('gallery-order ideogram')
  await expect(cards.nth(1)).toContainText('Ideogram')
  await expect(cards.nth(2)).toContainText('LoRA test')
  await expect(cards.nth(2)).toContainText(`${long.slice(0, 70)}…`)
  await expect(cards.nth(2).getByText(`${long.slice(0, 70)}…`)).toHaveAttribute('title', long)
  // No prompt: the file name.
  await expect(cards.nth(3)).toContainText('ComfyUI_old_.png')
  await expect(cards.nth(3)).toContainText('LoRA test')
  await expect(cards.nth(0).locator('img')).toHaveAttribute('loading', 'lazy')
  await expect(cards.nth(0).locator('img')).toHaveAttribute('src', b.url)

  // Refresh fetches images saved since.
  const e = addImage({ id: galleryId('e'), ts: FUTURE + 4, prompt: 'gallery-order newest', source: 'editor' })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(cards.nth(0)).toContainText('gallery-order newest')

  // ✕ asks first.
  await cards.nth(0).getByRole('button', { name: 'Delete image' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete this image?' })
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(cards.nth(0)).toContainText('gallery-order newest')
  await cards.nth(0).getByRole('button', { name: 'Delete image' }).click()
  await page.getByRole('dialog', { name: 'Delete this image?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(cards.nth(0)).toContainText('gallery-order editor')
  expect(fs.existsSync(path.join(GALLERY_DIR, `${e.id}.png`))).toBe(false)
  expect(fs.existsSync(path.join(GALLERY_DIR, `${e.id}.json`))).toBe(false)
})

test('gallery shows 48 images, then more', async ({ page }) => {
  for (let i = 0; i < 50; i++) addImage({ id: galleryId(`p${i}`), ts: FUTURE - i, prompt: `gallery-page ${i}` })
  await page.goto('/comfy?tab=gallery')
  await expect(galleryCards(page)).toHaveCount(48)
  await expect(page.getByText('gallery-page 49', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show more' }).click()
  await expect(page.getByText('gallery-page 49', { exact: true })).toBeVisible()
  expect(await galleryCards(page).count()).toBeGreaterThan(48)
})

test('gallery dialog copy, arrows, delete asks', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const x = addImage({
    id: galleryId('x'), ts: FUTURE + 2, prompt: 'dialog prompt, newest', seed: 11, source: 'lora_test',
    filename: 'ComfyUI_00042_.png', loras: ['my_lora.safetensors', '', 'other.safetensors'], width: 1024, height: 768,
  })
  const y = addImage({ id: galleryId('y'), ts: FUTURE + 1, prompt: 'dialog prompt, older', seed: 22, source: 'editor', filename: 'render' })

  await page.goto('/comfy?tab=gallery')
  await galleryCards(page).nth(0).getByRole('button', { name: /^Open/ }).click()
  const dialog = galleryDialog(page)
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`[?&]image=${x.id}(&|$)`))
  await expect(dialog.getByRole('img')).toHaveAttribute('src', x.url)
  await expect(dialog).toContainText('seed: 11')
  await expect(dialog).toContainText('LoRA test')
  await expect(dialog).toContainText('ComfyUI_00042_.png')
  await expect(dialog).toContainText('1024×768')
  await expect(dialog.getByRole('textbox', { name: 'Prompt' })).toHaveValue('dialog prompt, newest')
  // Empty LoRA names are left out.
  await expect(dialog.getByTestId('gallery-lora')).toHaveText(['LoRA: my_lora.safetensors', 'LoRA: other.safetensors'])
  const download = dialog.getByRole('link', { name: 'Download image' })
  await expect(download).toHaveAttribute('href', x.url)
  await expect(download).toHaveAttribute('download', 'ComfyUI_00042_.png')

  await dialog.getByRole('button', { name: 'Copy' }).click()
  await expect(page.getByText('Copied to clipboard.').first()).toBeVisible()
  expect(await page.evaluate(() => (navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard.readText()))
    .toBe('dialog prompt, newest')

  // The newest has no previous one; → goes to the next older.
  await expect(dialog.getByRole('button', { name: 'Previous image' })).toBeDisabled()
  await page.keyboard.press('ArrowRight')
  await expect(dialog).toContainText('seed: 22')
  await expect(dialog).toContainText('Editor')
  await expect(dialog).not.toContainText('×')
  await expect(dialog.getByRole('link', { name: 'Download image' })).toHaveAttribute('download', 'render.png')
  await expect(page).toHaveURL(new RegExp(`[?&]image=${y.id}(&|$)`))
  await page.keyboard.press('ArrowLeft')
  await expect(dialog).toContainText('seed: 11')
  await dialog.getByRole('button', { name: 'Next image' }).click()
  await expect(dialog).toContainText('seed: 22')

  // Esc closes (and the URL forgets the image).
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/comfy\?tab=gallery$/)

  // Delete asks first; confirmed, the image is gone and the dialog closes.
  await galleryCards(page).nth(1).getByRole('button', { name: /^Open/ }).click()
  await expect(dialog).toContainText('seed: 22')
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete this image?' })
  // The arrows do not move the image behind the question.
  await page.keyboard.press('ArrowLeft')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(dialog).toContainText('seed: 22')
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete this image?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('dialog prompt, older')).toHaveCount(0)
  expect(fs.existsSync(path.join(GALLERY_DIR, `${y.id}.json`))).toBe(false)
})

test('open in gallery deep link opens the dialog', async ({ page }) => {
  const z = addImage({ id: galleryId('z'), ts: FUTURE, prompt: 'deep link prompt', seed: 33, source: 'lora_test', width: 64, height: 48 })
  await seedJobs(page, { lora: { jobId: 'job-deep' } })
  await mockJob(page, 'job-deep', () => ({ state: 'done', current: 'Finished (1/1)', done_count: 1, images: [z] }))

  await page.goto('/comfy')
  await expect(page.getByText('Done: 1 image(s).')).toBeVisible()
  // Kept without the prompt (sessionStorage is small), the job forgotten.
  const jobs = await savedJobs(page)
  expect(jobs.lora.jobId).toBeNull()
  expect(jobs.lora.last).toEqual({ state: 'done', images: [{ id: z.id, url: z.url, seed: 33, width: 64, height: 48 }], error: '' })

  await page.getByRole('link', { name: 'Open in gallery' }).click()
  await expect(page).toHaveURL(new RegExp(`/comfy\\?tab=gallery&image=${z.id}$`))
  await expect(page.getByRole('tab', { name: 'Gallery' })).toHaveAttribute('aria-selected', 'true')
  await expect(galleryDialog(page)).toContainText('seed: 33')
  await expect(galleryDialog(page).getByRole('textbox', { name: 'Prompt' })).toHaveValue('deep link prompt')

  // Straight from the address bar too.
  await page.goto(`/comfy?tab=gallery&image=${z.id}`)
  await expect(galleryDialog(page)).toContainText('seed: 33')
  // Back on the LoRA tab after a reload: the outcome is still there.
  await page.goto('/comfy')
  await expect(page.getByText('Done: 1 image(s).')).toBeVisible()
})

test('job finishing on another tab refreshes the gallery', async ({ page }) => {
  const w = { id: galleryId('w'), ts: FUTURE + 5, prompt: 'observed job image', seed: 44, source: 'lora_test' }
  let state = 'running'
  await seedJobs(page, { lora: { jobId: 'job-obs' } })
  await mockJob(page, 'job-obs', () => state === 'running'
    ? {
      state, current: 'Sample 1/2: step 3/20', progress: { value: 3, max: 20, speed: 1.5, eta: 11.6 },
      has_preview: true, preview_ts: 1234.5,
    }
    : { state, current: 'Finished (1/1)', images: [metaOf(w)] })

  await page.goto('/comfy')
  await expect(page.getByText('Sample 1/2: step 3/20  ·  3/20  ·  1.50 it/s  ·  ~12s left')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Live preview' })).toHaveAttribute('src', '/api/comfy/job/job-obs/preview?t=1234.5')
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()

  // The gallery tab is shown while the job ends: it is still observed, and the gallery refetched.
  await page.getByRole('tab', { name: 'Gallery' }).click()
  await expect(page.getByText('Sample 1/2', { exact: false })).toHaveCount(0)
  await expect(page.getByText('observed job image')).toHaveCount(0)
  addImage(w)
  state = 'done'
  await expect(page.getByText('observed job image')).toBeVisible()
  await expect.poll(async () => (await savedJobs(page)).lora.jobId).toBeNull()

  await page.getByRole('tab', { name: 'LoRA test' }).click()
  await expect(page.getByText('Done: 1 image(s).')).toBeVisible()
})

test('job state over the storage quota shows a toast', async ({ page }) => {
  await seedJobs(page, { lora: { jobId: 'job-quota' } })
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      // The seed above goes in; the page's own writes of the jobs do not fit.
      if (key === 'flux.comfy.jobs' && this.getItem(key) !== null) throw new DOMException('Full', 'QuotaExceededError')
      return set.call(this, key, value)
    }
  })
  await mockJob(page, 'job-quota', () => ({ state: 'cancelled', current: 'Cancelled' }))
  await page.goto('/comfy')
  await expect(page.getByText('Could not keep the job state in this tab.')).toBeVisible()
  // The page carries on with the state in memory.
  await expect(page.getByText('Cancelled.', { exact: true })).toBeVisible()
})
