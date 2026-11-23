import type { Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
