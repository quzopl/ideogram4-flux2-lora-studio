import { test as base, expect } from '@playwright/test'

/**
 * `test` with the first-run onboarding dialog dismissed for the session, so it
 * does not cover the page. Only the onboarding test itself uses the plain one.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => sessionStorage.setItem('flux.onboarding.dismissed', '1'))
    await use(page)
  },
})

export { expect }
