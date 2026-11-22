import { test as plain, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { E2E_WORK } from './env.ts'
import { expect, test } from './fixtures.ts'

// The backend resolves paths, so compare against the real path of the temp dir.
const WORK = fs.realpathSync(E2E_WORK)

// One server for the whole file: onboarding needs the fresh (folderless) state,
// the folder tests then set it.
test.describe.configure({ mode: 'serial' })

const settingsLoaded = (page: Page) =>
  page.waitForResponse((r) => new URL(r.url()).pathname === '/api/settings' && r.request().method() === 'GET')

// Plain test: the fixture would dismiss the dialog this checks.
plain('onboarding when no models folder', async ({ page }) => {
  // Not on the component harness.
  let loaded = settingsLoaded(page)
  await page.goto('/_playground')
  await loaded
  await page.waitForTimeout(300)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.goto('/upscale')
  const dialog = page.getByRole('dialog', { name: 'Where should models be downloaded?' })
  await expect(dialog).toBeVisible()
  // Choose folder opens the picker (closed again here: later tests set the folder).
  await dialog.getByRole('button', { name: 'Choose folder' }).click()
  const picker = page.getByRole('dialog', { name: 'Choose the models folder' })
  await expect(picker.getByText(/ free$/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toBeHidden()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Later' }).click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => sessionStorage.getItem('flux.onboarding.dismissed'))).toBe('1')

  // Stays closed for the rest of the session.
  loaded = settingsLoaded(page)
  await page.reload()
  await loaded
  await page.waitForTimeout(300)
  await expect(dialog).toHaveCount(0)
})

test('models folder survives reload', async ({ page }) => {
  await page.goto('/settings')
  const card = page.getByRole('region', { name: 'Models folder' })
  await card.getByRole('button', { name: 'Choose…' }).click()

  // The picker opens at home; walk to E2E_WORK from the root.
  const picker = page.getByRole('dialog', { name: 'Choose the models folder' })
  const crumbs = picker.getByRole('navigation', { name: 'Path' })
  await expect(picker.getByText(/ free$/)).toBeVisible()
  await crumbs.getByRole('button', { name: '/', exact: true }).click()
  for (const part of WORK.split('/').filter(Boolean)) {
    await expect(crumbs.getByRole('button').last()).toHaveAttribute('aria-current', 'location')
    await picker.getByRole('list').getByRole('button', { name: part, exact: true }).click()
  }
  await expect(crumbs.getByRole('button', { name: path.basename(WORK), exact: true }))
    .toHaveAttribute('aria-current', 'location')

  await picker.getByRole('button', { name: 'New folder' }).click()
  await picker.getByLabel('Folder name').fill('models')
  await picker.getByRole('button', { name: 'Create' }).click()
  await picker.getByRole('list').getByRole('button', { name: 'models', exact: true }).click()
  await expect(picker.getByText(`${WORK}/models`)).toBeVisible()
  await picker.getByRole('button', { name: 'Choose this folder' }).click()

  await expect(page.getByText('Models folder saved')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Models folder' })).toHaveValue(`${WORK}/models`)
})

test('models folder error shows toast', async ({ page }) => {
  await page.goto('/settings')
  const input = page.getByRole('textbox', { name: 'Models folder' })
  await expect(input).toHaveValue(`${WORK}/models`)
  await input.fill('relative/dir')
  await page.getByRole('region', { name: 'Models folder' }).getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Use an absolute path.')).toBeVisible()
})

test('gpu roles listed', async ({ page }) => {
  await page.goto('/settings')
  const gpu = page.getByRole('region', { name: 'GPU', exact: true })
  await expect(gpu.getByRole('combobox')).toHaveCount(3)
  for (const label of ['Captioning (VLM)', 'Florence-2', 'Upscale']) {
    await expect(gpu.getByRole('combobox', { name: label, exact: true })).toBeVisible()
  }

  // No CPU for the VLM; the other roles offer it.
  await gpu.getByRole('combobox', { name: 'Captioning (VLM)' }).click()
  await expect(page.getByRole('option', { name: 'Auto (most memory)' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'CPU' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // A busy server refuses the move with 409; its detail is shown.
  let sent: unknown = null
  await page.route('**/api/gpu/assign', (route) => {
    sent = route.request().postDataJSON()
    return route.fulfill({ status: 409, json: { detail: 'Processing in progress — wait for it to finish.' } })
  })
  await gpu.getByRole('combobox', { name: 'Upscale' }).click()
  await page.getByRole('option', { name: 'CPU' }).click()
  await expect(page.getByText('Processing in progress — wait for it to finish.')).toBeVisible()
  expect(sent).toEqual({ role: 'upscale', device: 'cpu' })
})

test('models table', async ({ page }) => {
  await page.goto('/models')
  const table = page.getByRole('table')
  for (const h of ['Model', 'Kind', 'Status', 'Location']) {
    await expect(table.getByRole('columnheader', { name: h, exact: true })).toBeVisible()
  }
  const missing = table.getByRole('row').filter({ has: page.getByText('missing', { exact: true }) })
  await expect(missing.first()).toBeVisible()
  // Opens the dialog at the models folder; never press its Download (a real download).
  await missing.first().getByRole('button', { name: 'Download…' }).click()
  const dialog = page.getByRole('dialog', { name: /^Download / })
  await expect(dialog.getByTestId('download-dest')).toHaveText(`${WORK}/models`)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})

test('downloading row shows progress and cancels', async ({ page }) => {
  // Pretend the first model is downloading (the page polls this every second).
  let id = ''
  await page.route('**/api/store/models', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    const m = json.models[0]
    id = m.id
    Object.assign(m, {
      status: 'downloading',
      download: {
        id: 'job-e2e', model_id: m.id, label: m.label, dest: `${WORK}/models`, state: 'downloading',
        done_bytes: 512 * 1024 * 1024, total_bytes: 2048 * 1024 * 1024, error: '', path: '',
      },
    })
    await route.fulfill({ response, json })
  })
  let cancelled = ''
  await page.route('**/api/store/downloads/*/cancel', (route) => {
    cancelled = new URL(route.request().url()).pathname
    return route.fulfill({ json: {} })
  })

  await page.goto('/models')
  const row = page.locator('tr[data-model-id]').first()
  await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
  await expect(row.getByText('512 MB / 2.0 GB')).toBeVisible()
  expect(await row.getAttribute('data-model-id')).toBe(id)
  await expect(row.getByRole('button', { name: 'Download…' })).toHaveCount(0)
  await expect(row.getByRole('button', { name: 'Use existing…' })).toHaveCount(0)
  await row.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Download cancelled')).toBeVisible()
  expect(cancelled).toBe('/api/store/downloads/job-e2e/cancel')
})

test('use existing weights, then forget them', async ({ page }) => {
  // The backend only checks a weight file's extension.
  fs.mkdirSync(path.join(WORK, 'weights'), { recursive: true })
  fs.writeFileSync(path.join(WORK, 'weights', 'fake-e2e.pth'), 'not really weights')

  await page.goto('/models')
  const table = page.getByRole('table')
  const row = table.getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'Upscale', exact: true }) })
    .filter({ has: page.getByText('missing', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Use existing…' }) })
    .first()
  await expect(table.getByRole('row').nth(1)).toBeVisible()
  test.skip((await row.count()) === 0, 'no missing upscaler here')
  // Pin the row by id: the filters above stop matching once it changes.
  const id = await row.getAttribute('data-model-id')
  const target = table.locator(`tr[data-model-id="${id}"]`)

  await target.getByRole('button', { name: 'Use existing…' }).click()
  // Starts in the models folder.
  const picker = page.getByRole('dialog', { name: /^Use existing/ })
  await picker.getByRole('list').getByRole('button', { name: '..', exact: true }).click()
  await picker.getByRole('list').getByRole('button', { name: 'weights', exact: true }).click()
  await picker.getByRole('button', { name: 'fake-e2e.pth' }).click()
  await picker.getByRole('button', { name: 'Choose this file' }).click()

  await expect(page.getByText('Model located')).toBeVisible()
  await expect(target.getByText('ready', { exact: true })).toBeVisible()
  await expect(target.getByText(`${WORK}/weights/fake-e2e.pth`)).toBeVisible()

  await target.getByRole('button', { name: 'Forget' }).click()
  const confirm = page.getByRole('dialog', { name: /^Forget/ })
  await expect(confirm.getByText('Files stay on disk.')).toBeVisible()
  await confirm.getByRole('button', { name: 'Forget' }).click()
  await expect(target.getByText('missing', { exact: true })).toBeVisible()
  expect(fs.existsSync(path.join(WORK, 'weights', 'fake-e2e.pth'))).toBe(true)
})

test('hf token is saved but never echoed', async ({ page }) => {
  await page.goto('/settings')
  const card = page.getByRole('region', { name: 'Hugging Face token' })
  await expect(card.getByText('not set')).toBeVisible()
  const input = card.getByLabel('Token', { exact: true })
  await input.fill('hf_e2eFAKEabcd')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Token saved')).toBeVisible()
  await expect(input).toHaveValue('')
  await expect(card.getByText('set …abcd')).toBeVisible()
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
  expect(stored).not.toContain('hf_e2e')

  await card.getByRole('button', { name: 'Clear' }).click()
  await expect(card.getByText('not set')).toBeVisible()
})

test('settings backup', async ({ page }) => {
  await page.goto('/settings')
  const card = page.getByRole('region', { name: 'Backup' })
  await expect(card.getByRole('link', { name: 'Export settings' })).toHaveAttribute('href', '/api/settings/export')

  const file = card.getByLabel('Settings file')
  await file.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('not json') })
  await expect(page.getByText('Not a valid settings file.')).toBeVisible()

  // Importing what was just exported leaves everything as it was.
  const exported = await (await page.request.get('/api/settings/export')).body()
  await file.setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: exported })
  await expect(page.getByText('Settings imported')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Models folder' })).toHaveValue(`${WORK}/models`)
})
