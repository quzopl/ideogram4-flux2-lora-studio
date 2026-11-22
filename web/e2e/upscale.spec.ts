import type { Page, Route } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_WORK } from './env.ts'
import { expect, test } from './fixtures.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
// The backend resolves paths, so use the real path of the temp dir.
const SRC = path.join(fs.realpathSync(E2E_WORK), 'upscale-src')

test.beforeAll(() => {
  fs.mkdirSync(SRC, { recursive: true })
  for (const f of ['a.png', 'b.png']) fs.copyFileSync(path.join(FIXTURES, f), path.join(SRC, f))
})

/** Opens the view and fills source folder and model (every test sets its own, the form is shared). */
async function ready(page: Page) {
  await page.goto('/upscale')
  const folder = page.getByRole('textbox', { name: 'Source folder' })
  await expect(folder).toBeEnabled()
  await folder.fill(SRC)
  await expect(page.getByText('2 images', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Model' }).click()
  await page.getByRole('option').first().click()
}

/** Captures the body of POST /api/upscale/run and answers with job "job1". */
async function mockRun(page: Page) {
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/upscale/run', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { job_id: 'job1', total: 2 } })
  })
  return bodies
}

const result = (idx: number, extra: Record<string, unknown> = {}) => ({
  idx,
  src_name: idx === 0 ? 'a.png' : 'b.png',
  out_name: `${String(idx).padStart(4, '0')}_up.png`,
  width: 256,
  height: 192,
  error: '',
  passes: 2,
  device: 'RTX 4070 Ti · 12 GB',
  ...extra,
})

const job = (state: string, results: unknown[], error = '') => ({
  state,
  total: 2,
  processed: results.length,
  current: state === 'processing' ? 'b.png' : '',
  error,
  results,
})

/** Serves `states` in order from GET /api/upscale/job/*, then repeats the last. */
async function mockJob(page: Page, states: unknown[]) {
  let i = 0
  await page.route('**/api/upscale/job/*', (route) => route.fulfill({ json: states[Math.min(i++, states.length - 1)] }))
  const png = (route: Route) => route.fulfill({ path: path.join(FIXTURES, 'big.png') })
  await page.route('**/api/upscale/thumb/**', png)
  await page.route('**/api/upscale/image/**', png)
}

const upscale = (page: Page) => page.getByRole('button', { name: 'Upscale', exact: true })

test('x3 sends factor 3', async ({ page }) => {
  const bodies = await mockRun(page)
  await mockJob(page, [job('done', [])])
  await ready(page)
  await page.getByRole('button', { name: 'x3', exact: true }).click()
  await upscale(page).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toMatchObject({ folder: SRC, mode: 'factor', factor: 3 })
})

test('custom factor validated', async ({ page }) => {
  const bodies = await mockRun(page)
  await mockJob(page, [job('done', [])])
  await ready(page)
  await page.getByRole('button', { name: 'Custom', exact: true }).click()
  const factor = page.getByRole('spinbutton', { name: 'Factor' })
  await factor.fill('9')
  await expect(page.getByText('Between 1.5 and 8')).toBeVisible()
  await expect(upscale(page)).toBeDisabled()

  await factor.fill('2.5')
  await expect(page.getByText('Between 1.5 and 8')).toBeHidden()
  await upscale(page).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toMatchObject({ mode: 'factor', factor: 2.5 })
})

test('results grid and before/after', async ({ page }) => {
  await mockRun(page)
  await mockJob(page, [
    job('processing', [result(0)]),
    job('processing', [result(0)]),
    job('done', [result(0), result(1)]),
  ])
  await ready(page)
  await page.getByRole('button', { name: 'x2', exact: true }).click()
  await upscale(page).click()
  // One job at a time.
  await expect(upscale(page)).toBeDisabled()

  const cards = page.getByTestId('result-card')
  await expect(cards).toHaveCount(2)
  await expect(page.getByTestId('job-progress')).toHaveAttribute('data-state', 'done')
  await expect(upscale(page)).toBeEnabled()
  for (const card of await cards.all()) {
    await expect(card).toContainText('2 passes · RTX 4070 Ti')
    await expect(card).toContainText('256×192')
  }

  await cards.first().click()
  const preview = page.getByTestId('before-after')
  await expect(preview).toBeVisible()
  const handle = preview.getByRole('slider')
  await expect(handle).toHaveAttribute('aria-valuenow', '50')
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '45')
  await page.keyboard.press('Escape')
  await expect(preview).toBeHidden()
  await expect(page.getByRole('link', { name: 'Download .zip' })).toHaveAttribute('href', '/api/upscale/zip/job1')
})

