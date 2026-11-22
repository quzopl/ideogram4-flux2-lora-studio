import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import { E2E_WORK } from './env.ts'

// The backend resolves paths, so compare against the real path of the temp dir.
const WORK = fs.realpathSync(E2E_WORK)

test('folder picker creates and picks a folder', async ({ page }) => {
  await page.goto(`/_playground?path=${encodeURIComponent(WORK)}`)
  await page.getByRole('button', { name: 'Pick a folder' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/ free$/)).toBeVisible()
  await dialog.getByRole('button', { name: 'New folder' }).click()
  await dialog.getByLabel('Folder name').fill('picked')
  await dialog.getByRole('button', { name: 'Create' }).click()

  await dialog.getByRole('button', { name: 'picked', exact: true }).click()
  await expect(dialog.getByText(`${WORK}/picked`)).toBeVisible()
  await dialog.getByRole('button', { name: 'Choose this folder' }).click()

  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('picked-path')).toHaveText(`${WORK}/picked`)
})

test('preset roundtrip', async ({ page }) => {
  await page.goto('/_playground')
  const alpha = page.getByLabel('alpha', { exact: true })
  await alpha.fill('alpha')

  await page.getByRole('button', { name: 'Save as…' }).click()
  await page.getByLabel('Preset name').fill('p1')
  await page.getByRole('button', { name: 'Save preset' }).click()
  await expect(page.getByRole('button', { name: 'Presets' })).toHaveText(/p1/)

  await alpha.fill('changed')
  await page.getByRole('button', { name: 'Presets' }).click()
  await page.getByRole('menuitem', { name: 'p1' }).click()
  await expect(alpha).toHaveValue('alpha')

  await page.getByRole('button', { name: 'Delete preset' }).click()
  await page.getByRole('button', { name: 'Presets' }).click()
  await expect(page.getByRole('menuitem', { name: 'p1' })).toHaveCount(0)
  await expect(page.getByText('No presets yet')).toBeVisible()
})

test('form autosaves and comes back after reload', async ({ page }) => {
  await page.goto('/_playground')
  const alpha = page.getByLabel('alpha', { exact: true })
  // Debounced save (500 ms) — wait for the PUT to land before reloading.
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/settings/forms/upscale') && r.request().method() === 'PUT',
  )
  await alpha.fill('kept')
  await saved
  await page.reload()
  await expect(page.getByLabel('alpha', { exact: true })).toHaveValue('kept')
})

test('download dialog needs a folder when none is set', async ({ page }) => {
  await page.goto('/_playground')
  await page.getByRole('combobox', { name: 'Model' }).click()
  const missing = page.getByRole('option').filter({ hasText: /missing$/ })
  test.skip((await missing.count()) === 0, 'every upscale model is already on disk here')
  await missing.first().click()

  await page.getByRole('button', { name: 'Download', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('download-dest')).toHaveText('No folder chosen')
  const download = dialog.getByRole('button', { name: 'Download', exact: true })
  await expect(download).toBeDisabled()

  // Choosing a folder (the picker opens at home) enables it; never click Download here.
  await dialog.getByRole('button', { name: 'Change…' }).click()
  const picker = page.getByRole('dialog', { name: 'Download into…' })
  await picker.getByRole('button', { name: 'Choose this folder' }).click()
  await expect(picker).toBeHidden()
  await expect(dialog.getByTestId('download-dest')).not.toHaveText('No folder chosen')
  await expect(dialog.getByText(/ free$/)).toBeVisible()
  await expect(download).toBeEnabled()
})

test('autosave does not flush a reverted edit on leave', async ({ page }) => {
  await page.goto('/_playground')
  const alpha = page.getByLabel('alpha', { exact: true })
  await expect(alpha).toBeEnabled()
  const original = await alpha.inputValue()

  const bodies: string[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('/api/settings/forms/upscale') && r.method() === 'PUT') bodies.push(r.postData() ?? '')
  })
  await alpha.fill('tmp-edit')
  await alpha.fill(original)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Models', exact: true }).click()
  await page.waitForTimeout(800)
  expect(bodies.filter((b) => b.includes('tmp-edit'))).toEqual([])
})
