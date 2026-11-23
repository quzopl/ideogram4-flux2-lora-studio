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
/** The Workflow card (the LoRA test card has a library with the same buttons). */
const workflowCard = (page: Page) => page.getByRole('region', { name: 'Workflow', exact: true })
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
  await workflowCard(page).getByRole('button', { name: 'Save as', exact: true }).click()
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
  await workflowCard(page).getByRole('button', { name: 'Save as', exact: true }).click()
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
  await workflowCard(page).getByRole('button', { name: 'Load', exact: true }).click()
  await expect(page.getByText(`Loaded "${name}".`)).toBeVisible()
  expect(JSON.parse(await mappingJson(page).inputValue())).toEqual(edited)
  await expect(page.getByText('positive: unmapped', { exact: true })).toBeVisible()
  expect(activated).toEqual([{ mapping: edited }])
  // The selection outlives a refresh of the list.
  await page.getByRole('textbox', { name: 'Name for the new mapping' }).fill(`${name}-b`)
  await workflowCard(page).getByRole('button', { name: 'Save as', exact: true }).click()
  await expect(page.getByText(`Saved "${name}-b".`)).toBeVisible()
  await expect(library).toHaveText(name)

  // Delete asks first.
  await workflowCard(page).getByRole('button', { name: 'Delete', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete mapping?' })
  await expect(dialog).toContainText(name)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(Object.keys((await (await page.request.get('/api/comfy/mappings')).json()).items)).toContain(name)

  await workflowCard(page).getByRole('button', { name: 'Delete', exact: true }).click()
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

  // The arrows keep working at either end, whatever has focus (here: the button that just became disabled).
  await page.keyboard.press('Escape')
  await galleryCards(page).nth(0).getByRole('button', { name: /^Open/ }).click()
  await expect(dialog).toContainText('seed: 11')
  await page.keyboard.press('ArrowRight')
  await expect(dialog).toContainText('seed: 22')
  await page.keyboard.press('ArrowLeft')
  await expect(dialog).toContainText('seed: 11')
  await dialog.getByRole('button', { name: 'Next image' }).click()
  await expect(dialog).toContainText('seed: 22')
  await dialog.getByRole('button', { name: 'Previous image' }).click()
  await expect(dialog.getByRole('button', { name: 'Previous image' })).toBeDisabled()
  await page.keyboard.press('ArrowRight')
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

test('gallery card without a seed shows a dash', async ({ page }) => {
  addImage({ id: galleryId('s'), ts: FUTURE + 9, prompt: 'no seed card', seed: undefined, source: 'editor' })
  await page.goto('/comfy?tab=gallery')
  const card = galleryCards(page).filter({ hasText: 'no seed card' })
  await expect(card).toContainText('seed: —')
})

test('one job is polled once', async ({ page }) => {
  const polls: number[] = []
  await seedJobs(page, { lora: { jobId: 'job-once' } })
  await mockJob(page, 'job-once', () => {
    polls.push(Date.now())
    return { state: 'running', current: 'Sample 1/1: step 1/20', progress: { value: 1, max: 20 } }
  })
  await page.goto('/comfy')
  await expect(page.getByText('Sample 1/1: step 1/20', { exact: false })).toBeVisible()
  // Only the page's observer polls, one GET 700 ms after the last answer; the job box reads its
  // cache. A box polling too would also fetch each time it mounts, off that beat: leave the tab
  // and come back, again and again, and look at the gaps between the GETs.
  const from = polls.length
  for (let i = 0; i < 8; i++) {
    await page.getByRole('tab', { name: 'Gallery' }).click()
    await expect(page.getByTestId('comfy-job')).toHaveCount(0)
    await page.getByRole('tab', { name: 'LoRA test' }).click()
    await expect(page.getByText('Sample 1/1: step 1/20', { exact: false })).toBeVisible()
  }
  await page.waitForTimeout(1000)
  const gaps = polls.slice(from).map((t, i, a) => (i ? t - a[i - 1] : Infinity))
  expect(gaps.length).toBeGreaterThan(3)
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(600)
})

test('cancelling survives a tab switch', async ({ page }) => {
  let state = 'running'
  const cancels: string[] = []
  await seedJobs(page, { lora: { jobId: 'job-cxl' } })
  await mockJob(page, 'job-cxl', () => ({ state, current: state === 'running' ? 'Sample 1/1: step 2/20' : 'Cancelled' }))
  await page.route('**/api/comfy/job/job-cxl/cancel', (route) => {
    cancels.push(route.request().method())
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto('/comfy')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()
  expect(cancels).toEqual(['POST'])

  // The cancel was answered; the job runs on until ComfyUI stops it. Away and back: still cancelling.
  await page.getByRole('tab', { name: 'Gallery' }).click()
  await expect(page.getByRole('button', { name: 'Cancelling…' })).toHaveCount(0)
  await page.getByRole('tab', { name: 'LoRA test' }).click()
  await expect(page.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()

  state = 'cancelled'
  await expect(page.getByText('Cancelled.', { exact: true })).toBeVisible()
  expect(cancels).toEqual(['POST'])
})

// ---- LoRA test (config, LoRA list, generate and jobs are mocked; the prompt library is real) ----

const loraCard = (page: Page) => page.getByRole('region', { name: 'LoRA test', exact: true })
const loraRow = (page: Page, n: number) => page.getByRole('combobox', { name: `LoRA ${n}`, exact: true })
const loraRows = (page: Page) => loraCard(page).getByRole('combobox', { name: /^LoRA \d+$/ })
const promptBox = (page: Page) => page.getByRole('textbox', { name: 'Prompt (FLUX.2)' })
const generateButton = (page: Page) => page.getByRole('button', { name: 'Generate samples' })

/** GET /api/comfy/config answers a stored workflow with `slots` LoRA loaders (or none at all). */
async function mockConfig(page: Page, slots: number, hasWorkflow = true) {
  const mapping = {
    positive_node: '6', positive_field: 'text',
    lora_nodes: Array.from({ length: slots }, (_, i) => ({ node: String(10 + i), field: 'lora_name', current: '', class_type: 'LoraLoader' })),
  }
  await page.route('**/api/comfy/config', (route) =>
    route.fulfill({
      json: { url: 'http://127.0.0.1:9', has_workflow: hasWorkflow, workflow_node_count: hasWorkflow ? 9 : 0, mapping: hasWorkflow ? mapping : null },
    }))
}

/** POST /api/comfy/generate answers `jobId`; the bodies sent are collected. */
async function mockGenerate(page: Page, jobId: string) {
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/comfy/generate', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { job_id: jobId } })
  })
  return bodies
}

/** Starts the tab with this LoRA test form in `flux.comfy.form` (only on the first load). */
async function seedLoraForm(page: Page, lora: Record<string, unknown>) {
  await page.addInitScript((value) => {
    if (sessionStorage.getItem('flux.comfy.form') === null) sessionStorage.setItem('flux.comfy.form', value)
  }, JSON.stringify({ lora, batch: {} }))
}

test('generate sends the form', async ({ page }) => {
  await mockConfig(page, 2)
  const bodies = await mockGenerate(page, 'job-form')
  await mockJob(page, 'job-form', () => ({ state: 'done', current: 'Finished (2/2)' }))
  await page.goto('/comfy')

  await expect(page.getByRole('spinbutton', { name: 'Width' })).toHaveValue('1024')
  await expect(page.getByRole('spinbutton', { name: 'Width' })).toHaveAttribute('step', '64')
  await expect(page.getByRole('spinbutton', { name: 'Height' })).toHaveValue('1024')
  await expect(page.getByRole('spinbutton', { name: 'Steps' })).toHaveValue('20')
  await expect(page.getByRole('spinbutton', { name: 'CFG / Guidance' })).toHaveValue('3.5')
  await expect(page.getByRole('spinbutton', { name: 'Seed (-1 = random)' })).toHaveValue('-1')
  await expect(page.getByRole('spinbutton', { name: 'Sample count' })).toHaveValue('2')

  // No prompt yet: nothing to send.
  await expect(generateButton(page)).toBeDisabled()
  await expect(page.getByText('Enter a prompt.')).toBeVisible()
  await promptBox(page).fill('a photo of ohwx person')
  // A field out of range is marked at the field and holds Generate back.
  await page.getByRole('spinbutton', { name: 'Sample count' }).fill('9')
  await expect(page.getByText('Enter a whole number from 1 to 8')).toBeVisible()
  await expect(generateButton(page)).toBeDisabled()
  await page.getByRole('spinbutton', { name: 'Sample count' }).fill('2')

  await generateButton(page).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toEqual({
    prompt: 'a photo of ohwx person', width: 1024, height: 1024, steps: 20, cfg: 3.5, seed: null, batch: 2, loras: ['', ''],
  })
  // The job is the LoRA slot's: its box shows how it ended.
  await expect(page.getByText('Done: 0 image(s).')).toBeVisible()

  // A seed of its own is sent as typed.
  await page.getByRole('spinbutton', { name: 'Seed (-1 = random)' }).fill('42')
  await page.getByRole('spinbutton', { name: 'CFG / Guidance' }).fill('4.5')
  await generateButton(page).click()
  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[1]).toMatchObject({ seed: 42, cfg: 4.5 })
})

test('lora slots are positional', async ({ page }) => {
  await mockConfig(page, 2)
  const bodies = await mockGenerate(page, 'job-pos')
  await seedLoraForm(page, { prompt: 'positional' })
  await page.goto('/comfy')

  await loraRow(page, 1).fill('a.safetensors')
  await loraRow(page, 2).fill('b')
  // − clears its row; the next one keeps its slot.
  await page.getByRole('button', { name: 'Clear LoRA 1' }).click()
  await expect(loraRow(page, 1)).toHaveValue('')
  await expect(loraRow(page, 2)).toHaveValue('b')
  await expect(loraRows(page)).toHaveCount(2)

  await generateButton(page).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0].loras).toEqual(['', 'b'])
})

