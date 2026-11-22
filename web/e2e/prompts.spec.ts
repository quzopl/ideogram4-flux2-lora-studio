import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

// The form lives on the server and outlives a test.
test.beforeEach(async ({ request }) => {
  expect((await request.put('/api/settings/forms/prompts', { data: { values: {} } })).ok()).toBe(true)
})

const MODELS = { models: { 'org/one': 'Model One', 'org/two': 'Model Two' }, default: 'org/two' }

const IDEOGRAM = JSON.stringify({
  aspect_ratio: '1:1',
  high_level_description: 'A red apple on a table.',
  compositional_deconstruction: { background: 'A plain grey wall.', elements: [] },
})

interface Job {
  state: string
  current?: string
  error?: string
  result?: { prompt: string; warnings: { level: string; msg: string }[]; library_id: number; format: string } | null
}

/**
 * Mocks the prompt job API: POST answers job "p1" (bodies are collected), GET
 * answers `job()` as it is at the time of the poll.
 */
async function mockJobs(page: Page, job: () => Job) {
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/models', (route) => route.fulfill({ json: MODELS }))
  await page.route('**/api/prompt/jobs', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { job_id: 'p1' } })
  })
  await page.route('**/api/prompt/jobs/*', (route) =>
    route.fulfill({ json: { current: '', error: '', result: null, ...job() } }))
  return bodies
}

const done = (prompt: string, format = 'flux', warnings: { level: string; msg: string }[] = []): Job => ({
  state: 'done',
  result: { prompt, warnings, library_id: 1, format },
})

const input = (page: Page) => page.getByRole('textbox', { name: 'Your prompt', exact: true })
const output = (page: Page) => page.getByRole('textbox', { name: 'Result', exact: true })
const combo = (page: Page, name: string) => page.getByRole('combobox', { name, exact: true })
const generateBtn = (page: Page) => page.getByRole('button', { name: 'Generate prompt', exact: true })
const hint = (page: Page) => page.getByTestId('prompt-hint')

