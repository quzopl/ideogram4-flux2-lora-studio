import { test as base, expect } from '@playwright/test'

const offline = { status: 502, json: { detail: 'ComfyUI is not reachable from e2e tests.' } }

/**
 * `test` with the first-run onboarding dialog dismissed for the session, so it
 * does not cover the page. Only the onboarding test itself uses the plain one.
 *
 * e2e never contacts ComfyUI (the e2e server points at 127.0.0.1:8188, where a
 * real one may run): every endpoint that would reach it answers here. A test's
 * own `page.route` is registered later, so it wins.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => sessionStorage.setItem('flux.onboarding.dismissed', '1'))
    await page.route('**/api/comfy/loras', (route) => route.fulfill({ json: { loras: [] } }))
    await page.route('**/api/comfy/test', (route) => route.fulfill(offline))
    await page.route(
      (url) => url.pathname === '/api/comfy/object_info',
      (route) => route.fulfill(offline),
    )
    await page.route('**/api/comfy/generate', (route) => route.fulfill(offline))
    await page.route('**/api/comfy/editor/generate', (route) => route.fulfill(offline))
    await page.route('**/api/comfy/job/**', (route) => route.fulfill({ status: 404, json: { detail: 'Unknown job.' } }))
    await page.route('**/api/ideogram/render', (route) => route.fulfill(offline))
    await use(page)
  },
})

export { expect }