test('lora rows match slots and cap', async ({ page }) => {
  await mockConfig(page, 2)
  await page.goto('/comfy')
  // As many rows as the workflow has LoRA loaders.
  await expect(loraRows(page)).toHaveCount(2)
  await expect(loraRow(page, 1)).toHaveAttribute('placeholder', 'pick or type a name…')
  await page.getByRole('button', { name: 'add LoRA' }).click()
  await expect(page.getByText('The workflow has only 2 LoRA loader(s). Add more LoRA loaders in ComfyUI to stack more.')).toBeVisible()
  await expect(loraRows(page)).toHaveCount(2)
  await expect(page.getByText('This workflow has no LoRA loader — add one in ComfyUI.')).toHaveCount(0)

  // Rows kept from a workflow with fewer loaders: add LoRA adds up to the slots. (A later route wins.)
  await mockConfig(page, 3)
  await page.evaluate(() => sessionStorage.setItem('flux.comfy.form', JSON.stringify({ lora: { prompt: '', loras: ['x'] }, batch: {} })))
  await page.reload()
  await expect(loraRows(page)).toHaveCount(1)
  await expect(loraRow(page, 1)).toHaveValue('x')
  await page.getByRole('button', { name: 'add LoRA' }).click()
  await page.getByRole('button', { name: 'add LoRA' }).click()
  await expect(loraRows(page)).toHaveCount(3)
  await expect(page.getByText(/The workflow has only/)).toHaveCount(0)
  await page.getByRole('button', { name: 'add LoRA' }).click()
  await expect(page.getByText('The workflow has only 3 LoRA loader(s). Add more LoRA loaders in ComfyUI to stack more.')).toBeVisible()
  await expect(loraRows(page)).toHaveCount(3)

  // More rows kept than the workflow has: only its slots are shown.
  await mockConfig(page, 1)
  await page.reload()
  await expect(loraRows(page)).toHaveCount(1)
  await expect(loraRow(page, 1)).toHaveValue('x')

  // No LoRA loader at all.
  await mockConfig(page, 0)
  await page.reload()
  await expect(page.getByText('This workflow has no LoRA loader — add one in ComfyUI.')).toBeVisible()
  await expect(loraRows(page)).toHaveCount(0)
})

test('lora list loads, search narrows, unknown names warn', async ({ page }) => {
  await mockConfig(page, 2)
  let calls = 0
  let loras = ['alpha_v1.safetensors', 'Beta.safetensors', 'gamma.safetensors']
  await page.route('**/api/comfy/loras', (route) => {
    calls++
    return route.fulfill({ json: { loras } })
  })
  await page.goto('/comfy')
  // Loaded on entry.
  await expect(loraCard(page).getByText('(3 available)')).toBeVisible()
  const listId = await loraRow(page, 1).getAttribute('list')
  const options = page.locator(`datalist[id="${listId}"] option`)
  await expect(options).toHaveCount(3)

  await page.getByRole('textbox', { name: 'Search LoRAs' }).fill('BETA')
  await expect(options).toHaveCount(1)
  await expect(options.first()).toHaveAttribute('value', 'Beta.safetensors')
  await page.getByRole('textbox', { name: 'Search LoRAs' }).fill('')
  await expect(options).toHaveCount(3)

  // A name not on the list is allowed, with a warning.
  await loraRow(page, 1).fill('alpha_v1.safetensors')
  await loraRow(page, 2).fill('missing.safetensors')
  await expect(loraCard(page).getByText('not on the ComfyUI list')).toHaveCount(1)

  // Refresh asks ComfyUI again.
  loras = [...loras, 'missing.safetensors']
  const before = calls
  await page.getByRole('button', { name: 'refresh list from ComfyUI' }).click()
  await expect(loraCard(page).getByText('(4 available)')).toBeVisible()
  expect(calls).toBe(before + 1)
  await expect(loraCard(page).getByText('not on the ComfyUI list')).toHaveCount(0)

  // ComfyUI down: the error, and free text is still accepted.
  await page.route('**/api/comfy/loras', (route) => route.fulfill({ status: 502, json: { detail: 'ComfyUI is down.' } }))
  await page.getByRole('button', { name: 'refresh list from ComfyUI' }).click()
  await expect(loraCard(page).getByText('LoRA list error: ComfyUI is down.')).toBeVisible()
  await expect(loraRow(page, 2)).toBeEnabled()
})

test('lora list is asked once, not on every tab switch', async ({ page }) => {
  await mockConfig(page, 1)
  let calls = 0
  await page.route('**/api/comfy/loras', (route) => {
    calls++
    return route.fulfill({ json: { loras: ['one.safetensors'] } })
  })
  await page.goto('/comfy')
  await expect(loraCard(page).getByText('(1 available)')).toBeVisible()
  for (let i = 0; i < 2; i++) {
    await page.getByRole('tab', { name: 'Gallery' }).click()
    await expect(loraCard(page)).toHaveCount(0)
    await page.getByRole('tab', { name: 'LoRA test' }).click()
    await expect(loraCard(page).getByText('(1 available)')).toBeVisible()
  }
  await page.waitForTimeout(500)
  expect(calls).toBe(1)
})

