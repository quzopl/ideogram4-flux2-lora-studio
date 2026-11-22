import type { APIRequestContext, Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_WORK } from './env.ts'
import { expect, test } from './fixtures.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
// The backend resolves paths, so use the real path of the temp dir.
const SRC = path.join(fs.realpathSync(E2E_WORK), 'crops')
// Never PUT to this one before the legacy test: a stored plan stops the import.
const LEGACY = path.join(fs.realpathSync(E2E_WORK), 'crops-legacy')

type Box = [number, number, number, number]
interface CropDoc {
  plan: Record<string, Box>
  mode: string
  exists: boolean
}

test.beforeAll(() => {
  for (const dir of [SRC, LEGACY]) {
    fs.mkdirSync(dir, { recursive: true })
    // Same aspect ratio, twice the size.
    fs.copyFileSync(path.join(FIXTURES, 'crop-400x300.png'), path.join(dir, 'a.png'))
    fs.copyFileSync(path.join(FIXTURES, 'crop-800x600.png'), path.join(dir, 'b.png'))
  }
})

const getCrops = async (request: APIRequestContext, folder = SRC) =>
  (await (await request.get(`/api/crops?${new URLSearchParams({ folder })}`)).json()) as CropDoc

test.beforeEach(async ({ request }) => {
  const res = await request.put('/api/crops', { data: { folder: SRC, plan: {}, mode: 'center' } })
  expect(res.ok()).toBe(true)
})

const playground = (folder = SRC, extra: Record<string, string> = {}) =>
  `/_playground?${new URLSearchParams({ cropFolder: folder, cropFiles: 'a.png,b.png', ...extra })}`

/** Opens the editor for `name` and waits until the box is drawn. */
async function openEditor(page: Page, name: string) {
  await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name })
  await expect(dialog.getByTestId('crop-size')).toHaveText(/^crop \d+ × \d+ px$/)
  return dialog
}

/** Screen px per source px of the open image (`srcW` px wide). */
async function scaleOf(page: Page, srcW = 400) {
  const w = await page.getByTestId('crop-stage').locator('img').evaluate((img) => (img as { clientWidth: number }).clientWidth)
  return w / srcW
}

/** Drags a resize handle by (dx, dy) screen px. */
async function dragHandle(page: Page, handle: string, dx: number, dy: number) {
  const h = page.locator(`[data-h="${handle}"]`)
  await h.hover()
  const b = (await h.boundingBox())!
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 5 })
  await page.mouse.up()
}

test('save writes a manual crop', async ({ page, request }) => {
  await page.goto(playground())
  const dialog = await openEditor(page, 'a.png')
  await expect(dialog.getByTestId('crop-size')).toHaveText('crop 400 × 300 px')
  const s = await scaleOf(page)
  await dragHandle(page, 'se', -50, -50)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()

  await expect.poll(async () => (await getCrops(request)).mode).toBe('manual')
  const box = (await getCrops(request)).plan['a.png']
  expect(box.every((v) => Number.isInteger(v))).toBe(true)
  expect(box[0]).toBe(0)
  expect(box[1]).toBe(0)
  expect(Math.abs(box[2] - (400 - 50 / s))).toBeLessThanOrEqual(1)
  expect(Math.abs(box[3] - (300 - 50 / s))).toBeLessThanOrEqual(1)
})

test('drag converts screen px to source px', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.goto(playground())
  const dialog = await openEditor(page, 'b.png')
  await expect(dialog.getByTestId('crop-size')).toHaveText('crop 800 × 600 px')
  const s = await scaleOf(page, 800)
  // The 800 px preview is shown smaller, so a screen px is more than a source px.
  expect(s).toBeLessThan(0.9)
  await dragHandle(page, 'nw', 60, 30)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await getCrops(request)).plan['b.png']).toBeTruthy()
  const [x, y, w, h] = (await getCrops(request)).plan['b.png']
  expect(Math.abs(x - 60 / s)).toBeLessThanOrEqual(1)
  expect(Math.abs(y - 30 / s)).toBeLessThanOrEqual(1)
  expect(Math.abs(w - (800 - 60 / s))).toBeLessThanOrEqual(1)
  expect(Math.abs(h - (600 - 30 / s))).toBeLessThanOrEqual(1)
})

test('crop plan survives reload', async ({ page, request }) => {
  await page.goto(playground())
  let dialog = await openEditor(page, 'a.png')
  await dragHandle(page, 'se', -50, -50)
  const size = await dialog.getByTestId('crop-size').textContent()
  // Arrow keys move the box while the stage has focus; Shift moves 10 px.
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('ArrowDown')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await getCrops(request)).plan['a.png']?.slice(0, 2)).toEqual([10, 1])
  const saved = (await getCrops(request)).plan['a.png']

  await page.reload()
  await expect(page.getByTestId('crop-plan')).toContainText(JSON.stringify(saved))
  dialog = await openEditor(page, 'a.png')
  await expect(dialog.getByTestId('crop-size')).toHaveText(size!)
})

test('legacy crop plan is imported', async ({ page, request }) => {
  const key = `cropPlan:${LEGACY}`
  const value = JSON.stringify({ plan: { 'a.png': [10, 10, 100, 100] }, mode: 'manual' })
  expect((await getCrops(request, LEGACY)).exists).toBe(false)
  await page.addInitScript(([k, v]) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(k, v), [key, value])
  await page.goto(playground(LEGACY))
  await expect.poll(async () => (await getCrops(request, LEGACY)).exists).toBe(true)
  const doc = await getCrops(request, LEGACY)
  expect(doc.plan).toEqual({ 'a.png': [10, 10, 100, 100] })
  expect(doc.mode).toBe('manual')
  await expect(page.getByTestId('crop-plan')).toContainText('[10,10,100,100]')
  // The classic entry stays, for the classic view.
  expect(await page.evaluate((k) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(k), key)).toBe(value)
})