test('job and file errors show', async ({ page }) => {
  await mockRun(page)
  await mockJob(page, [job('error', [result(0, { error: 'cannot identify image file', out_name: '', passes: 0 })], 'CUDA out of memory\nTraceback (most recent call last):')])
  await ready(page)
  await page.getByRole('button', { name: 'x2', exact: true }).click()
  await upscale(page).click()
  await expect(page.getByTestId('job-progress')).toHaveAttribute('data-state', 'error')
  await expect(page.getByTestId('job-progress')).toContainText('CUDA out of memory')
  await expect(page.getByTestId('job-progress')).not.toContainText('Traceback')
  await expect(page.getByTestId('result-card')).toContainText('cannot identify image file')
})

test('upscale form autosaves', async ({ page }) => {
  await page.goto('/upscale')
  const x4 = page.getByRole('button', { name: 'x4', exact: true })
  const jpg = page.getByRole('button', { name: 'JPG', exact: true })
  await expect(x4).toBeEnabled()
  await x4.click()
  await jpg.click()
  await expect(page.getByRole('slider', { name: 'JPG quality' })).toBeVisible()
  await page.waitForTimeout(700)
  await page.reload()
  await expect(page.getByRole('button', { name: 'x4', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'JPG', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('dropped files are uploaded as the source', async ({ page }) => {
  await page.goto('/upscale')
  await expect(page.getByRole('textbox', { name: 'Source folder' })).toBeEnabled()
  await page.getByLabel('Upload images').setInputFiles([path.join(FIXTURES, 'a.png'), path.join(FIXTURES, 'b.png')])
  await expect(page.getByRole('textbox', { name: 'Source folder' })).toHaveValue(/\/uploads\/[0-9a-f]+$/)
  await expect(page.getByText('2 images', { exact: true })).toBeVisible()

  // A real drop onto the zone.
  const png = fs.readFileSync(path.join(FIXTURES, 'b.png')).toString('base64')
  // A string: the e2e tsconfig has no DOM types.
  const dataTransfer = await page.evaluateHandle(`(() => {
    const dt = new DataTransfer()
    const bytes = Uint8Array.from(atob('${png}'), (c) => c.charCodeAt(0))
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
    return dt
  })()`)
  await page.getByRole('button', { name: /Drop images here/ }).dispatchEvent('drop', { dataTransfer })
  await expect(page.getByText('1 image', { exact: true })).toBeVisible()
})

test('source picker accepts a read-only folder', async ({ page }) => {
  await page.route('**/api/fs/list?*', (route) =>
    route.fulfill({
      json: { path: '/photos', parent: '/', dirs: [], is_model: false, free_bytes: 0, writable: false },
    }))
  await page.goto('/upscale')
  await expect(page.getByRole('textbox', { name: 'Source folder' })).toBeEnabled()
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  const picker = page.getByRole('dialog', { name: 'Choose the source folder' })
  await picker.getByRole('button', { name: 'Choose this folder' }).click()
  await expect(page.getByRole('textbox', { name: 'Source folder' })).toHaveValue('/photos')
})

test('add custom model sends repo and file', async ({ page }) => {
  const bodies: unknown[] = []
  await page.route('**/api/upscale/models/custom', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({
      json: {
        models: [{ id: 'hf:someone/upscalers/4x-Test.pth', repo_id: 'someone/upscalers', filename: '4x-Test.pth' }],
      },
    })
  })
  await page.goto('/upscale')
  await page.getByRole('button', { name: 'Add custom model…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add an upscale model' })
  await dialog.getByLabel('Repository').fill('someone/upscalers')
  await dialog.getByLabel('File name').fill('4x-Test.pth')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(bodies).toEqual([{ repo_id: 'someone/upscalers', filename: '4x-Test.pth' }])
})

test('device list has no Auto and a saved "auto" runs on the role default', async ({ page, request }) => {
  // A form saved before Auto was hidden.
  await request.put('/api/settings/forms/upscale', { data: { values: { device: 'auto' } } })
  const bodies = await mockRun(page)
  await mockJob(page, [job('done', [])])
  await ready(page)
  const device = page.getByRole('combobox', { name: 'Device' })
  await expect(device).toHaveText('Role default')
  await device.click()
  await expect(page.getByRole('option', { name: 'Role default' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Auto (most memory)' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await upscale(page).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toMatchObject({ device: '' })
})

test('a running job survives leaving the view', async ({ page }) => {
  await mockRun(page)
  await mockJob(page, [job('processing', [result(0)])])
  await ready(page)
  await page.getByRole('button', { name: 'x2', exact: true }).click()
  await upscale(page).click()
  await expect(page.getByTestId('result-card')).toHaveCount(1)
  await expect(upscale(page)).toBeDisabled()

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page).toHaveURL(/\/models$/)
  // Wait until the exit transition has unmounted the view (a quick return would revive it).
  await expect(page.getByTestId('job-progress')).toHaveCount(0)
  await nav.getByRole('link', { name: 'Upscale', exact: true }).click()
  await expect(page).toHaveURL(/\/upscale$/)

  await expect(page.getByTestId('job-progress')).toHaveAttribute('data-state', 'processing')
  await expect(page.getByTestId('result-card')).toHaveCount(1)
  await expect(upscale(page)).toBeDisabled()
})