test('empty lora list does not warn', async ({ page }) => {
  // The fixture's list is empty (e.g. loader types the backend does not list): nothing to compare with.
  await mockConfig(page, 1)
  await page.goto('/comfy')
  await expect(loraCard(page).getByText('(0 available)')).toBeVisible()
  await loraRow(page, 1).fill('typed.safetensors')
  await expect(loraCard(page).getByText('not on the ComfyUI list')).toHaveCount(0)
})

test('lora rows survive navigation', async ({ page }) => {
  await mockConfig(page, 2)
  await page.goto('/comfy')
  await loraRow(page, 2).fill('kept.safetensors')
  await promptBox(page).fill('kept prompt')
  await page.getByRole('spinbutton', { name: 'Steps' }).fill('28')

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page).toHaveURL(/\/models$/)
  await expect(loraCard(page)).toHaveCount(0)
  await nav.getByRole('link', { name: 'ComfyUI', exact: true }).click()
  await expect(loraRow(page, 1)).toHaveValue('')
  await expect(loraRow(page, 2)).toHaveValue('kept.safetensors')
  await expect(promptBox(page)).toHaveValue('kept prompt')
  await expect(page.getByRole('spinbutton', { name: 'Steps' })).toHaveValue('28')

  await page.getByRole('tab', { name: 'Gallery' }).click()
  await expect(loraCard(page)).toHaveCount(0)
  await page.getByRole('tab', { name: 'LoRA test' }).click()
  await expect(loraRow(page, 2)).toHaveValue('kept.safetensors')

  await page.reload()
  await expect(loraRow(page, 2)).toHaveValue('kept.safetensors')
  await expect(promptBox(page)).toHaveValue('kept prompt')
  await expect(page.getByRole('spinbutton', { name: 'Steps' })).toHaveValue('28')
})

test('generate disabled without a workflow', async ({ page }) => {
  await mockConfig(page, 0, false)
  await seedLoraForm(page, { prompt: 'no workflow' })
  await page.goto('/comfy')
  await expect(page.getByText('No workflow uploaded yet.')).toBeVisible()
  await expect(generateButton(page)).toBeDisabled()
  await expect(loraCard(page).getByText('Upload a workflow above first.')).toBeVisible()
  await expect(page.getByText('This workflow has no LoRA loader — add one in ComfyUI.')).toHaveCount(0)
})

test('lora job survives navigation and reload', async ({ page }) => {
  await mockConfig(page, 2)
  await mockGenerate(page, 'job-nav')
  await seedLoraForm(page, { prompt: 'navigation' })
  let state = 'running'
  await mockJob(page, 'job-nav', () => state === 'running'
    ? { state, current: 'Sample 1/2: step 5/20', progress: { value: 5, max: 20 } }
    : { state, current: 'Finished (2/2)' })
  await page.goto('/comfy')
  await generateButton(page).click()
  await expect(page.getByText('Sample 1/2: step 5/20  ·  5/20')).toBeVisible()
  // One job at a time.
  await expect(generateButton(page)).toBeDisabled()

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(loraCard(page)).toHaveCount(0)
  await nav.getByRole('link', { name: 'ComfyUI', exact: true }).click()
  await expect(page.getByText('Sample 1/2: step 5/20  ·  5/20')).toBeVisible()
  await expect(generateButton(page)).toBeDisabled()

  await page.reload()
  await expect(page.getByText('Sample 1/2: step 5/20  ·  5/20')).toBeVisible()
  state = 'done'
  await expect(page.getByText('Done: 0 image(s).')).toBeVisible()
  await expect(generateButton(page)).toBeEnabled()
})

test('job progress, preview, done with thumbnails', async ({ page }) => {
  const a = addImage({ id: galleryId('t'), ts: FUTURE + 20, prompt: 'thumb a', seed: 101, source: 'lora_test' })
  const b = addImage({ id: galleryId('u'), ts: FUTURE + 21, prompt: 'thumb b', seed: 102, source: 'lora_test' })
  await mockConfig(page, 2)
  await mockGenerate(page, 'job-thumbs')
  await seedLoraForm(page, { prompt: 'thumbnails' })
  let state = 'pending'
  await mockJob(page, 'job-thumbs', () => state === 'running'
    ? { state, current: 'Sample 2/2: step 7/20', progress: { value: 7, max: 20, speed: 2, eta: 6.5 }, has_preview: true, preview_ts: 77 }
    : state === 'done'
      ? { state, current: 'Finished (2/2)', done_count: 2, images: [a, b] }
      : { state, current: 'Starting…' })
  await page.goto('/comfy')
  await generateButton(page).click()
  await expect(page.getByText('Starting…')).toBeVisible()
  state = 'running'
  await expect(page.getByText('Sample 2/2: step 7/20  ·  7/20  ·  2.00 it/s  ·  ~7s left')).toBeVisible()
  await expect(page.getByRole('progressbar', { name: 'Job progress' })).toHaveAttribute('aria-valuenow', '7')
  await expect(page.getByRole('img', { name: 'Live preview' })).toHaveAttribute('src', '/api/comfy/job/job-thumbs/preview?t=77')

  state = 'done'
  await expect(page.getByText('Done: 2 image(s).')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Live preview' })).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'Seed 101' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Seed 102' })).toBeVisible()
  await page.getByRole('img', { name: 'Seed 102' }).click()
  await expect(galleryDialog(page)).toContainText('seed: 102')
})

