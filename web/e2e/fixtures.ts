import { test as base, expect } from '@playwright/test'

/**
 * `test` with the first-run onboarding dialog dismissed for the session, so it
 * does not cover the page. Only the onboarding test itself uses the plain one.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => sessionStorage.setItem('flux.onboarding.dismissed', '1'))
    // The Bbox render card lists ComfyUI's LoRAs; e2e never contacts ComfyUI (a test's own route wins).
    await page.route('**/api/comfy/loras', (route) => route.fulfill({ json: { loras: [] } }))
    await use(page)
  },
})

export { expect }
