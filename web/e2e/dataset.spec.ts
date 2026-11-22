import type { APIRequestContext, Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_WORK } from './env.ts'
import { expect, test } from './fixtures.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
// The backend resolves paths, so use the real path of the temp dir.
const WORK = fs.realpathSync(E2E_WORK)
const THREE = path.join(WORK, 'ds-three')
const A = path.join(WORK, 'ds-a')
const B = path.join(WORK, 'ds-b')
const EMPTY = path.join(WORK, 'ds-empty')

type Box = [number, number, number, number]
interface CropDoc {
  plan: Record<string, Box>
  mode: string
  exists: boolean
}

const copy = (dir: string, files: Record<string, string>) => {
  fs.mkdirSync(dir, { recursive: true })
  for (const [to, from] of Object.entries(files)) fs.copyFileSync(path.join(FIXTURES, from), path.join(dir, to))
}

test.beforeAll(() => {
  copy(THREE, { 'a.png': 'a.png', 'b.png': 'b.png', 'c.png': 'crop-400x300.png' })
  copy(A, { 'a.png': 'crop-400x300.png', 'b.png': 'crop-800x600.png' })
  copy(B, { 'a.png': 'crop-400x300.png', 'b.png': 'crop-800x600.png' })
  fs.mkdirSync(EMPTY, { recursive: true })
})

// The form and the crop plans live on the server and outlive a test.
test.beforeEach(async ({ request }) => {
  expect((await request.put('/api/settings/forms/dataset', { data: { values: {} } })).ok()).toBe(true)
  for (const folder of [THREE, A, B]) {
    expect((await request.put('/api/crops', { data: { folder, plan: {}, mode: 'center' } })).ok()).toBe(true)
  }
})

const getCrops = async (request: APIRequestContext, folder: string) =>
  (await (await request.get(`/api/crops?${new URLSearchParams({ folder })}`)).json()) as CropDoc

const status = (page: Page) => page.getByTestId('source-status')
const tiles = (page: Page) => page.getByTestId('source-tile')
const processBtn = (page: Page) => page.getByRole('button', { name: 'Process images', exact: true })
const combo = (page: Page, name: string) => page.getByRole('combobox', { name, exact: true })

/** Types `folder` into the source field and scans it. */
async function scan(page: Page, folder: string, count: number) {
  const input = page.getByRole('textbox', { name: 'Source folder', exact: true })
  await expect(input).toBeEnabled()
  await input.fill(folder)
  await page.getByRole('button', { name: 'Scan', exact: true }).click()
  await expect(status(page)).toContainText(`Found ${count} images in: ${folder}`)
  await expect(tiles(page)).toHaveCount(count)
}

/** Drops fixture files (as `name -> fixture`) on the drop zone. */
async function drop(page: Page, files: Record<string, string>) {
  const payload = Object.entries(files).map(([name, from]) => [name, fs.readFileSync(path.join(FIXTURES, from)).toString('base64')])
  // The e2e tsconfig has no DOM lib: the browser globals are typed by hand.
  const dt = await page.evaluateHandle((list) => {
    const g = globalThis as unknown as {
      DataTransfer: new () => { items: { add(f: unknown): void } }
      File: new (parts: unknown[], name: string, opts: { type: string }) => unknown
    }
    const t = new g.DataTransfer()
    for (const [name, b64] of list) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      t.items.add(new g.File([bytes], name, { type: 'image/png' }))
    }
    return t
  }, payload)
  await page.getByRole('button', { name: /Drop images here/ }).dispatchEvent('drop', { dataTransfer: dt })
}

test('scan shows the grid', async ({ page }) => {
  await page.goto('/dataset')
  await expect(processBtn(page)).toBeDisabled()
  await scan(page, THREE, 3)
  for (const img of await tiles(page).locator('img').all()) {
    await expect(img).toHaveAttribute('src', /^\/api\/src\/thumb\?/)
    await expect.poll(() => img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0)
  }
  await expect(processBtn(page)).toBeEnabled()
})