test('job thumbnail without a seed shows a dash', async ({ page }) => {
  const img = { ...metaOf({ id: galleryId('n'), ts: FUTURE + 22, prompt: 'no seed thumb', source: 'lora_test' }), seed: undefined }
  await seedJobs(page, { lora: { jobId: 'job-noseed' } })
  await mockJob(page, 'job-noseed', () => ({ state: 'done', current: 'Finished (1/1)', images: [img] }))
  await page.goto('/comfy')
  await expect(page.getByText('Done: 1 image(s).')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Seed —' })).toBeAttached()
  // Kept unknown, not made 0.
  await expect.poll(async () => (await savedJobs(page)).lora.last?.images[0]).toBeDefined()
  expect((await savedJobs(page)).lora.last.images[0]).not.toHaveProperty('seed')
})

test('cancel ends cancelled', async ({ page }) => {
  await mockConfig(page, 2)
  await mockGenerate(page, 'job-cancel')
  await seedLoraForm(page, { prompt: 'cancel me' })
  let state = 'running'
  await mockJob(page, 'job-cancel', () => ({ state, current: state === 'running' ? 'Sample 1/2: step 1/20' : 'Cancelled' }))
  await page.route('**/api/comfy/job/job-cancel/cancel', (route) => {
    state = 'cancelled'
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto('/comfy')
  await generateButton(page).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('Cancelled.', { exact: true })).toBeVisible()
  await expect.poll(async () => (await savedJobs(page)).lora).toEqual({ jobId: null, last: { state: 'cancelled', images: [], error: '' } })
  await expect(generateButton(page)).toBeEnabled()
})

test('error shows first line and expandable details', async ({ page }) => {
  await mockConfig(page, 2)
  await mockGenerate(page, 'job-err')
  await seedLoraForm(page, { prompt: 'fail' })
  const error = 'LoraLoader (node 10): ValueError: value not in list\nTraceback (most recent call last):\n  File "x.py", line 1'
  await mockJob(page, 'job-err', () => ({ state: 'error', current: 'Error', error }))
  await page.goto('/comfy')
  await generateButton(page).click()
  const alert = loraCard(page).getByRole('alert')
  await expect(alert).toContainText('Error: LoraLoader (node 10): ValueError: value not in list')
  await expect(alert.getByText('Traceback (most recent call last):', { exact: false })).toBeHidden()
  await alert.getByText('Details').click()
  await expect(alert.locator('pre')).toHaveText(error)
})

test('generate start error is shown', async ({ page }) => {
  await mockConfig(page, 2)
  await seedLoraForm(page, { prompt: 'refused' })
  await page.route('**/api/comfy/generate', (route) =>
    route.fulfill({ status: 400, json: { detail: 'Upload a workflow first (LoRA test → Workflow).' } }))
  await page.goto('/comfy')
  await generateButton(page).click()
  await expect(page.getByText('Upload a workflow first (LoRA test → Workflow).')).toBeVisible()
  await expect(generateButton(page)).toBeEnabled()
})

test('prompt library save, load asks before replacing, delete', async ({ page }) => {
  const name = `e2e-prompt-${Date.now()}`
  await mockConfig(page, 2)
  await page.goto('/comfy')
  const card = loraCard(page)
  const library = card.getByRole('combobox', { name: 'Saved prompts' })
  await expect(library).toHaveText('— saved prompts —')

  // Nothing to save yet.
  await card.getByRole('textbox', { name: 'Name for the new prompt' }).fill(name)
  await card.getByRole('button', { name: 'Save as', exact: true }).click()
  await expect(card.getByText('Enter a prompt first.')).toBeVisible()
  expect(Object.keys((await (await page.request.get('/api/comfy/prompts')).json()).items)).not.toContain(name)

  await promptBox(page).fill('library prompt text')
  await card.getByRole('button', { name: 'Save as', exact: true }).click()
  await expect(card.getByText(`Saved prompt "${name}".`)).toBeVisible()
  expect((await (await page.request.get('/api/comfy/prompts')).json()).items[name]).toBe('library prompt text')

  // Load over a typed prompt asks first; Cancel keeps it.
  await promptBox(page).fill('typed over')
  await library.click()
  await page.getByRole('option', { name, exact: true }).click()
  await card.getByRole('button', { name: 'Load', exact: true }).click()
  const ask = page.getByRole('dialog', { name: 'Replace the prompt?' })
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(promptBox(page)).toHaveValue('typed over')
  await card.getByRole('button', { name: 'Load', exact: true }).click()
  await ask.getByRole('button', { name: 'Replace' }).click()
  await expect(promptBox(page)).toHaveValue('library prompt text')

  // Into an empty prompt: no question.
  await promptBox(page).fill('')
  await card.getByRole('button', { name: 'Load', exact: true }).click()
  await expect(promptBox(page)).toHaveValue('library prompt text')
  await expect(ask).toHaveCount(0)

  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete prompt?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(card.getByText(`Deleted "${name}".`)).toBeVisible()
  expect(Object.keys((await (await page.request.get('/api/comfy/prompts')).json()).items)).not.toContain(name)
})

// ---- Reference batch (config, generate and jobs are mocked) ----

const batchCard = (page: Page) => page.getByRole('region', { name: 'Reference batch', exact: true })
const batchPrompts = (page: Page) => page.getByRole('textbox', { name: 'Prompts (one per line)' })
const batchButton = (page: Page) => page.getByRole('button', { name: 'Generate batch' })
/** The line items (not the thumbnails listed inside them). */
const batchLines = (page: Page) => batchCard(page).getByRole('list', { name: 'Batch lines' }).locator(':scope > li')
const lineState = (page: Page, i: number) => batchLines(page).nth(i).getByTestId('batch-line-state')
const BATCH_BODY = { width: 1024, height: 1024, steps: 20, cfg: 3.5, batch: 1 }

/** POST /api/comfy/generate answers job-<tag>-1, job-<tag>-2, … in turn; the bodies sent are collected. */
async function mockBatchGenerate(page: Page, tag: string) {
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/comfy/generate', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { job_id: `job-${tag}-${bodies.length}` } })
  })
  return bodies
}

/** The batch's jobs job-<tag>-1…n, each in the state `states` holds for it at the time of the poll. */
async function mockBatchJobs(page: Page, tag: string, states: string[], extra: (i: number) => Record<string, unknown> = () => ({})) {
  for (let i = 0; i < states.length; i++) await mockJob(page, `job-${tag}-${i + 1}`, () => ({ state: states[i], ...extra(i) }))
}

test('batch runs lines sequentially', async ({ page }) => {
  const img = addImage({ id: galleryId('b'), ts: FUTURE + 30, prompt: 'red car', seed: 31, source: 'lora_test' })
  await mockConfig(page, 1)
  const bodies = await mockBatchGenerate(page, 'seq')
  const states = ['running', 'running', 'running']
  await mockBatchJobs(page, 'seq', states, (i) => (i === 0 && states[0] === 'done' ? { images: [img] } : {}))
  await page.goto('/comfy?tab=batch')

  // Classic labels and defaults.
  await expect(batchCard(page).getByRole('spinbutton', { name: 'Width' })).toHaveValue('1024')
  await expect(batchCard(page).getByRole('spinbutton', { name: 'Height' })).toHaveValue('1024')
  await expect(batchCard(page).getByRole('spinbutton', { name: 'Steps' })).toHaveValue('20')
  await expect(batchCard(page).getByRole('spinbutton', { name: 'CFG / Guidance' })).toHaveValue('3.5')
  await expect(batchPrompts(page)).toHaveAttribute('placeholder', /^A photo of a red sports car on a coastal road at sunset\.\n/)
  await expect(batchButton(page)).toBeDisabled()
  await expect(batchCard(page).getByText('Enter at least one prompt.')).toBeVisible()

  // Lines are trimmed, blank ones dropped.
  await batchPrompts(page).fill('  red car on a coast \n\n wooden cabin \n   \ncoffee mug')
  await batchButton(page).click()
  await expect.poll(() => bodies.length).toBe(1)
  await expect(lineState(page, 0)).toHaveText('running')
  await expect(lineState(page, 1)).toHaveText('queued')
  await expect(batchCard(page).getByText('Generating 1/3: "red car on a coast…"')).toBeVisible()
  await expect(batchButton(page)).toBeDisabled()
  // One line at a time: the next is sent only once this one ends.
  await page.waitForTimeout(900)
  expect(bodies).toHaveLength(1)

  states[0] = 'done'
  await expect.poll(() => bodies.length).toBe(2)
  await expect(lineState(page, 0)).toHaveText('done')
  await expect(batchLines(page).nth(0).getByRole('img', { name: 'Seed 31' })).toBeVisible()
  await expect(lineState(page, 1)).toHaveText('running')
  states[1] = 'done'
  await expect.poll(() => bodies.length).toBe(3)
  states[2] = 'done'
  await expect(batchCard(page).getByText('Done: 3.')).toBeVisible()
  for (let i = 0; i < 3; i++) await expect(lineState(page, i)).toHaveText('done')
  expect(bodies).toEqual([
    { prompt: 'red car on a coast', ...BATCH_BODY },
    { prompt: 'wooden cabin', ...BATCH_BODY },
    { prompt: 'coffee mug', ...BATCH_BODY },
  ])
  await expect(batchButton(page)).toBeEnabled()
  await batchLines(page).nth(0).getByRole('img', { name: 'Seed 31' }).click()
  await expect(galleryDialog(page)).toContainText('seed: 31')
})

