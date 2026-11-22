import { expect, test } from '@playwright/test'

test('app loads', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('FLUX LoRA Studio')
})

test('classic UI loads', async ({ page }) => {
  await page.goto('/legacy/')
  await expect(page.getByText('Dataset').first()).toBeVisible()
})