test('saved folder is scanned on entry; scan errors stay in the status line', async ({ page }) => {
  await page.goto('/dataset')
  // The form autosaves 500 ms after a change; a reload does not wait for it.
  const saved = page.waitForResponse((r) =>
    r.url().endsWith('/api/settings/forms/dataset') && r.request().method() === 'PUT' && r.request().postData()!.includes(A))
  await scan(page, A, 2)
  expect((await saved).ok()).toBe(true)
  await page.reload()
  await expect(status(page)).toContainText(`Found 2 images in: ${A}`)
  await expect(tiles(page)).toHaveCount(2)

  const input = page.getByRole('textbox', { name: 'Source folder', exact: true })
  await input.fill(path.join(WORK, 'missing'))
  await input.press('Enter')
  await expect(status(page)).toContainText('Folder does not exist')
  await expect(tiles(page)).toHaveCount(0)
  await expect(processBtn(page)).toBeDisabled()
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
})

test('upload via drop', async ({ page }) => {
  await page.goto('/dataset')
  await expect(page.getByLabel('Upload images')).toHaveAttribute('accept', /\.heic/)
  const uploaded = page.waitForResponse((r) => r.url().endsWith('/api/upload'))
  await drop(page, { 'one.png': 'a.png', 'two.png': 'b.png' })
  const r = (await (await uploaded).json()) as { folder: string }
  await expect(tiles(page)).toHaveCount(2)
  await expect(status(page)).toContainText('Uploaded 2 images.')
  await expect(tiles(page).first().locator('img')).toHaveAttribute('src', `/api/src/thumb?${new URLSearchParams({ folder: r.folder, name: 'one.png' })}`)
  await expect(processBtn(page)).toBeEnabled()
})

test('upload with no supported files explains why', async ({ page }) => {
  await page.route('**/api/upload', (route) => route.fulfill({ json: { folder: EMPTY, count: 0, files: [] } }))
  await page.goto('/dataset')
  await scan(page, A, 2)
  await expect(processBtn(page)).toBeEnabled()
  await drop(page, { 'notes.png': 'a.png' })
  await expect(status(page)).toContainText('No supported images in the upload')
  await expect(tiles(page)).toHaveCount(0)
  await expect(processBtn(page)).toBeDisabled()
})

test('settings autosave and defaults', async ({ page }) => {
  await page.goto('/dataset')
  await expect(combo(page, 'Caption mode')).toBeEnabled()
  await expect(combo(page, 'Caption mode')).toHaveText('Person (variable traits only)')
  await expect(combo(page, 'Target resolution')).toHaveText('1024')
  await expect(combo(page, 'Bucket step (px)')).toHaveText('64')
  await expect(combo(page, 'Upscale model')).toHaveText('Off (plain LANCZOS)')

  const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings/forms/dataset') && r.request().method() === 'PUT')
  await combo(page, 'Target resolution').click()
  await page.getByRole('option', { name: '1280', exact: true }).click()
  expect((await saved).ok()).toBe(true)

  await page.reload()
  await expect(combo(page, 'Target resolution')).toHaveText('1280')
})

test('crop badge after editor save', async ({ page }) => {
  await page.goto('/dataset')
  await scan(page, A, 2)
  const tile = tiles(page).filter({ hasText: 'a.png' })
  await expect(tile).not.toContainText('✂')
  await tile.click()
  const dialog = page.getByRole('dialog', { name: 'a.png' })
  await expect(dialog.getByTestId('crop-size')).toHaveText('crop 400 × 300 px')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(tile).toContainText('✂')
  await expect(tiles(page).filter({ hasText: 'b.png' })).not.toContainText('✂')
  await expect(page.getByText('1 of 2 images have a crop.')).toBeVisible()
})