test('batch line ending on the gallery tab refreshes the gallery', async ({ page }) => {
  const g = { id: galleryId('g'), ts: FUTURE + 40, prompt: 'batch gallery image', seed: 41, source: 'lora_test' }
  await mockConfig(page, 1)
  await mockBatchGenerate(page, 'gal')
  const states = ['running']
  await mockBatchJobs(page, 'gal', states, () => (states[0] === 'done' ? { images: [metaOf(g)] } : {}))
  await page.goto('/comfy?tab=batch')
  await batchPrompts(page).fill('one line')
  await batchButton(page).click()
  await expect(lineState(page, 0)).toHaveText('running')

  await page.getByRole('tab', { name: 'Gallery' }).click()
  await expect(batchCard(page)).toHaveCount(0)
  await expect(page.getByText('batch gallery image')).toHaveCount(0)
  addImage(g)
  states[0] = 'done'
  await expect(page.getByText('batch gallery image')).toBeVisible()
})

test('batch generate disabled without a workflow', async ({ page }) => {
  await mockConfig(page, 0, false)
  await page.goto('/comfy?tab=batch')
  await batchPrompts(page).fill('one line')
  await expect(batchButton(page)).toBeDisabled()
  await expect(batchCard(page).getByText('Upload a workflow on the LoRA test tab first.')).toBeVisible()
})

test('batch survives navigation', async ({ page }) => {
  await mockConfig(page, 1)
  const bodies = await mockBatchGenerate(page, 'nav')
  const states = ['running', 'running', 'running']
  await mockBatchJobs(page, 'nav', states)
  await page.goto('/comfy?tab=batch')
  await batchPrompts(page).fill('line one\nline two\nline three')
  await batchCard(page).getByRole('spinbutton', { name: 'Steps' }).fill('28')
  await batchButton(page).click()
  states[0] = 'done'
  await expect.poll(() => bodies.length).toBe(2)
  await expect(lineState(page, 1)).toHaveText('running')

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page).toHaveURL(/\/models$/)
  await expect(batchCard(page)).toHaveCount(0)
  // The batch runs on while the view is away.
  states[1] = 'done'
  await expect.poll(() => bodies.length).toBe(3)

  await nav.getByRole('link', { name: 'ComfyUI', exact: true }).click()
  await page.getByRole('tab', { name: 'Reference batch' }).click()
  await expect(lineState(page, 1)).toHaveText('done')
  await expect(lineState(page, 2)).toHaveText('running')
  await expect(batchPrompts(page)).toHaveValue('line one\nline two\nline three')
  await expect(batchCard(page).getByRole('spinbutton', { name: 'Steps' })).toHaveValue('28')
  states[2] = 'done'
  await expect(batchCard(page).getByText('Done: 3.')).toBeVisible()
  await page.waitForTimeout(900)
  expect(bodies.map((b) => b.prompt)).toEqual(['line one', 'line two', 'line three'])
  expect(bodies.every((b) => b.steps === 28)).toBe(true)
})

test('batch reload resumes without sending a line again', async ({ page }) => {
  await mockConfig(page, 1)
  const bodies = await mockBatchGenerate(page, 'rld')
  const states = ['done', 'running', 'running']
  await mockBatchJobs(page, 'rld', states)
  await page.goto('/comfy?tab=batch')
  await batchPrompts(page).fill('first\nsecond\nthird')
  await batchButton(page).click()
  await expect(lineState(page, 1)).toHaveText('running')

  await page.reload()
  await expect(lineState(page, 0)).toHaveText('done')
  await expect(lineState(page, 1)).toHaveText('running')
  await page.waitForTimeout(900)
  expect(bodies).toHaveLength(2)
  states[1] = 'done'
  states[2] = 'done'
  await expect(batchCard(page).getByText('Done: 3.')).toBeVisible()
  expect(bodies.map((b) => b.prompt)).toEqual(['first', 'second', 'third'])
})

test('batch line reloaded while queueing is not sent again', async ({ page }) => {
  const line = (l: string, state: string) => ({ line: l, state, images: [], error: '' })
  // A reload hit while line 2's POST was in flight: whether it reached the server is unknown.
  await seedJobs(page, {
    batch: {
      lines: ['first', 'second', 'third'], index: 1, jobId: null, posting: true, cancelled: false, running: true,
      params: { width: 768, height: 512, steps: 12, cfg: 2 },
      results: [line('first', 'done'), line('second', 'queueing'), line('third', 'queued')],
    },
  })
  await mockConfig(page, 1)
  const bodies = await mockBatchGenerate(page, 'q')
  await mockBatchJobs(page, 'q', ['done'])
  // On the LoRA tab: the page resumes the batch, whichever tab is shown.
  await page.goto('/comfy')
  await expect.poll(() => bodies.length).toBe(1)
  // With the batch's own parameters, not the form's.
  expect(bodies[0]).toEqual({ prompt: 'third', width: 768, height: 512, steps: 12, cfg: 2, batch: 1 })
  await page.getByRole('tab', { name: 'Reference batch' }).click()
  await expect(lineState(page, 1)).toHaveText('unknown (page reloaded while queueing)')
  await expect(lineState(page, 2)).toHaveText('done')
  await expect(batchCard(page).getByText('Done: 3.')).toBeVisible()
  await page.waitForTimeout(900)
  expect(bodies).toHaveLength(1)
})