test('apply to same ratio', async ({ page, request }) => {
  await page.goto(playground())
  const dialog = await openEditor(page, 'a.png')
  await dragHandle(page, 'se', -50, -50)
  await page.keyboard.press('Shift+ArrowRight')
  await dialog.getByRole('button', { name: 'Apply to same ratio', exact: true }).click()
  await expect(dialog).toBeHidden()

  await expect.poll(async () => Object.keys((await getCrops(request)).plan).sort()).toEqual(['a.png', 'b.png'])
  const doc = await getCrops(request)
  expect(doc.mode).toBe('manual')
  const a = doc.plan['a.png']
  const b = doc.plan['b.png']
  for (let i = 0; i < 4; i++) expect(Math.abs(b[i] - a[i] * 2)).toBeLessThanOrEqual(1)
  expect(a[0]).toBe(10)
})

test('square locks ratio', async ({ page, request }) => {
  await page.goto(playground(SRC, { cropSquare: '1' }))
  const dialog = await openEditor(page, 'a.png')
  await expect(dialog.getByRole('combobox', { name: 'Aspect ratio' })).toBeDisabled()
  await expect(dialog.getByRole('combobox', { name: 'Aspect ratio' })).toContainText('1:1')
  await expect(dialog.getByTestId('crop-size')).toHaveText('crop 300 × 300 px')
  await dragHandle(page, 'se', -60, -20)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()

  await expect.poll(async () => (await getCrops(request)).mode).toBe('manual')
  const [, , w, h] = (await getCrops(request)).plan['a.png']
  expect(w).toBe(h)
  expect(w).toBeLessThan(300)
})

test('cancel and Esc close without saving', async ({ page, request }) => {
  await page.goto(playground())
  let dialog = await openEditor(page, 'a.png')
  await dragHandle(page, 'se', -50, -50)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  dialog = await openEditor(page, 'a.png')
  await expect(dialog.getByTestId('crop-size')).toHaveText('crop 400 × 300 px')
  await dragHandle(page, 'se', -50, -50)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.waitForTimeout(500)
  expect(await getCrops(request)).toMatchObject({ plan: {}, mode: 'center' })
})

test('auto (Florence) sets the box from the job', async ({ page }) => {
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/crop/auto', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { job_id: 'c1', total: 1 } })
  })
  const job = (state: string, crops = {}) => ({ state, total: 1, processed: state === 'done' ? 1 : 0, current: 'a.png', error: '', crops, skipped: [] })
  let polls = 0
  await page.route('**/api/crop/auto/c1', (route) =>
    route.fulfill({ json: polls++ === 0 ? job('processing') : job('done', { 'a.png': [20, 20, 200, 150] }) }))
  await page.goto(playground())
  const dialog = await openEditor(page, 'a.png')
  await dialog.getByRole('button', { name: 'Auto (Florence)', exact: true }).click()
  await expect(dialog.getByTestId('crop-size')).toHaveText('crop 200 × 150 px')
  expect(bodies[0]).toMatchObject({ folder: SRC, names: ['a.png'], square: false, mode: 'person', resolution: 1024, step: 64 })
})

test('auto (Florence) shows the first line of a job error', async ({ page }) => {
  await page.route('**/api/crop/auto', (route) => route.fulfill({ json: { job_id: 'c2', total: 1 } }))
  await page.route('**/api/crop/auto/c2', (route) =>
    route.fulfill({ json: { state: 'error', total: 1, processed: 0, current: '', error: 'Models folder not set\nTraceback (most recent call last):', crops: {}, skipped: [] } }))
  await page.goto(playground())
  const dialog = await openEditor(page, 'a.png')
  await dialog.getByRole('button', { name: 'Auto (Florence)', exact: true }).click()
  const err = dialog.getByTestId('crop-auto-error')
  await expect(err).toHaveText('Models folder not set')
  await expect(err).toHaveAttribute('title', /Traceback/)
})

test('ratio choice persists across opens', async ({ page }) => {
  await page.goto(playground())
  let dialog = await openEditor(page, 'a.png')
  const ratio = dialog.getByRole('combobox', { name: 'Aspect ratio' })
  await expect(ratio).toHaveText('Free')
  await ratio.click()
  await page.getByRole('option', { name: '1:1', exact: true }).click()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  dialog = await openEditor(page, 'b.png')
  await expect(dialog.getByRole('combobox', { name: 'Aspect ratio' })).toHaveText('1:1')
  await expect(dialog.getByTestId('crop-size')).toHaveText('crop 600 × 600 px')
})

test('auto (Florence) explains a job that is gone', async ({ page }) => {
  await page.route('**/api/crop/auto', (route) => route.fulfill({ json: { job_id: 'c3', total: 1 } }))
  await page.route('**/api/crop/auto/c3', (route) => route.fulfill({ status: 404, json: { detail: 'Unknown job.' } }))
  await page.goto(playground())
  const dialog = await openEditor(page, 'a.png')
  await dialog.getByRole('button', { name: 'Auto (Florence)', exact: true }).click()
  await expect(dialog.getByTestId('crop-auto-error')).toHaveText('The auto-crop job is gone (was the server restarted?)')
  await expect(dialog.getByRole('button', { name: 'Auto (Florence)', exact: true })).toBeEnabled()
})