async function pick(page: Page, combobox: string, option: string) {
  await combo(page, combobox).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/** Opens the view, types `text` and generates. */
async function generate(page: Page, text = 'a cat in a hat') {
  await page.goto('/prompts')
  await input(page).fill(text)
  await expect(generateBtn(page)).toBeEnabled()
  await generateBtn(page).click()
}

test('form defaults and visibility', async ({ page }) => {
  await page.route('**/api/models', (route) => route.fulfill({ json: MODELS }))
  await page.goto('/prompts')
  await expect(page.getByRole('heading', { name: 'Prompt studio', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Expand (from a short idea)' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Refine (clean up an existing one)' })).toHaveAttribute('aria-pressed', 'false')
  await expect(combo(page, 'Target format')).toHaveText('FLUX.2 (natural language)')
  await expect(combo(page, 'Subject type')).toHaveText('Auto (detect from the text)')
  await expect(combo(page, 'Quantization')).toHaveText('4-bit (saves VRAM)')
  await expect(combo(page, 'Model')).toHaveText('Model Two')
  await expect(page.getByRole('spinbutton', { name: 'Max length (tokens)' })).toHaveValue('768')
  await expect(hint(page)).toHaveText('Type a short idea and the model will expand it into a full prompt: FLUX.2.')
  await expect(input(page)).toHaveAttribute('placeholder', 'e.g. a woman with red hair in a cafe')
  await expect(combo(page, 'Element count (Ideogram)')).toHaveCount(0)
  await expect(combo(page, 'Description density (Ideogram)')).toHaveCount(0)

  await pick(page, 'Target format', 'Ideogram 4 (JSON)')
  await expect(combo(page, 'Element count (Ideogram)')).toHaveText('Balanced (per framework)')
  await expect(combo(page, 'Description density (Ideogram)')).toHaveText('Balanced')
  await expect(hint(page)).toHaveText(/Ideogram 4 \(JSON\)\.$/)

  await page.getByRole('button', { name: 'Refine (clean up an existing one)' }).click()
  await expect(hint(page)).toHaveText(
    'Paste a longer/existing prompt — the model will clean it up and adapt it to: Ideogram 4 (JSON).')
  await expect(input(page)).toHaveAttribute(
    'placeholder', 'e.g. woman, red hair, cafe, masterpiece, best quality, 8k, detailed')
})

test('preset appends exact text', async ({ page }) => {
  await page.goto('/prompts')
  await input(page).fill('a cat in a hat')
  await pick(page, 'Era…', 'Victorian (1890s)')
  await expect(input(page)).toHaveValue(
    'a cat in a hat\n\nTime travel: keep the exact same composition, framing and element positions, but depict ' +
    'the scene as a period-accurate Victorian (1890s) version — adjust clothing, technology, vehicles, ' +
    'architecture and materials to that era.')
  await expect(combo(page, 'Era…')).toHaveText('Era…')

  await input(page).fill('')
  await pick(page, 'Style…', 'Pixel art')
  await expect(input(page)).toHaveValue(
    'Re-render the scene in this medium/style: Pixel art. Keep the exact same composition and layout; ' +
    'only change the rendering style.')
  await pick(page, 'Genre / mood…', 'Film noir')
  await expect(input(page)).toHaveValue(/only change the rendering style\.\n\nRe-theme the scene as Film noir\. Keep the exact same composition and layout; restyle the content, lighting and mood to match the theme\.$/)
})

test('generate sends the job body', async ({ page }) => {
  const bodies = await mockJobs(page, () => ({ state: 'generating' }))
  await page.goto('/prompts')
  await expect(combo(page, 'Model')).toHaveText('Model Two')
  // An empty prompt is caught at the field and sends nothing.
  await generateBtn(page).click()
  await expect(page.getByText('Type a prompt to process.')).toBeVisible()
  await expect(input(page)).toHaveAttribute('aria-invalid', 'true')
  await page.waitForTimeout(300)
  expect(bodies).toHaveLength(0)

  await input(page).fill('  a cat in a hat  ')
  await expect(page.getByText('Type a prompt to process.')).toHaveCount(0)
  await generateBtn(page).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toEqual({
    text: 'a cat in a hat',
    action: 'expand',
    subject: 'auto',
    caption_format: 'flux',
    model: 'org/two',
    quant: '4bit',
    max_tokens: 768,
    elements_detail: 'balanced',
    desc_detail: 'balanced',
  })
  const progress = page.getByTestId('job-progress')
  await expect(progress).toContainText('Generating…')
  await expect(generateBtn(page)).toBeDisabled()
  const run = JSON.parse((await page.evaluate(() => sessionStorage.getItem('flux.prompts.run'))) ?? 'null')
  expect(run).toMatchObject({ jobId: 'p1', format: 'flux' })
})

test('max length out of range blocks generate', async ({ page }) => {
  const bodies = await mockJobs(page, () => ({ state: 'generating' }))
  await page.goto('/prompts')
  await input(page).fill('a cat')
  const field = page.getByRole('spinbutton', { name: 'Max length (tokens)' })
  await field.fill('20000')
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Enter a whole number from 64 to 8192')).toBeVisible()
  await expect(generateBtn(page)).toBeDisabled()
  await field.fill('')
  await expect(generateBtn(page)).toBeDisabled()
  await field.fill('1024')
  await expect(generateBtn(page)).toBeEnabled()
  await generateBtn(page).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toMatchObject({ max_tokens: 1024 })
})

test('generation survives navigation', async ({ page }) => {
  let finished = false
  let state = 'pending'
  await mockJobs(page, () =>
    finished ? done('A cat wearing a tall hat, studio light.') : state === 'loading_model'
      ? { state, current: 'Downloading Model Two: 40%' }
      : { state })
  await generate(page)
  const progress = page.getByTestId('job-progress')
  await expect(progress).toContainText('Starting…')
  state = 'loading_model'
  await expect(progress).toContainText('Downloading Model Two: 40%')
  state = 'generating'
  await expect(progress).toContainText('Generating…')

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page).toHaveURL(/\/models$/)
  // Wait until the exit transition has unmounted the view (a quick return would revive it).
  await expect(page.getByRole('heading', { name: 'Prompt studio', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('job-progress')).toHaveCount(0)
  await nav.getByRole('link', { name: 'Prompt studio', exact: true }).click()
  await expect(page).toHaveURL(/\/prompts$/)

  await expect(progress).toContainText('Generating…')
  await expect(input(page)).toHaveValue('a cat in a hat')
  await expect(generateBtn(page)).toBeDisabled()
  finished = true
  await expect(output(page)).toHaveValue('A cat wearing a tall hat, studio light.')
  await expect(page.getByTestId('job-progress')).toHaveCount(0)
  await expect(generateBtn(page)).toBeEnabled()
  await expect.poll(async () =>
    JSON.parse((await page.evaluate(() => sessionStorage.getItem('flux.prompts.run'))) ?? 'null')?.jobId).toBeNull()
  // Kept for the tab: a reload shows the result without asking for the job again.
  await page.unroute('**/api/prompt/jobs/*')
  await page.reload()
  await expect(output(page)).toHaveValue('A cat wearing a tall hat, studio light.')
  await page.waitForTimeout(1000)
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
})

test('job error shows first line', async ({ page }) => {
  await mockJobs(page, () => ({
    state: 'error',
    error: 'No models folder chosen — set one in Settings (Models folder).\nTraceback (most recent call last):\n  File "x"',
  }))
  await generate(page)
  const progress = page.getByTestId('job-progress')
  await expect(progress).toHaveAttribute('data-state', 'error')
  await expect(progress).toContainText('No models folder chosen — set one in Settings (Models folder).')
  await expect(progress).not.toContainText('Traceback')
  await expect(page.locator('[title*="Traceback"]')).toHaveCount(1)
  await expect(generateBtn(page)).toBeEnabled()
})

test('an unknown job (404) is forgotten', async ({ page }) => {
  await mockJobs(page, () => ({ state: 'generating' }))
  await page.route('**/api/prompt/jobs/*', (route) => route.fulfill({ status: 404, json: { detail: 'Unknown job.' } }))
  await generate(page)
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'The prompt job is gone (was the server restarted?)' })).toBeVisible()
  await expect(page.getByTestId('job-progress')).toHaveCount(0)
  await expect(generateBtn(page)).toBeEnabled()
})

