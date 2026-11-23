import { expect, test } from './fixtures.ts'

test('app loads', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('FLUX LoRA Studio')
})

