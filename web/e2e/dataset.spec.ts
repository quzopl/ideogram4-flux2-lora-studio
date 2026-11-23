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
  await page.getByRole('button', { name: /Drop images here|Uploading…/ }).dispatchEvent('drop', { dataTransfer: dt })
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

test('a drop while an upload runs is ignored', async ({ page }) => {
  let uploads = 0
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/api/upload', async (route) => {
    uploads++
    await held
    return route.fulfill({ json: { folder: A, count: 2, files: ['a.png', 'b.png'] } })
  })
  await page.goto('/dataset')
  await drop(page, { 'one.png': 'a.png' })
  await expect(page.getByRole('button', { name: /Uploading…/ })).toBeVisible()
  await drop(page, { 'two.png': 'b.png' })
  release()
  await expect(status(page)).toContainText('Uploaded 2 images.')
  await expect(tiles(page)).toHaveCount(2)
  expect(uploads).toBe(1)
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

  // Filling the default VLM model can save too; wait for the save with the new resolution.
  const saved = page.waitForResponse((r) =>
    r.url().endsWith('/api/settings/forms/dataset') && r.request().method() === 'PUT' && r.request().postData()!.includes('"resolution":1280'))
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

/** Goes to Models and waits until the Dataset view has unmounted, then comes back. */
async function leaveAndReturn(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page).toHaveURL(/\/models$/)
  await expect(page.getByRole('heading', { name: 'Dataset', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Auto-crop all' })).toHaveCount(0)
  await nav.getByRole('link', { name: 'Dataset', exact: true }).click()
  await expect(page).toHaveURL(/\/dataset$/)
}

test('auto-crop all is merged after leaving the view', async ({ page, request }) => {
  await page.route('**/api/crop/auto', (route) => route.fulfill({ json: { job_id: 'nav1', total: 2 } }))
  const phase = { done: false, polls: 0 }
  const box: Box = [10, 20, 200, 150]
  await page.route('**/api/crop/auto/nav1', (route) => {
    phase.polls++
    return route.fulfill({
      json: phase.done
        ? { state: 'done', total: 2, processed: 2, current: '', error: '', crops: { 'a.png': box }, skipped: [] }
        : { state: 'processing', total: 2, processed: 1, current: 'b.png', error: '', crops: {}, skipped: [] },
    })
  })
  await page.goto('/dataset')
  await scan(page, A, 2)
  await page.getByRole('button', { name: 'Auto-crop all' }).click()
  await expect.poll(() => phase.polls).toBeGreaterThan(0)

  await leaveAndReturn(page)
  await expect(tiles(page)).toHaveCount(2)
  phase.done = true
  await expect.poll(async () => (await getCrops(request, A)).mode).toBe('manual')
  expect((await getCrops(request, A)).plan).toEqual({ 'a.png': box })
  await expect(page.getByText('Auto-crop done: 1 crop computed.')).toBeVisible()

  // Merged once: a later visit does not bring cleared crops back.
  await page.getByRole('button', { name: 'Clear crops', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Clear', exact: true }).click()
  await expect.poll(async () => (await getCrops(request, A)).plan).toEqual({})
  await leaveAndReturn(page)
  await expect(page.getByText('Auto-crop done: 1 crop computed.')).toBeVisible()
  await expect(page.getByText('0 of 2 images have a crop.')).toBeVisible()
  await page.waitForTimeout(800)
  await expect(page.getByText('0 of 2 images have a crop.')).toBeVisible()
  expect((await getCrops(request, A)).plan).toEqual({})
})

test('an unknown auto-crop job (404) is forgotten', async ({ page }) => {
  await page.route('**/api/crop/auto', (route) => route.fulfill({ json: { job_id: 'gone1', total: 2 } }))
  await page.route('**/api/crop/auto/gone1', (route) => route.fulfill({ status: 404, json: { detail: 'Unknown job.' } }))
  await page.goto('/dataset')
  await scan(page, A, 2)
  await page.getByRole('button', { name: 'Auto-crop all' }).click()
  await expect(toasts(page).filter({ hasText: 'The auto-crop job is gone (was the server restarted?)' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Auto-crop all' })).toBeEnabled()
  expect(await page.evaluate(() => sessionStorage.getItem('flux.dataset.cropAuto'))).toBeNull()
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

// ---------------------------------------------------------------------------
// Processing, caption review and export (the job endpoints are mocked).

interface Result {
  idx: number
  src_name: string
  out_name: string
  width: number
  height: number
  caption: string
  upscaled: boolean
  upscale_error: string
}

const result = (idx: number, extra: Partial<Result> = {}): Result => ({
  idx,
  src_name: `${'abc'[idx]}.png`,
  out_name: `person_000${idx}.png`,
  width: 1024,
  height: 768,
  caption: `Caption ${idx}`,
  upscaled: false,
  upscale_error: '',
  ...extra,
})

const failed = (idx: number): Result =>
  result(idx, { out_name: '', width: 0, height: 0, caption: '[ERROR: cannot identify image]' })

interface JobPhase {
  state: string
  processed?: number
  current?: string
  error?: string
  results?: Result[]
  caption_format?: string
}

/**
 * Mocks POST /api/process (bodies collected) and GET /api/job/job1, which
 * answers with `phases[phase.i]`; the test moves `phase.i` on.
 */
async function mockJob(page: Page, phases: JobPhase[]) {
  const bodies: Record<string, unknown>[] = []
  const phase = { i: 0, polls: 0 }
  await page.route('**/api/process', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { job_id: 'job1', total: 3 } })
  })
  await page.route('**/api/job/*', (route) => {
    phase.polls++
    const p = phases[Math.min(phase.i, phases.length - 1)]
    return route.fulfill({
      json: {
        id: 'job1',
        state: p.state,
        total: 3,
        processed: p.processed ?? p.results?.length ?? 0,
        current: p.current ?? '',
        error: p.error ?? '',
        config: { mode: 'person', caption_format: p.caption_format ?? 'flux' },
        results: p.results ?? [],
      },
    })
  })
  await page.route('**/api/thumb/**', (route) => route.fulfill({ path: path.join(FIXTURES, 'a.png') }))
  return { bodies, phase }
}

const cards = (page: Page) => page.getByTestId('result-card')
const caption = (page: Page, out: string) => page.getByRole('textbox', { name: `Caption of ${out}`, exact: true })
const toasts = (page: Page) => page.locator('[data-sonner-toast]')

/** Scans A and starts processing it (the job is mocked). */
async function processA(page: Page) {
  await page.goto('/dataset')
  await scan(page, A, 2)
  await processBtn(page).click()
}

test('process sends the form', async ({ page, request }) => {
  const plan = { 'a.png': [1, 2, 30, 40] }
  await request.put('/api/crops', { data: { folder: A, plan, mode: 'manual' } })
  const { bodies } = await mockJob(page, [{ state: 'processing' }])
  await page.goto('/dataset')
  await scan(page, A, 2)
  await expect(combo(page, 'Crop source')).toHaveText('Manual (per-image crops)')
  await processBtn(page).click()
  await expect.poll(() => bodies.length).toBe(1)
  // toProcessRequest: the form without the export-only fields, plus the folder's crop plan.
  expect(bodies[0]).toEqual({
    folder: A,
    mode: 'person',
    style: 'concise',
    caption_format: 'flux',
    resolution: 1024,
    step: 64,
    square: false,
    fit: 'cover',
    pad_color: '#000000',
    centering_x: 'center',
    centering_y: 'center',
    fmt: 'png',
    jpg_quality: 95,
    model: expect.any(String),
    quant: '4bit',
    max_tokens: 512,
    do_caption: true,
    upscale_model: '',
    crop_mode: 'manual',
    crops: plan,
  })
  await expect(processBtn(page)).toBeDisabled()
})

test('results arrive while processing', async ({ page }) => {
  const { phase } = await mockJob(page, [
    { state: 'loading_model', current: 'Loading the VLM model…' },
    { state: 'processing', current: 'b.png', results: [result(0, { upscaled: true })] },
    { state: 'done', results: [result(0, { upscaled: true }), result(1)] },
  ])
  await processA(page)
  const progress = page.getByTestId('job-progress')
  await expect(progress).toHaveAttribute('data-state', 'loading_model')
  await expect(progress).toContainText('Loading the VLM model…')
  await expect(cards(page)).toHaveCount(0)
  await expect(processBtn(page)).toBeDisabled()

  phase.i = 1
  await expect(progress).toHaveAttribute('data-state', 'processing')
  await expect(progress).toContainText('b.png')
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page).first()).toContainText('person_0000.png')
  await expect(cards(page).first()).toContainText('1024×768')
  await expect(cards(page).first()).toContainText('✨')
  await expect(caption(page, 'person_0000.png')).toHaveValue('Caption 0')
  await expect(page.getByRole('button', { name: 'Save to folder', exact: true })).toBeDisabled()

  phase.i = 2
  await expect(progress).toHaveAttribute('data-state', 'done')
  await expect(cards(page)).toHaveCount(2)
  await expect(cards(page).nth(1)).toContainText('person_0001.png')
  await expect(cards(page).nth(1)).not.toContainText('✨')
  await expect(processBtn(page)).toBeEnabled()
  await expect(page.getByText('To export: 2 images')).toBeVisible()
})

test('caption edits survive navigation and polling', async ({ page }) => {
  const { phase } = await mockJob(page, [
    { state: 'processing', results: [result(0)] },
    { state: 'processing', results: [result(0), result(1)] },
  ])
  await processA(page)
  await expect(cards(page)).toHaveCount(1)
  await caption(page, 'person_0000.png').fill('My own caption')

  // A later poll (it brings the second card) keeps the edit.
  phase.i = 1
  await expect(cards(page)).toHaveCount(2)
  await expect(caption(page, 'person_0000.png')).toHaveValue('My own caption')

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page).toHaveURL(/\/models$/)
  // Wait until the exit transition has unmounted the view (a quick return would revive it).
  await expect(cards(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Dataset', exact: true })).toHaveCount(0)
  await nav.getByRole('link', { name: 'Dataset', exact: true }).click()
  await expect(page).toHaveURL(/\/dataset$/)
  await expect(cards(page)).toHaveCount(2)
  await expect(caption(page, 'person_0000.png')).toHaveValue('My own caption')
  await expect(caption(page, 'person_0001.png')).toHaveValue('Caption 1')

  // The run and its edits are kept in sessionStorage.
  await page.reload()
  await expect(cards(page)).toHaveCount(2)
  await expect(caption(page, 'person_0000.png')).toHaveValue('My own caption')
})

test('remove and undo', async ({ page }) => {
  await mockJob(page, [{ state: 'done', results: [result(0), result(1)] }])
  await processA(page)
  await expect(cards(page)).toHaveCount(2)
  await expect(page.getByText('To export: 2 images', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Remove person_0001.png', exact: true }).click()
  await expect(cards(page)).toHaveCount(1)
  await expect(page.getByText('To export: 1 image (1 removed)', { exact: true })).toBeVisible()

  await toasts(page).getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(cards(page)).toHaveCount(2)
  await expect(cards(page).nth(1)).toContainText('person_0001.png')
  await expect(page.getByText('To export: 2 images', { exact: true })).toBeVisible()

  // Nothing left to export: both ways out are off.
  await page.getByRole('textbox', { name: 'Output folder', exact: true }).fill(path.join(WORK, 'ds-out'))
  await expect(page.getByRole('button', { name: 'Save to folder', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Remove person_0000.png', exact: true }).click()
  await page.getByRole('button', { name: 'Remove person_0001.png', exact: true }).click()
  await expect(page.getByText('To export: 0 images (2 removed)', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save to folder', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Download .zip', exact: true })).toBeDisabled()
})

test('export sends only edits and exclusions', async ({ page }) => {
  const out = path.join(WORK, 'ds-out')
  await mockJob(page, [{ state: 'done', results: [result(0), result(1), failed(2)] }])
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/export', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { output_folder: out, written: 1 } })
  })
  await processA(page)
  await expect(cards(page)).toHaveCount(3)

  // A failed file: red card with the error, nothing to edit, not exported.
  const bad = cards(page).nth(2)
  await expect(bad).toContainText('c.png')
  await expect(bad).toContainText('cannot identify image')
  await expect(bad.getByRole('textbox')).toHaveCount(0)
  await expect(page.getByText('To export: 2 images', { exact: true })).toBeVisible()

  await page.getByRole('textbox', { name: 'Trigger word', exact: true }).fill('  ohwx ')
  await expect(cards(page).first().getByTestId('trigger-preview')).toHaveText('ohwx,')
  await caption(page, 'person_0000.png').fill('Edited caption')
  await page.getByRole('button', { name: 'Remove person_0001.png', exact: true }).click()
  await expect(page.getByText('To export: 1 image (1 removed)', { exact: true })).toBeVisible()

  const save = page.getByRole('button', { name: 'Save to folder', exact: true })
  await expect(save).toBeDisabled()
  await page.getByRole('textbox', { name: 'Output folder', exact: true }).fill(out)
  await save.click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toEqual({
    job_id: 'job1',
    output_folder: out,
    trigger: 'ohwx',
    prepend_trigger: true,
    captions: { 0: 'Edited caption' },
    exclude_idx: [1],
  })
  await expect(toasts(page).filter({ hasText: `Saved 1 pair to ${out}` })).toBeVisible()
})

test('json formats preview the trigger in words', async ({ page }) => {
  await mockJob(page, [{ state: 'done', caption_format: 'ideogram', results: [result(0)] }])
  await processA(page)
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page).getByTestId('trigger-preview')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Trigger word', exact: true }).fill('ohwx')
  await expect(cards(page).getByTestId('trigger-preview')).toHaveText('trigger added to high_level_description')
  await page.getByRole('switch', { name: 'Prepend trigger to captions', exact: true }).click()
  await expect(cards(page).getByTestId('trigger-preview')).toHaveCount(0)
})

test('zip downloads with server filename', async ({ page }) => {
  await mockJob(page, [{ state: 'done', results: [result(0), result(1)] }])
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/zip', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({
      body: Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary'),
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="dataset_person_job1abcd.zip"',
      },
    })
  })
  await processA(page)
  await expect(cards(page)).toHaveCount(2)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download .zip', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('dataset_person_job1abcd.zip')
  expect(bodies[0]).toMatchObject({ job_id: 'job1', captions: {}, exclude_idx: [] })
})

test('a failed zip shows the server error', async ({ page }) => {
  await mockJob(page, [{ state: 'done', results: [result(0)] }])
  await page.route('**/api/zip', (route) => route.fulfill({ status: 400, json: { detail: 'No images to package.' } }))
  await processA(page)
  await page.getByRole('button', { name: 'Download .zip', exact: true }).click()
  await expect(toasts(page).filter({ hasText: 'No images to package.' })).toBeVisible()
})

test('empty number field is caught before submit', async ({ page }) => {
  const { bodies } = await mockJob(page, [{ state: 'processing' }])
  await page.goto('/dataset')
  await scan(page, A, 2)
  const field = page.getByRole('spinbutton', { name: 'Max caption length (tokens)', exact: true })
  await field.fill('')
  await processBtn(page).click()
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Enter a whole number from 64 to 8192')).toBeVisible()
  await page.waitForTimeout(500)
  expect(bodies).toHaveLength(0)

  await field.fill('1024')
  await expect(field).not.toHaveAttribute('aria-invalid', 'true')
  await processBtn(page).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toMatchObject({ max_tokens: 1024 })
})

test('processing starts even if the view is left before the job id arrives', async ({ page }) => {
  await mockJob(page, [{ state: 'done', results: [result(0), result(1)] }])
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/api/process', async (route) => {
    await held
    return route.fulfill({ json: { job_id: 'job1', total: 3 } })
  })
  await processA(page)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Dataset', exact: true })).toHaveCount(0)
  await expect(tiles(page)).toHaveCount(0)
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/process'))
  release()
  await answered
  await nav.getByRole('link', { name: 'Dataset', exact: true }).click()
  await expect(cards(page)).toHaveCount(2)
})