test('vlm select lists api models', async ({ page }) => {
  await page.route('**/api/models', (route) =>
    route.fulfill({ json: { models: { 'org/one': 'Model One', 'org/two': 'Model Two' }, default: 'org/two' } }))
  await page.goto('/dataset')
  const select = combo(page, 'VLM model')
  await expect(select).toHaveText('Model Two')
  await select.click()
  const options = page.getByRole('option')
  await expect(options).toHaveCount(2)
  await expect(options.nth(0)).toContainText('Model One')
  await expect(options.nth(1)).toContainText('Model Two')
})

test('auto-crop all confirms and merges', async ({ page, request }) => {
  const old: Box = [0, 0, 100, 100]
  await request.put('/api/crops', { data: { folder: A, plan: { 'a.png': old, 'b.png': old }, mode: 'center' } })
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/crop/auto', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { job_id: 'all1', total: 2 } })
  })
  const job = (state: string, crops = {}, skipped: string[] = []) =>
    ({ state, total: 2, processed: state === 'done' ? 2 : 1, current: 'b.png', error: '', crops, skipped })
  let polls = 0
  await page.route('**/api/crop/auto/all1', (route) =>
    route.fulfill({ json: polls++ === 0 ? job('processing') : job('done', { 'a.png': [10, 20, 200, 150] }, ['b.png: cannot identify image']) }))

  await page.goto('/dataset')
  await scan(page, A, 2)
  await expect(page.getByText('2 of 2 images have a crop.')).toBeVisible()
  await page.getByRole('button', { name: 'Auto-crop all' }).click()
  const confirm = page.getByRole('dialog')
  await expect(confirm).toContainText('keep their current crop (2 existing)')
  await confirm.getByRole('button', { name: 'Auto-crop', exact: true }).click()

  await expect(page.getByText('b.png: cannot identify image')).toBeVisible()
  await expect.poll(async () => (await getCrops(request, A)).mode).toBe('manual')
  const doc = await getCrops(request, A)
  expect(doc.plan).toEqual({ 'a.png': [10, 20, 200, 150], 'b.png': old })
  expect(bodies[0]).toMatchObject({ folder: A, mode: 'person', resolution: 1024, step: 64, square: false })
  await expect(combo(page, 'Crop source')).toHaveText('Manual (per-image crops)')
})

test('clear crops asks first', async ({ page, request }) => {
  await request.put('/api/crops', { data: { folder: A, plan: { 'a.png': [0, 0, 10, 10] }, mode: 'manual' } })
  await page.goto('/dataset')
  await scan(page, A, 2)
  await page.getByRole('button', { name: 'Clear crops', exact: true }).click()
  const confirm = page.getByRole('dialog')
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(tiles(page).filter({ hasText: 'a.png' })).toContainText('✂')
  await page.getByRole('button', { name: 'Clear crops', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(tiles(page).filter({ hasText: 'a.png' })).not.toContainText('✂')
  await expect.poll(async () => (await getCrops(request, A)).plan).toEqual({})
})

test('crop source is per folder', async ({ page }) => {
  await page.goto('/dataset')
  await scan(page, A, 2)
  const source = combo(page, 'Crop source')
  await expect(source).toHaveText('Centre (whole frame)')
  await source.click()
  await page.getByRole('option', { name: 'Manual (per-image crops)', exact: true }).click()
  await expect(source).toHaveText('Manual (per-image crops)')

  await scan(page, B, 2)
  await expect(source).toHaveText('Centre (whole frame)')
  // Auto with nothing computed says what will happen.
  await source.click()
  await page.getByRole('option', { name: 'Auto (Florence-2 subject)', exact: true }).click()
  await expect(page.getByText('Run "Auto-crop all" to compute crops — without them the centre crop is used.')).toBeVisible()

  await scan(page, A, 2)
  await expect(source).toHaveText('Manual (per-image crops)')
})