test('edited result is re-linted', async ({ page }) => {
  await mockJobs(page, () => done(IDEOGRAM, 'ideogram'))
  await generate(page)
  await expect(output(page)).toHaveValue(IDEOGRAM)
  const findings = page.getByTestId('v15-findings')
  await expect(findings).toContainText('✓')
  await expect(findings).toContainText('No warnings — compliant with the v15 guidelines')

  await output(page).fill('not json')
  await page.waitForTimeout(600)
  await expect(findings).toContainText('The prompt is not valid JSON.')
  await expect(findings).toContainText('✕')

  // The edit is kept for the tab.
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Prompt studio', exact: true })).toHaveCount(0)
  await nav.getByRole('link', { name: 'Prompt studio', exact: true }).click()
  await expect(output(page)).toHaveValue('not json')
  await expect(findings).toContainText('The prompt is not valid JSON.')
})

test('a failed re-lint is not shown as compliant', async ({ page }) => {
  await mockJobs(page, () => done(IDEOGRAM, 'ideogram'))
  await generate(page)
  const findings = page.getByTestId('v15-findings')
  await expect(findings).toContainText('No warnings — compliant with the v15 guidelines')
  await page.route('**/api/prompts/lint', (route) => route.fulfill({ status: 500, json: { detail: 'Lint crashed' } }))
  await output(page).fill('not json')
  await expect(page.getByText('Could not check the edited prompt: Lint crashed')).toBeVisible()
  await expect(page.getByText('No warnings — compliant with the v15 guidelines')).toHaveCount(0)
})

test('warnings follow the result format', async ({ page }) => {
  await mockJobs(page, () =>
    done(IDEOGRAM, 'ideogram', [{ level: 'warn', msg: 'high_level_description is empty.' }]))
  await page.goto('/prompts')
  await pick(page, 'Target format', 'Ideogram 4 (JSON)')
  await input(page).fill('an apple')
  await generateBtn(page).click()
  const findings = page.getByTestId('v15-findings')
  await expect(findings).toContainText('!')
  await expect(findings).toContainText('high_level_description is empty.')
  const canvas = page.getByRole('button', { name: 'Edit on canvas', exact: true })
  await expect(canvas).toBeVisible()

  await pick(page, 'Target format', 'FLUX.2 (natural language)')
  await expect(findings).toContainText('high_level_description is empty.')
  await expect(canvas).toBeVisible()
})

test('flux result has no findings or canvas button', async ({ page }) => {
  await mockJobs(page, () => done('A cat.'))
  await generate(page)
  await expect(output(page)).toHaveValue('A cat.')
  await expect(page.getByTestId('v15-findings')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit on canvas', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Regenerate', exact: true })).toBeVisible()
})

test('use as input switches to refine', async ({ page }) => {
  await mockJobs(page, () => done('  A cat wearing a tall hat.  '))
  await generate(page)
  await expect(output(page)).toHaveValue('  A cat wearing a tall hat.  ')
  await page.getByRole('button', { name: 'Use as input', exact: true }).click()
  await expect(input(page)).toHaveValue('A cat wearing a tall hat.')
  await expect(page.getByRole('button', { name: 'Refine (clean up an existing one)' })).toHaveAttribute('aria-pressed', 'true')
  await expect(hint(page)).toHaveText(/^Paste a longer\/existing prompt/)
  await expect(input(page)).toBeFocused()
})

test('form autosaves', async ({ page }) => {
  await page.goto('/prompts')
  const field = page.getByRole('spinbutton', { name: 'Max length (tokens)' })
  await expect(field).toHaveValue('768')
  const saved = page.waitForResponse((r) =>
    r.url().endsWith('/api/settings/forms/prompts') && r.request().method() === 'PUT' &&
    r.request().postDataJSON()?.values?.max_tokens === 2048)
  await field.fill('2048')
  await saved
  await page.reload()
  await expect(field).toHaveValue('2048')
})