test('job errors show their first line', async ({ page }) => {
  await mockJob(page, [{ state: 'error', error: 'CUDA out of memory\nTraceback (most recent call last):\n  File "x"' }])
  await processA(page)
  const progress = page.getByTestId('job-progress')
  await expect(progress).toHaveAttribute('data-state', 'error')
  await expect(progress).toContainText('CUDA out of memory')
  await expect(progress).not.toContainText('Traceback')
  await expect(page.locator('[title*="Traceback"]')).toHaveCount(1)
  await expect(processBtn(page)).toBeEnabled()
})

test('an unknown job (404) stops polling and forgets the run', async ({ page }) => {
  await mockJob(page, [])
  let polls = 0
  await page.route('**/api/job/*', (route) => {
    polls++
    return route.fulfill({ status: 404, json: { detail: 'Unknown job.' } })
  })
  await processA(page)
  await expect(toasts(page).filter({ hasText: 'The processing job is gone (was the server restarted?)' })).toBeVisible()
  await expect(page.getByTestId('job-progress')).toHaveCount(0)
  await expect(processBtn(page)).toBeEnabled()
  expect(await page.evaluate(() => sessionStorage.getItem('flux.dataset.run'))).toBeNull()
  const seen = polls
  await page.waitForTimeout(1500)
  expect(polls).toBe(seen)
})

test('clear crops ignores crops of files no longer in the folder', async ({ page, request }) => {
  await request.put('/api/crops', { data: { folder: A, plan: { 'gone.png': [0, 0, 10, 10] }, mode: 'manual' } })
  await page.goto('/dataset')
  await scan(page, A, 2)
  await expect(page.getByText('0 of 2 images have a crop.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear crops', exact: true })).toBeDisabled()
})

test('a busy GPU (409) shows the reason and the view does not start running', async ({ page }) => {
  await page.route('**/api/process', (route) =>
    route.fulfill({ status: 409, json: { detail: 'Processing in progress — wait for it to finish.' } }))
  await processA(page)
  await expect(
    toasts(page).filter({ hasText: 'Processing in progress — wait for it to finish.' }),
  ).toBeVisible()
  await expect(page.getByTestId('job-progress')).toHaveCount(0)
  await expect(processBtn(page)).toBeEnabled()
})