test('batch cancel stops the rest', async ({ page }) => {
  await mockConfig(page, 1)
  const bodies = await mockBatchGenerate(page, 'cxb')
  const states = ['running', 'running', 'running']
  await mockBatchJobs(page, 'cxb', states)
  const cancels: string[] = []
  await page.route('**/api/comfy/job/*/cancel', (route) => {
    cancels.push(pathOf(route.request().url()))
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto('/comfy?tab=batch')
  await batchPrompts(page).fill('one\ntwo\nthree')
  await batchButton(page).click()
  await expect(lineState(page, 0)).toHaveText('running')

  await batchCard(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(batchCard(page).getByRole('button', { name: 'Cancelling…' })).toBeDisabled()
  await expect.poll(() => cancels).toEqual(['/api/comfy/job/job-cxb-1/cancel'])
  // It waits for the job to report `cancelled`; nothing more is sent meanwhile.
  await page.waitForTimeout(900)
  await expect(lineState(page, 0)).toHaveText('running')
  expect(bodies).toHaveLength(1)

  states[0] = 'cancelled'
  await expect(batchCard(page).getByText('Cancelled.', { exact: true })).toBeVisible()
  await expect(lineState(page, 0)).toHaveText('cancelled')
  await expect(lineState(page, 1)).toHaveText('skipped')
  await expect(lineState(page, 2)).toHaveText('skipped')
  expect(bodies).toHaveLength(1)
  expect(cancels).toHaveLength(1)
  await expect(batchButton(page)).toBeEnabled()
})

test('batch line error stops', async ({ page }) => {
  await mockConfig(page, 1)
  const bodies = await mockBatchGenerate(page, 'err')
  const error = 'CLIPTextEncode (node 6): RuntimeError: out of memory\nTraceback (most recent call last):\n  File "x.py", line 1'
  await mockBatchJobs(page, 'err', ['done', 'error', 'done'], (i) => (i === 1 ? { error } : {}))
  await page.goto('/comfy?tab=batch')
  await batchPrompts(page).fill('one\ntwo\nthree')
  await batchButton(page).click()

  const alert = batchCard(page).getByRole('alert')
  await expect(alert).toContainText('Stopped at line 2: CLIPTextEncode (node 6): RuntimeError: out of memory')
  await expect(alert.getByText('Traceback (most recent call last):', { exact: false })).toBeHidden()
  await alert.getByText('Details').click()
  await expect(alert.locator('pre')).toHaveText(error)
  await expect(lineState(page, 0)).toHaveText('done')
  await expect(lineState(page, 1)).toHaveText('error')
  await expect(lineState(page, 2)).toHaveText('skipped')
  await page.waitForTimeout(900)
  expect(bodies).toHaveLength(2)
  await expect(batchButton(page)).toBeEnabled()
})

test('batch job gone stops', async ({ page }) => {
  await mockConfig(page, 1)
  // No job mock: the fixture answers 404 for every job (as after a server restart).
  const bodies = await mockBatchGenerate(page, 'gone')
  await page.goto('/comfy?tab=batch')
  await batchPrompts(page).fill('one\ntwo')
  await batchButton(page).click()
  await expect(batchCard(page).getByRole('alert')).toContainText(
    'Stopped at line 1: The ComfyUI job is gone (was the server restarted?)')
  await expect(lineState(page, 0)).toHaveText('gone')
  await expect(lineState(page, 1)).toHaveText('skipped')
  await page.waitForTimeout(900)
  expect(bodies).toHaveLength(1)
  await expect(batchButton(page)).toBeEnabled()
})

test('batch start error stops', async ({ page }) => {
  await mockConfig(page, 1)
  await page.route('**/api/comfy/generate', (route) =>
    route.fulfill({ status: 502, json: { detail: 'ComfyUI is not reachable.' } }))
  await page.goto('/comfy?tab=batch')
  await batchPrompts(page).fill('one\ntwo')
  await batchButton(page).click()
  await expect(batchCard(page).getByRole('alert')).toContainText('Stopped at line 1: ComfyUI is not reachable.')
  await expect(lineState(page, 0)).toHaveText('error')
  await expect(lineState(page, 1)).toHaveText('skipped')
  await expect(batchButton(page)).toBeEnabled()
})

test('batch resumes at app start on another page', async ({ page }) => {
  const line = (l: string, state: string) => ({ line: l, state, images: [], error: '' })
  await seedJobs(page, {
    batch: {
      lines: ['first', 'second'], index: 1, jobId: null, posting: false, cancelled: false, running: true,
      params: { width: 1024, height: 1024, steps: 20, cfg: 3.5 },
      results: [line('first', 'done'), line('second', 'queued')],
    },
  })
  const bodies = await mockBatchGenerate(page, 'app')
  await mockBatchJobs(page, 'app', ['done'])
  // Reloaded on another view: the batch goes on without the ComfyUI page.
  await page.goto('/models')
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0].prompt).toBe('second')
  await expect.poll(async () => (await savedJobs(page)).batch.running).toBe(false)
  expect((await savedJobs(page)).batch.results.map((r: { state: string }) => r.state)).toEqual(['done', 'done'])
})

test('batch cancel that fails can be pressed again', async ({ page }) => {
  await mockConfig(page, 1)
  await mockBatchGenerate(page, 'cxf')
  const states = ['running', 'running']
  await mockBatchJobs(page, 'cxf', states)
  const cancels: number[] = []
  await page.route('**/api/comfy/job/*/cancel', (route) => {
    cancels.push(cancels.length)
    return cancels.length === 1
      ? route.fulfill({ status: 500, json: { detail: 'cancel broke' } })
      : route.fulfill({ json: { ok: true } })
  })
  await page.goto('/comfy?tab=batch')
  await batchPrompts(page).fill('one\ntwo')
  await batchButton(page).click()
  await expect(lineState(page, 0)).toHaveText('running')

  const cancel = batchCard(page).getByRole('button', { name: 'Cancel', exact: true })
  await cancel.click()
  await expect(page.getByText('Could not cancel the batch job: cancel broke')).toBeVisible()
  // The request failed: Cancel can be pressed again, and that sends it again.
  await expect(cancel).toBeEnabled()
  await cancel.click()
  await expect(batchCard(page).getByRole('button', { name: 'Cancelling…' })).toBeDisabled()
  expect(cancels).toHaveLength(2)

  states[0] = 'cancelled'
  await expect(batchCard(page).getByText('Cancelled.', { exact: true })).toBeVisible()
  await expect(lineState(page, 1)).toHaveText('skipped')
})

test('batch loop throwing marks the line as error', async ({ page }) => {
  await mockConfig(page, 1)
  await mockBatchGenerate(page, 'thr')
  // Not a job: reading its state throws inside the loop.
  await page.route('**/api/comfy/job/job-thr-1', (route) => route.fulfill({ json: null }))
  await page.goto('/comfy?tab=batch')
  await batchPrompts(page).fill('one\ntwo')
  await batchButton(page).click()
  await expect(batchCard(page).getByRole('alert')).toContainText('Stopped at line 1: Cannot read properties of null')
  await expect(lineState(page, 0)).toHaveText('error')
  await expect(lineState(page, 1)).toHaveText('skipped')
  await expect(batchCard(page).getByText(/^Done/)).toHaveCount(0)
})

// ---- Workflow editor (editor/load is real; /object_info is mocked or offline) ----

const editorCard = (page: Page) => page.getByRole('region', { name: 'Workflow editor', exact: true })
const nodeCard = (page: Page, id: string) => page.locator(`#edn-${id}`)
const nodeHeader = (page: Page, id: string) => nodeCard(page, id).locator(`#edn-${id}-h`)
/** A field of a node card by its name. */
const nodeField = (page: Page, id: string, field: string) => nodeCard(page, id).getByLabel(field, { exact: true })

/** This tab's `flux.comfy.editor` (written 300 ms after the last change). */
const savedEditor = (page: Page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('flux.comfy.editor') ?? 'null'))

/** Node `id`'s input `field` as stored (undefined until the first write). */
const savedInput = async (page: Page, id: string, field: string) => (await savedEditor(page))?.workflow?.[id]?.inputs?.[field]

/** Loads `workflow` into the editor through the real editor/load, as a `.json` file. */
async function loadEditorJson(page: Page, workflow: Record<string, unknown>, name = 'editor.json') {
  await editorCard(page).getByLabel('Workflow file').setInputFiles({
    name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(workflow)),
  })
  await expect(editorCard(page).getByText(`Loaded workflow from JSON file: ${Object.keys(workflow).length} nodes.`)).toBeVisible()
}

/** GET /api/comfy/object_info (also with ?refresh=1) answers `info`; the query strings asked are collected. */
async function mockObjectInfo(page: Page, info: Record<string, unknown>) {
  const asked: string[] = []
  await page.route((url) => url.pathname === '/api/comfy/object_info', (route) => {
    asked.push(new URL(route.request().url()).search)
    return route.fulfill({ json: info })
  })
  return asked
}

const OBJECT_INFO = {
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { default: 0, min: 0, max: 18446744073709551615 }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 8, min: 0, max: 100, step: 0.1 }],
        sampler_name: [['euler', 'dpmpp_2m'], {}],
        scheduler: [['simple', 'karras'], {}],
      },
    },
  },
  LoraLoader: { input: { required: { lora_name: [['first.safetensors', 'dir/second.safetensors'], {}] } } },
}

