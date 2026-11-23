import { expect, test } from './fixtures.ts'

test('sidebar navigates', async ({ page }) => {
  await page.goto('/upscale')
  const nav = page.getByRole('navigation', { name: 'Main' })

  const models = nav.getByRole('link', { name: 'Models', exact: true })
  await models.click()
  await expect(page).toHaveURL(/\/models$/)
  await expect(models).toHaveAttribute('aria-current', 'page')

  const settings = nav.getByRole('link', { name: 'Settings', exact: true })
  await settings.click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(settings).toHaveAttribute('aria-current', 'page')
  await expect(models).not.toHaveAttribute('aria-current', 'page')
})

test('deep link works', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
})

test('old /legacy/ link lands in the app', async ({ page }) => {
  await page.goto('/legacy/#upscale')
  await expect(page).not.toHaveURL(/legacy/)
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
})

test('gpu bar renders', async ({ page }) => {
  await page.goto('/upscale')
  await expect(page.getByTestId('gpu-bar')).toBeVisible()
  // Without CUDA the bar says so; with it, it shows at least one card.
  await expect(
    page.getByText('No CUDA GPU').or(page.getByTestId('gpu-card').first()),
  ).toBeVisible({ timeout: 15_000 })
})