test('load workflow shows node cards and links', async ({ page }) => {
  await page.goto('/comfy?tab=editor')
  await editorCard(page).getByLabel('Workflow file').setInputFiles(WORKFLOW)
  await expect(editorCard(page).getByText('Loaded workflow from JSON file: 9 nodes.')).toBeVisible()
  // ComfyUI is offline: the cards come without dropdowns, and the note says why.
  await expect(editorCard(page).getByText(
    'Note: /object_info unavailable (ComfyUI is not reachable from e2e tests.). Start ComfyUI and click ↻ ComfyUI schemas',
    { exact: false })).toBeVisible()

  // Sorted by numeric id, `#id class_type`.
  const headers = editorCard(page).locator('section[id^="edn-"] > button')
  await expect(headers).toHaveText([
    '#3KSampler', '#4CheckpointLoaderSimple', '#5EmptyLatentImage', '#6CLIPTextEncode', '#7CLIPTextEncode',
    '#8VAEDecode', '#9SaveImage', '#10LoraLoader', '#11LoraLoader',
  ])
  // Literal fields are controls; links are read only, after them.
  await expect(nodeField(page, '6', 'text')).toHaveValue(WORKFLOW_PROMPT)
  await expect(nodeField(page, '3', 'seed')).toHaveValue('42')
  const links = nodeCard(page, '3').getByRole('button', { name: /^→/ })
  await expect(links).toHaveText([
    '→ #11 (LoraLoader) · output 0', '→ #6 (CLIPTextEncode) · output 0',
    '→ #7 (CLIPTextEncode) · output 0', '→ #5 (EmptyLatentImage) · output 0',
  ])

  // A link expands and shows its source card.
  await nodeHeader(page, '6').click()
  await expect(nodeHeader(page, '6')).toHaveAttribute('aria-expanded', 'false')
  await expect(nodeField(page, '6', 'text')).toBeHidden()
  await nodeCard(page, '3').getByRole('button', { name: '→ #6 (CLIPTextEncode) · output 0' }).click()
  await expect(nodeHeader(page, '6')).toHaveAttribute('aria-expanded', 'true')
  await expect(nodeField(page, '6', 'text')).toBeInViewport()

  // The filter fades what does not match (id or class type), and hides nothing.
  await editorCard(page).getByPlaceholder('filter nodes (name/type/ID)…').fill('lora')
  await expect(nodeCard(page, '10')).not.toHaveAttribute('data-dimmed')
  await expect(nodeCard(page, '3')).toHaveAttribute('data-dimmed', 'true')
  await expect(nodeCard(page, '3')).toBeVisible()
  await editorCard(page).getByPlaceholder('filter nodes (name/type/ID)…').fill('3')
  await expect(nodeCard(page, '3')).not.toHaveAttribute('data-dimmed')

  await editorCard(page).getByRole('button', { name: 'Collapse all' }).click()
  for (const id of ['3', '10']) await expect(nodeHeader(page, id)).toHaveAttribute('aria-expanded', 'false')
  await editorCard(page).getByRole('button', { name: 'Expand all' }).click()
  for (const id of ['3', '10']) await expect(nodeHeader(page, id)).toHaveAttribute('aria-expanded', 'true')

  // The view switch: the graph comes later; the cards stay below it.
  await editorCard(page).getByRole('button', { name: 'Graph + parameters' }).click()
  await expect(editorCard(page).getByRole('button', { name: 'Graph + parameters' })).toHaveAttribute('aria-pressed', 'true')
  await expect(nodeCard(page, '3')).toBeVisible()

  const saved = await savedEditor(page)
  expect(Object.keys(saved.workflow)).toHaveLength(9)
  expect(saved.dirty).toBe(false)
})

test('schema dropdowns from object_info', async ({ page }) => {
  const asked = await mockObjectInfo(page, OBJECT_INFO)
  await page.goto('/comfy?tab=editor')
  await loadEditorJson(page, {
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 3.5, sampler_name: 'my_sampler', scheduler: 'karras' } },
    '10': { class_type: 'LoraLoader', inputs: { lora_name: 'dir\\second.safetensors' } },
    '20': { class_type: 'MyCustomLoader', inputs: { lora: 'first.safetensors', sampler: 'euler' } },
  })
  await expect(editorCard(page).getByText('ComfyUI schemas: 2 node types, 3 fields with dropdowns.')).toBeVisible()

  // sampler_name is a select; the workflow's value not on the list stays, marked.
  const sampler = nodeField(page, '3', 'sampler_name')
  await expect(sampler).toHaveJSProperty('tagName', 'SELECT')
  await expect(sampler.locator('option')).toHaveText(['my_sampler (from workflow)', 'euler', 'dpmpp_2m'])
  await expect(sampler).toHaveValue('my_sampler')
  await sampler.selectOption('dpmpp_2m')
  await expect.poll(async () => savedInput(page, '3', 'sampler_name')).toBe('dpmpp_2m')
  expect((await savedEditor(page)).dirty).toBe(true)
  await expect(nodeField(page, '3', 'scheduler')).toHaveValue('karras')

  // A Windows path the list has with "/" is shown and saved as listed.
  await expect(nodeField(page, '10', 'lora_name')).toHaveValue('dir/second.safetensors')
  await expect(nodeField(page, '10', 'lora_name').locator('option', { hasText: 'from workflow' })).toHaveCount(0)
  await expect.poll(async () => savedInput(page, '10', 'lora_name')).toBe('dir/second.safetensors')

  // A node type ComfyUI has no schema for: the list guessed from the field name.
  await expect(nodeField(page, '20', 'lora')).toHaveJSProperty('tagName', 'SELECT')
  await expect(nodeField(page, '20', 'lora').locator('option')).toHaveText(['dir/second.safetensors', 'first.safetensors'])
  await expect(nodeField(page, '20', 'sampler')).toHaveValue('euler')
  // INT bounds from the schema; the seed's 2^64 is no bound.
  await expect(nodeField(page, '3', 'steps')).toHaveAttribute('min', '1')
  await expect(nodeField(page, '3', 'steps')).toHaveAttribute('max', '10000')
  await expect(nodeField(page, '3', 'seed')).not.toHaveAttribute('max')

  expect(asked).toEqual([''])
  await editorCard(page).getByRole('button', { name: 'ComfyUI schemas' }).click()
  await expect.poll(() => asked).toEqual(['', '?refresh=1'])
})

test('number fields keep their type', async ({ page }) => {
  // No schemas (ComfyUI offline): the number kind comes from the value and the name.
  await page.goto('/comfy?tab=editor')
  await loadEditorJson(page, {
    '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20, cfg: 1, denoise: 1, sampler_name: 'euler' } },
  })
  await nodeField(page, '3', 'cfg').fill('0.5')
  await expect.poll(async () => savedInput(page, '3', 'cfg')).toBe(0.5)
  await nodeField(page, '3', 'denoise').fill('0.75')
  await expect.poll(async () => savedInput(page, '3', 'denoise')).toBe(0.75)
  // A whole-number field takes no fraction.
  await nodeField(page, '3', 'seed').fill('1.5')
  await expect(nodeCard(page, '3').getByText('Enter a whole number', { exact: true })).toBeVisible()
  await nodeField(page, '3', 'seed').fill('7')
  await expect.poll(async () => savedInput(page, '3', 'seed')).toBe(7)

  // Empty steps: an error in the store, and the workflow keeps its last valid value.
  await nodeField(page, '3', 'steps').fill('')
  await expect(nodeCard(page, '3').getByText('Enter a whole number', { exact: true })).toBeVisible()
  await expect.poll(async () => (await savedEditor(page))?.invalid['3.steps']).toBe('Enter a whole number')
  expect(await savedInput(page, '3', 'steps')).toBe(20)

  // Collapsing the card does not clear it.
  await nodeHeader(page, '3').click()
  await expect(nodeField(page, '3', 'steps')).toBeHidden()
  await page.waitForTimeout(400)
  expect((await savedEditor(page)).invalid).toEqual({ '3.steps': 'Enter a whole number' })
  await nodeHeader(page, '3').click()
  await expect(nodeField(page, '3', 'steps')).toHaveValue('')
  await expect(nodeCard(page, '3').getByText('Enter a whole number', { exact: true })).toBeVisible()

  await nodeField(page, '3', 'steps').fill('25')
  await expect.poll(async () => (await savedEditor(page)).invalid).toEqual({})
  expect(await savedInput(page, '3', 'steps')).toBe(25)
})

test('dict inputs and nested values', async ({ page }) => {
  await page.goto('/comfy?tab=editor')
  await loadEditorJson(page, {
    '1': {
      class_type: 'Power Lora Loader (rgthree)',
      inputs: {
        lora_1: { on: true, lora: 'a.safetensors', strength: 1, extra: { deep: 1 } },
        empty: {},
        pairs: [{ a: 1 }, 2],
        model: ['2', 0],
      },
    },
    '2': { class_type: 'UNETLoader', inputs: { unet_name: 'flux.safetensors', weight_dtype: null } },
  })
  const card = nodeCard(page, '1')
  // Each key of a dict input is its own control.
  await expect(card.getByLabel('on', { exact: true })).toBeChecked()
  await card.getByLabel('on', { exact: true }).uncheck()
  await card.getByLabel('strength', { exact: true }).fill('0.8')
  await expect.poll(async () => savedInput(page, '1', 'lora_1'))
    .toEqual({ on: false, lora: 'a.safetensors', strength: 0.8, extra: { deep: 1 } })
  await expect(card.getByText('(empty object)')).toBeVisible()
  await expect(card.getByRole('button', { name: '→ #2 (UNETLoader) · output 0' })).toBeVisible()

  // Nested objects and lists (not links) are JSON; invalid JSON is an error and is not taken.
  const pairs = card.getByLabel('pairs', { exact: true })
  await expect(pairs).toHaveJSProperty('tagName', 'TEXTAREA')
  await pairs.fill('[{"a": 2}, 3]')
  await expect.poll(async () => savedInput(page, '1', 'pairs')).toEqual([{ a: 2 }, 3])
  await pairs.fill('[{"a": 2}, ')
  await expect(card.getByText(/^Invalid JSON: /)).toBeVisible()
  await expect.poll(async () => Object.keys((await savedEditor(page))?.invalid ?? {})).toEqual(['1.pairs'])
  expect(await savedInput(page, '1', 'pairs')).toEqual([{ a: 2 }, 3])
  // An edit that changes the shape keeps the JSON field (a link's shape, a plain number).
  await pairs.fill('[1, 2]')
  await expect.poll(async () => savedInput(page, '1', 'pairs')).toEqual([1, 2])
  await expect(card.getByLabel('pairs', { exact: true })).toHaveJSProperty('tagName', 'TEXTAREA')
  await expect(card.getByRole('button', { name: /^→ #1 / })).toHaveCount(0)
  await pairs.fill('5')
  await expect.poll(async () => savedInput(page, '1', 'pairs')).toBe(5)
  await expect(card.getByLabel('pairs', { exact: true })).toHaveJSProperty('tagName', 'TEXTAREA')
  expect((await savedEditor(page)).invalid).toEqual({})
  const extra = card.getByLabel('extra', { exact: true })
  await extra.fill('{"deep": 2}')
  await expect.poll(async () => (await savedInput(page, '1', 'lora_1'))?.extra).toEqual({ deep: 2 })
  await extra.fill('5')
  await expect.poll(async () => (await savedInput(page, '1', 'lora_1'))?.extra).toBe(5)
  await expect(card.getByLabel('extra', { exact: true })).toHaveJSProperty('tagName', 'TEXTAREA')

  // A null value: empty text, typed text is a string.
  const dtype = nodeField(page, '2', 'weight_dtype')
  await expect(dtype).toHaveAttribute('placeholder', '(null)')
  await dtype.fill('fp8')
  await expect.poll(async () => savedInput(page, '2', 'weight_dtype')).toBe('fp8')
})

test('editor edits survive navigation', async ({ page }) => {
  await page.goto('/comfy?tab=editor')
  await editorCard(page).getByLabel('Workflow file').setInputFiles(WORKFLOW)
  await expect(editorCard(page).getByText('Loaded workflow from JSON file: 9 nodes.')).toBeVisible()
  await nodeField(page, '6', 'text').fill('an edited prompt')
  await nodeField(page, '3', 'steps').fill('')

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page).toHaveURL(/\/models$/)
  await expect(editorCard(page)).toHaveCount(0)
  await nav.getByRole('link', { name: 'ComfyUI', exact: true }).click()
  await page.getByRole('tab', { name: 'Workflow editor' }).click()
  await expect(nodeField(page, '6', 'text')).toHaveValue('an edited prompt')
  // The field shows the workflow's value again, so it is no longer invalid.
  await expect(nodeField(page, '3', 'steps')).toHaveValue('20')
  await expect.poll(async () => (await savedEditor(page)).invalid).toEqual({})

  // A reload keeps the draft: the server's workflow does not replace it.
  await page.reload()
  await expect(nodeField(page, '6', 'text')).toHaveValue('an edited prompt')
  await page.waitForTimeout(400)
  await expect(nodeField(page, '6', 'text')).toHaveValue('an edited prompt')
  expect((await savedEditor(page)).dirty).toBe(true)
})

test('editor first entry loads the server workflow', async ({ page }) => {
  await page.route('**/api/comfy/editor/workflow', (route) =>
    route.fulfill({ json: { workflow: { '5': { class_type: 'EmptyLatentImage', inputs: { width: 512 } } }, node_count: 1 } }))
  await page.goto('/comfy?tab=editor')
  await expect(editorCard(page).getByText('Loaded the workflow from the last session: 1 nodes.')).toBeVisible()
  await expect(nodeField(page, '5', 'width')).toHaveValue('512')
  expect((await savedEditor(page))?.dirty ?? false).toBe(false)
})

test('editor state over the storage quota shows a toast', async ({ page }) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'flux.comfy.editor') throw new DOMException('Full', 'QuotaExceededError')
      return set.call(this, key, value)
    }
  })
  await page.goto('/comfy?tab=editor')
  await editorCard(page).getByLabel('Workflow file').setInputFiles(WORKFLOW)
  await expect(page.getByText('Could not keep the edited workflow in this tab.')).toBeVisible()
  // The editor carries on with the draft in memory.
  await expect(nodeField(page, '6', 'text')).toHaveValue(WORKFLOW_PROMPT)
})

test('a field that becomes another control drops its error', async ({ page }) => {
  // The schemas arrive only when released: until then `sampler` (a number) is a number field.
  let release!: () => void
  const arrived = new Promise<void>((r) => (release = r))
  await page.route((url) => url.pathname === '/api/comfy/object_info', async (route) => {
    await arrived
    return route.fulfill({ json: OBJECT_INFO })
  })
  await page.goto('/comfy?tab=editor')
  await loadEditorJson(page, { '20': { class_type: 'MyNode', inputs: { sampler: 3 } } })
  await nodeField(page, '20', 'sampler').fill('')
  await expect.poll(async () => Object.keys((await savedEditor(page))?.invalid ?? {})).toEqual(['20.sampler'])

  // Now a list guessed from the name: the number field and its error are gone, so nothing blocks.
  release()
  await expect(nodeField(page, '20', 'sampler')).toHaveJSProperty('tagName', 'SELECT')
  await expect.poll(async () => (await savedEditor(page)).invalid).toEqual({})
})
