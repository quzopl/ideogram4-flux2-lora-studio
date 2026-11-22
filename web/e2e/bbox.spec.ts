import type { APIRequestContext, Page } from '@playwright/test'
import fs from 'node:fs'
import { expect, test } from './fixtures.ts'

type Bbox = [number, number, number, number]
interface SeedEl {
  type: 'obj' | 'text'
  bbox: Bbox | null
  desc?: string
  text?: string
}
interface Caption {
  aspect_ratio: string
  high_level_description: string
  compositional_deconstruction: { background: string; elements: { type: string; bbox?: Bbox; text?: string; desc: string }[] }
}

/** Starts the page with this draft (re-applied on every load of the page). */
async function seed(page: Page, elements: SeedEl[], selected: number | null = null, aspect_ratio = '1:1') {
  const draft = {
    doc: { aspect_ratio, hld: '', bg: '', elements: elements.map((e) => ({ desc: '', text: '', ...e })) },
    selected,
  }
  await page.addInitScript((d) => sessionStorage.setItem('flux.bbox.draft', d), JSON.stringify(draft))
}

const caption = async (page: Page) => JSON.parse((await page.getByTestId('bbox-json').textContent()) ?? '') as Caption
const bboxOf = async (page: Page, i: number) => (await caption(page)).compositional_deconstruction.elements[i].bbox!
const frame = (page: Page) => page.getByTestId('bbox-frame')
const box = (page: Page, i: number) => page.locator(`[data-testid="bbox-box"][data-index="${i}"]`)
const selectedBox = (page: Page) => page.locator('[data-testid="bbox-box"][data-selected="true"]')

/** The frame's rect once its size has settled (it animates on a ratio change). */
async function frameRect(page: Page, ratio?: number) {
  if (ratio) {
    await expect.poll(async () => {
      const b = (await frame(page).boundingBox())!
      return Math.abs(b.width / b.height - ratio)
    }).toBeLessThan(0.01)
  }
  await frame(page).hover()
  const b = (await frame(page).boundingBox())!
  // page.mouse needs the whole frame in the viewport.
  const vp = page.viewportSize()!
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height)
  return b
}

async function drag(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 6 })
  await page.mouse.up()
}

async function dragHandle(page: Page, h: string, dx: number, dy: number) {
  const handle = page.locator(`[data-h="${h}"]`)
  await handle.hover()
  const b = (await handle.boundingBox())!
  await drag(page, b.x + b.width / 2, b.y + b.height / 2, dx, dy)
}

async function dragBox(page: Page, i: number, dx: number, dy: number) {
  await box(page, i).hover()
  const b = (await box(page, i).boundingBox())!
  await drag(page, b.x + b.width / 2, b.y + b.height / 2, dx, dy)
}

// The From image form lives on the server and outlives a test.
test.beforeEach(async ({ request }) => {
  expect((await request.put('/api/settings/forms/bbox', { data: { values: {} } })).ok()).toBe(true)
})

const valid = ([y1, x1, y2, x2]: Bbox) =>
  [y1, x1, y2, x2].every((v) => Number.isInteger(v) && v >= 0 && v <= 1000) && y1 < y2 && x1 < x2

test('new canvas has one obj with the default box', async ({ page }) => {
  await page.goto('/bbox')
  await expect(page.getByRole('heading', { name: 'Bbox editor', exact: true })).toBeVisible()
  const c = await caption(page)
  expect(c).toEqual({
    aspect_ratio: '1:1',
    high_level_description: '',
    compositional_deconstruction: { background: '', elements: [{ type: 'obj', bbox: [60, 300, 1000, 700], desc: '' }] },
  })
  // buildCaption's key order; the client-only key never reaches the JSON.
  expect(Object.keys(c)).toEqual(['aspect_ratio', 'high_level_description', 'compositional_deconstruction'])
  await expect(page.getByTestId('bbox-json')).not.toContainText('"key"')
  await expect(page.locator('[data-testid="bbox-box"]')).toHaveCount(1)
  await expect(box(page, 0)).toContainText('obj #1')

  await page.getByRole('button', { name: '+ text', exact: true }).click()
  const els = (await caption(page)).compositional_deconstruction.elements
  expect(els[1]).toEqual({ type: 'text', bbox: [120, 250, 260, 750], text: '', desc: '' })
  expect(Object.keys(els[1])).toEqual(['type', 'bbox', 'text', 'desc'])
  // The new element is selected and on top.
  await expect(selectedBox(page)).toHaveAttribute('data-index', '1')
  await expect(box(page, 1)).toContainText('text: …')
})

test('drag and resize update the bbox', async ({ page }) => {
  await seed(page, [{ type: 'obj', bbox: [200, 200, 500, 500] }])
  await page.goto('/bbox')
  const f = await frameRect(page, 1)
  await dragBox(page, 0, f.width * 0.1, 0)
  await expect.poll(async () => (await bboxOf(page, 0))[1]).toBeGreaterThan(290)
  const [y1, x1, y2, x2] = await bboxOf(page, 0)
  expect(Math.abs(x1 - 300)).toBeLessThanOrEqual(2)
  expect(Math.abs(x2 - 600)).toBeLessThanOrEqual(2)
  expect([y1, y2]).toEqual([200, 500])
  // The drag selected it, so it has handles.
  await expect(selectedBox(page)).toHaveAttribute('data-index', '0')
  await expect(page.locator('[data-h]')).toHaveCount(8)

  await dragHandle(page, 'se', 40, 50)
  await expect.poll(async () => (await bboxOf(page, 0))[2]).toBeGreaterThan(y2 + 20)
  const after = await bboxOf(page, 0)
  expect(after[3]).toBeGreaterThan(x2 + 20)
  expect(after.slice(0, 2)).toEqual([y1, x1])
})

for (const [ratio, r] of [['3:1', 3], ['9:16', 9 / 16]] as const) {
  test(`bbox stays in range at extreme ratios (${ratio})`, async ({ page }) => {
    await seed(page, [{ type: 'obj', bbox: [300, 300, 600, 600] }])
    await page.goto('/bbox')
    await page.getByRole('button', { name: ratio, exact: true }).click()
    await expect(page.getByRole('button', { name: ratio, exact: true })).toHaveAttribute('aria-pressed', 'true')
    await frameRect(page, r)

    await dragBox(page, 0, 3000, 3000)
    await expect.poll(async () => (await bboxOf(page, 0))[3]).toBe(1000)
    let b = await bboxOf(page, 0)
    expect(valid(b)).toBe(true)
    expect(b).toEqual([700, 700, 1000, 1000])

    await dragBox(page, 0, -3000, -3000)
    await expect.poll(async () => (await bboxOf(page, 0))[0]).toBe(0)
    expect(await bboxOf(page, 0)).toEqual([0, 0, 300, 300])

    // Handles dragged far out stop at the frame; dragged across stop at the minimum.
    await dragHandle(page, 'se', 3000, 3000)
    await expect.poll(async () => (await bboxOf(page, 0))[2]).toBe(1000)
    b = await bboxOf(page, 0)
    expect(b).toEqual([0, 0, 1000, 1000])
    await dragHandle(page, 'nw', 3000, 3000)
    await expect.poll(async () => (await bboxOf(page, 0))[0]).toBeGreaterThan(900)
    b = await bboxOf(page, 0)
    expect(valid(b)).toBe(true)
    expect(b.slice(2)).toEqual([1000, 1000])
  })
}

test('overlap cycling on click, not on drag', async ({ page }) => {
  // The small box is below the big one in z-order: the smaller still wins.
  await seed(page, [
    { type: 'obj', bbox: [400, 400, 600, 600] },
    { type: 'obj', bbox: [100, 100, 900, 900] },
  ])
  await page.goto('/bbox')
  const f = await frameRect(page, 1)
  const cx = f.x + f.width / 2
  const cy = f.y + f.height / 2
  await expect(selectedBox(page)).toHaveCount(0)

  // The press that selects does not cycle on its release.
  await page.mouse.click(cx, cy)
  await expect(selectedBox(page)).toHaveAttribute('data-index', '0')
  await page.mouse.click(cx, cy)
  await expect(selectedBox(page)).toHaveAttribute('data-index', '1')
  await page.mouse.click(cx, cy)
  await expect(selectedBox(page)).toHaveAttribute('data-index', '0')
  await page.mouse.click(cx, cy)
  await expect(selectedBox(page)).toHaveAttribute('data-index', '1')

  // A drag that starts inside the small box moves the selected big one.
  await drag(page, cx, cy, f.width * 0.1, 0)
  await expect.poll(async () => (await bboxOf(page, 1))[1]).toBeGreaterThan(190)
  const big = await bboxOf(page, 1)
  expect(Math.abs(big[1] - 200)).toBeLessThanOrEqual(2)
  expect(Math.abs(big[3] - 1000)).toBeLessThanOrEqual(2)
  expect(await bboxOf(page, 0)).toEqual([400, 400, 600, 600])
  await expect(selectedBox(page)).toHaveAttribute('data-index', '1')

  // Empty space deselects.
  await page.mouse.click(f.x + 5, f.y + 5)
  await expect(selectedBox(page)).toHaveCount(0)
})

test('keyboard nudge and delete', async ({ page }) => {
  await seed(page, [{ type: 'obj', bbox: [200, 200, 500, 500] }, { type: 'text', bbox: [700, 700, 800, 800], text: 'HI' }], 0)
  await page.goto('/bbox')
  await expect(box(page, 1)).toContainText('text: HI')
  await box(page, 0).hover()
  await box(page, 0).click()
  await expect(selectedBox(page)).toHaveAttribute('data-index', '0')
  await expect(frame(page)).toBeFocused()

  await page.keyboard.press('ArrowRight')
  await expect.poll(() => bboxOf(page, 0)).toEqual([200, 201, 500, 501])
  await page.keyboard.press('Shift+ArrowDown')
  await expect.poll(() => bboxOf(page, 0)).toEqual([210, 201, 510, 501])
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => bboxOf(page, 0)).toEqual([209, 191, 509, 491])
  // Shortcuts leave modified keys to the browser.
  await page.keyboard.press('Control+ArrowRight')
  await page.keyboard.press('Alt+ArrowDown')
  await page.keyboard.press('Control+Delete')
  await page.waitForTimeout(100)
  expect(await bboxOf(page, 0)).toEqual([209, 191, 509, 491])
  expect((await caption(page)).compositional_deconstruction.elements).toHaveLength(2)

  // Escape during a drag does not drop the dragged box's selection.
  const b0 = (await box(page, 0).boundingBox())!
  await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2)
  await page.mouse.down()
  await page.mouse.move(b0.x + b0.width / 2 + 20, b0.y + b0.height / 2, { steps: 4 })
  await page.keyboard.press('Escape')
  await expect(selectedBox(page)).toHaveAttribute('data-index', '0')
  await page.mouse.move(b0.x + b0.width / 2 + 30, b0.y + b0.height / 2, { steps: 2 })
  await page.mouse.up()
  await expect(selectedBox(page)).toHaveAttribute('data-index', '0')

  // Escape deselects; the keys then do nothing.
  await page.keyboard.press('Escape')
  await expect(selectedBox(page)).toHaveCount(0)
  await expect(page.locator('[data-h]')).toHaveCount(0)
  const kept = await bboxOf(page, 0)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Delete')
  expect(await bboxOf(page, 0)).toEqual(kept)
  expect((await caption(page)).compositional_deconstruction.elements).toHaveLength(2)

  await box(page, 0).click()
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await caption(page)).compositional_deconstruction.elements.map((e) => e.type)).toEqual(['text'])
  await expect(selectedBox(page)).toHaveCount(0)
  await box(page, 0).click()
  await page.keyboard.press('Backspace')
  await expect.poll(async () => (await caption(page)).compositional_deconstruction.elements).toEqual([])
  await expect(frame(page).getByText('Add an element with + obj or + text.', { exact: true })).toBeVisible()
})

test('draft survives navigation', async ({ page }) => {
  await page.goto('/bbox')
  await page.getByRole('button', { name: '4:5', exact: true }).click()
  await page.getByRole('button', { name: '+ text', exact: true }).click()
  await frameRect(page, 4 / 5)
  await frame(page).focus()
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(async () => (await bboxOf(page, 1))[1]).toBe(260)
  const before = await page.getByTestId('bbox-json').textContent()

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page).toHaveURL(/\/models$/)
  // Wait until the exit transition has unmounted the view (a quick return would revive it).
  await expect(page.getByTestId('bbox-json')).toHaveCount(0)
  await nav.getByRole('link', { name: 'Bbox editor', exact: true }).click()
  await expect(page.getByTestId('bbox-json')).toHaveText(before!)
  await expect(selectedBox(page)).toHaveAttribute('data-index', '1')

  // And a reload (the draft is in sessionStorage).
  await page.reload()
  await expect(page.getByTestId('bbox-json')).toHaveText(before!)
  await expect(page.getByRole('button', { name: '4:5', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('custom ratio', async ({ page }) => {
  await page.goto('/bbox')
  const custom = page.getByRole('textbox', { name: 'Custom aspect ratio (W:H)' })
  await expect(custom).toHaveValue('1:1')
  await custom.fill('21:9')
  await custom.press('Enter')
  await frameRect(page, 21 / 9)
  expect((await caption(page)).aspect_ratio).toBe('21:9')
  await expect(page.getByRole('group', { name: 'Aspect ratio' }).locator('[aria-pressed="true"]')).toHaveCount(0)

  await custom.fill('abc')
  await custom.press('Enter')
  await expect(custom).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Use W:H with whole numbers above 0, e.g. 21:9')).toBeVisible()
  expect((await caption(page)).aspect_ratio).toBe('21:9')
  await custom.fill('0:5')
  await custom.press('Enter')
  await expect(custom).toHaveAttribute('aria-invalid', 'true')

  // Blur applies too; a preset clears the error and writes itself into the field.
  await custom.fill('4:5')
  await page.getByRole('heading', { name: 'Bbox editor', exact: true }).click()
  await expect.poll(async () => (await caption(page)).aspect_ratio).toBe('4:5')
  await expect(custom).not.toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('button', { name: '4:5', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '16:9', exact: true }).click()
  await expect(custom).toHaveValue('16:9')
  // Even the active preset resets a bad entry.
  await custom.fill('abc')
  await custom.press('Enter')
  await expect(custom).toHaveAttribute('aria-invalid', 'true')
  await page.getByRole('button', { name: '16:9', exact: true }).click()
  await expect(custom).toHaveValue('16:9')
  await expect(custom).not.toHaveAttribute('aria-invalid', 'true')
})

const card = (page: Page, i: number) => page.locator(`[data-testid="bbox-card"][data-index="${i}"]`)
const cards = (page: Page) => page.getByTestId('bbox-card')
const findings = (page: Page) => page.getByTestId('v15-findings')
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
const pasteBar = (page: Page) => page.getByRole('textbox', { name: 'Prompt JSON', exact: true })

/** Opens the Paste JSON bar, loads `text`. */
async function paste(page: Page, text: string) {
  if (!(await pasteBar(page).isVisible())) await page.getByRole('button', { name: 'Paste JSON', exact: true }).click()
  await pasteBar(page).fill(text)
  await page.getByRole('button', { name: 'Load', exact: true }).click()
}

const LEGACY_WARNING =
  'Loaded the OLD format with style_description — those fields do not exist in v15 and were dropped; rewrite the style as prose into the HLD or background.'

test('cards edit desc and counters', async ({ page }) => {
  await page.goto('/bbox')
  const c = card(page, 0)
  await expect(c).toContainText('obj #1')
  await expect(c).toContainText('bbox [60, 300, 1000, 700]')
  await expect(c).toHaveAttribute('data-selected', 'true')

  const desc = c.getByRole('textbox', { name: 'desc', exact: true })
  const counter = c.getByTestId('desc-counter')
  await expect(counter).toHaveText('0/60 words')
  await desc.fill(words(61))
  await expect(counter).toHaveText('61/60 words')
  await expect(counter).toHaveClass(/text-warning/)
  // The server's message, numbered by array index.
  await expect(findings(page)).toContainText('(obj #1) desc exceeds 60 words (61).')
  expect((await caption(page)).compositional_deconstruction.elements[0].desc).toBe(words(61))

  // Typing does not remount the card: focus stays.
  await desc.press('End')
  await desc.pressSequentially(' x y')
  await expect(desc).toBeFocused()
  await expect(counter).toHaveText('63/60 words')

  const hld = page.getByRole('textbox', { name: 'high_level_description', exact: true })
  await hld.fill(words(51))
  await expect(page.getByTestId('hld-counter')).toHaveText('51/50 words')
  await expect(page.getByTestId('hld-counter')).toHaveClass(/text-warning/)
  await expect(findings(page)).toContainText('HLD exceeds 50 words (51).')
  await page.getByRole('textbox', { name: 'background (scene shell only)', exact: true }).fill('A grey wall.')
  await expect.poll(async () => (await caption(page)).compositional_deconstruction.background).toBe('A grey wall.')

  // A text element: its verbatim text is on the card and the canvas tag.
  await page.getByRole('button', { name: '+ text', exact: true }).click()
  await expect(card(page, 1)).toContainText('text #2')
  await expect(card(page, 1)).toHaveAttribute('data-selected', 'true')
  const text = card(page, 1).getByRole('textbox', { name: 'text (verbatim, \\n = new line)', exact: true })
  await text.pressSequentially('HELLO')
  await expect(text).toBeFocused()
  await expect(box(page, 1)).toContainText('text: HELLO')
  expect((await caption(page)).compositional_deconstruction.elements[1].text).toBe('HELLO')

  // A card click selects; a canvas selection marks the card.
  await card(page, 0).getByText('obj #1').click()
  await expect(selectedBox(page)).toHaveAttribute('data-index', '0')
  await box(page, 1).click({ position: { x: 5, y: 5 } })
  await expect(card(page, 1)).toHaveAttribute('data-selected', 'true')
  await expect(card(page, 0)).not.toHaveAttribute('data-selected', 'true')

  // The aspect ratio field applies on Enter.
  const ar = page.getByRole('textbox', { name: 'aspect_ratio', exact: true })
  await ar.fill('4:5')
  await expect(ar).toBeFocused()
  expect((await caption(page)).aspect_ratio).toBe('1:1')
  await ar.press('Enter')
  await expect.poll(async () => (await caption(page)).aspect_ratio).toBe('4:5')
  await expect(page.getByRole('button', { name: '4:5', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('lint failure shows an error row, not old findings', async ({ page }) => {
  await page.goto('/bbox')
  await expect(findings(page)).toContainText('high_level_description is empty.')
  await page.route('**/api/prompts/lint', (route) => route.fulfill({ status: 500, json: { detail: 'Lint crashed' } }))
  await page.getByRole('textbox', { name: 'high_level_description', exact: true }).fill('A cat.')
  await expect(page.getByText('Could not check the prompt: Lint crashed')).toBeVisible()
  await expect(findings(page)).toHaveCount(0)
})

test('z-order buttons reorder the array', async ({ page }) => {
  await seed(page, [
    { type: 'obj', bbox: [100, 100, 300, 300], desc: 'A' },
    { type: 'text', bbox: [400, 400, 500, 500], desc: 'B', text: 'T' },
    { type: 'obj', bbox: [600, 600, 900, 900], desc: 'C' },
  ], 0)
  await page.goto('/bbox')
  const descs = async () => (await caption(page)).compositional_deconstruction.elements.map((e) => e.desc)
  await expect(cards(page)).toHaveCount(3)
  await expect(card(page, 0).getByRole('button', { name: 'Send backward', exact: true })).toBeDisabled()
  await expect(card(page, 2).getByRole('button', { name: 'Bring forward', exact: true })).toBeDisabled()

  await card(page, 0).getByRole('button', { name: 'Bring forward', exact: true }).click()
  await expect.poll(descs).toEqual(['B', 'A', 'C'])
  // Cards follow the array; the selection follows its element.
  await expect(card(page, 0)).toContainText('text #1')
  await expect(card(page, 1)).toContainText('obj #2')
  await expect(card(page, 1)).toHaveAttribute('data-selected', 'true')
  await expect(selectedBox(page)).toHaveAttribute('data-index', '1')

  await card(page, 2).getByRole('button', { name: 'Send backward', exact: true }).click()
  await expect.poll(descs).toEqual(['B', 'C', 'A'])
  await expect(card(page, 2)).toHaveAttribute('data-selected', 'true')

  await card(page, 1).getByRole('button', { name: 'Remove element', exact: true }).click()
  await expect.poll(descs).toEqual(['B', 'A'])
  await expect(cards(page)).toHaveCount(2)
})

test('bbox checkbox omits the key', async ({ page }) => {
  await page.goto('/bbox')
  await frame(page).focus()
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => bboxOf(page, 0)).toEqual([60, 310, 1000, 710])
  const check = card(page, 0).getByRole('checkbox', { name: 'bbox', exact: true })
  await expect(check).toBeChecked()

  await check.uncheck()
  await expect.poll(async () => Object.keys((await caption(page)).compositional_deconstruction.elements[0])).toEqual(['type', 'desc'])
  await expect(card(page, 0)).toContainText('no bbox')
  await expect(page.getByTestId('bbox-box')).toHaveCount(0)

  // The last box is kept (even over a reload) and comes back.
  await page.reload()
  await expect(card(page, 0)).toContainText('no bbox')
  await card(page, 0).getByRole('checkbox', { name: 'bbox', exact: true }).check()
  await expect.poll(() => bboxOf(page, 0)).toEqual([60, 310, 1000, 710])
  await expect(card(page, 0)).toContainText('bbox [60, 310, 1000, 710]')
  await expect(page.getByTestId('bbox-box')).toHaveCount(1)
})

const FOX = {
  aspect_ratio: '16:9',
  high_level_description: 'A red fox in fresh snow.',
  compositional_deconstruction: {
    background: 'A snowy field under a pale sky.',
    elements: [
      { type: 'obj', bbox: [100, 200, 900, 600], desc: 'A red fox standing alert.' },
      { type: 'text', bbox: [50, 650, 200, 950], text: 'WINTER', desc: 'Bold white letters.' },
      { type: 'obj', desc: 'A distant pine tree.' },
    ],
  },
}

test('paste double-encoded loads', async ({ page }) => {
  await page.goto('/bbox')
  await paste(page, JSON.stringify(JSON.stringify(FOX)))
  await expect(pasteBar(page)).toHaveCount(0)
  expect(await caption(page)).toEqual(FOX)
  await expect(page.getByRole('button', { name: '16:9', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // The first element is selected.
  await expect(selectedBox(page)).toHaveAttribute('data-index', '0')
  await expect(card(page, 0)).toHaveAttribute('data-selected', 'true')
  // An element that never had a box gets the default one of the ratio.
  await expect(card(page, 2)).toContainText('no bbox')
  await card(page, 2).getByRole('checkbox', { name: 'bbox', exact: true }).check()
  await expect.poll(() => bboxOf(page, 2)).toEqual([80, 400, 1000, 620])

  // Over a non-default canvas, it asks first; the text stays in the bar.
  const legacy = {
    aspect_ratio: '1:1',
    high_level_description: 'An old style prompt.',
    style_description: { lighting: 'soft window light' },
    compositional_deconstruction: { background: 'A grey wall.', elements: [] },
  }
  await paste(page, JSON.stringify(legacy))
  const dialog = page.getByRole('dialog', { name: 'Replace the current canvas?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect((await caption(page)).high_level_description).toBe(FOX.high_level_description)
  await expect(pasteBar(page)).toHaveValue(JSON.stringify(legacy))

  await page.getByRole('button', { name: 'Load', exact: true }).click()
  await dialog.getByRole('button', { name: 'Replace', exact: true }).click()
  await expect.poll(async () => (await caption(page)).high_level_description).toBe('An old style prompt.')
  expect(await page.getByTestId('bbox-json').textContent()).not.toContain('style_description')
  await expect(page.getByText(LEGACY_WARNING)).toBeVisible()
  await expect(pasteBar(page)).toHaveCount(0)
})

test('paste garbage keeps the canvas', async ({ page }) => {
  await page.goto('/bbox')
  await page.getByRole('textbox', { name: 'high_level_description', exact: true }).fill('Keep me.')
  await expect.poll(async () => (await caption(page)).high_level_description).toBe('Keep me.')
  const before = await page.getByTestId('bbox-json').textContent()

  await paste(page, 'hello')
  await expect(page.getByText('No JSON object found in the pasted text.')).toBeVisible()
  await expect(pasteBar(page)).toBeVisible()
  await paste(page, '{"a": 1}')
  await expect(page.getByText('No Ideogram prompt found in the JSON.')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('bbox-json')).toHaveText(before!)

  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(pasteBar(page)).toHaveCount(0)
  await expect(page.getByTestId('bbox-json')).toHaveText(before!)
})

test('save to library and it appears in the prompt studio library', async ({ page }) => {
  const m = `marker-bboxsave-${Date.now()}`
  await page.goto('/bbox')
  await card(page, 0).getByRole('textbox', { name: 'desc', exact: true }).fill(`A ${m} lamp.`)
  await page.getByRole('button', { name: 'Save to library', exact: true }).click()
  await expect(page.getByText(/^Saved to the library \(#\d+\)\.$/)).toBeVisible()

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Prompt studio', exact: true }).click()
  await expect(page.getByTestId('bbox-json')).toHaveCount(0)
  const row = page.getByRole('region', { name: 'Prompt library', exact: true }).getByTestId('library-row').filter({ hasText: m })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('bbox editor')
})

test('download is minified caption_v15.json', async ({ page }) => {
  await seed(page, [{ type: 'text', bbox: [100, 100, 200, 900], text: 'SALE', desc: 'Red letters.' }], 0, '4:5')
  await page.goto('/bbox')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download', exact: true }).click()
  const d = await download
  expect(d.suggestedFilename()).toBe('caption_v15.json')
  const body = fs.readFileSync(await d.path(), 'utf8')
  expect(body).toBe(JSON.stringify(await caption(page)))
  expect(body).not.toContain('\n')
})

test('copy minified and pretty', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/bbox')
  await page.getByRole('button', { name: 'Copy (minified)', exact: true }).click()
  await expect(page.getByText('Copied to clipboard.').first()).toBeVisible()
  const pretty = (await page.getByTestId('bbox-json').textContent())!
  expect(await page.evaluate(() => (navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard.readText())).toBe(JSON.stringify(JSON.parse(pretty)))
  await page.getByRole('button', { name: 'Pretty', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard.readText())).toBe(pretty)
})

test('handoff with bad JSON keeps the canvas', async ({ page }) => {
  await page.goto('/models')
  await page.evaluate(() => sessionStorage.setItem('flux.bbox.handoff', 'hello'))
  await page.goto('/bbox')
  await expect(page.getByText('No JSON object found in the pasted text.')).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('flux.bbox.handoff'))).toBeNull()
  expect((await caption(page)).compositional_deconstruction.elements).toHaveLength(1)
  expect((await caption(page)).high_level_description).toBe('')
})

test('nudge then immediate reload keeps the box', async ({ page }) => {
  await page.goto('/bbox')
  await frame(page).focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => bboxOf(page, 0)).toEqual([60, 301, 1000, 701])
  await page.reload()
  expect(await bboxOf(page, 0)).toEqual([60, 301, 1000, 701])
})

test('resize keeps an interior anchor on a large frame', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1400 })
  await seed(page, [{ type: 'obj', bbox: [300, 300, 600, 600] }], 0, '3:1')
  await page.goto('/bbox')
  const f = await frameRect(page, 3)
  // Above 800 px a 8 px minimum is under 10 units: the anchored edge used to drift.
  expect(f.width).toBeGreaterThan(1000)
  await dragHandle(page, 'w', 3000, 0)
  await expect.poll(async () => (await bboxOf(page, 0))[1]).toBeGreaterThan(550)
  const [y1, x1, y2, x2] = await bboxOf(page, 0)
  expect([y1, y2, x2]).toEqual([300, 600, 600])
  expect(x2 - x1).toBeGreaterThanOrEqual(10)
  await dragHandle(page, 'e', -3000, 0)
  await expect.poll(async () => (await bboxOf(page, 0))[3]).toBeLessThan(620)
  const b = await bboxOf(page, 0)
  expect(b[1]).toBe(x1)
  expect(b[3] - b[1]).toBeGreaterThanOrEqual(10)
})

// ---- From image (the analyze job is mocked: e2e never runs Florence or a VLM) ----

const MODELS = { models: { 'org/one': 'Model One', 'org/two': 'Model Two' }, default: 'org/two' }
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const FLORENCE = 'florence-community/Florence-2-base-ft'

const DRAFT: Caption = {
  aspect_ratio: '4:5',
  high_level_description: 'A cat asleep on a sofa.',
  compositional_deconstruction: {
    background: 'A warm living room.',
    elements: [
      { type: 'obj', bbox: [100, 100, 800, 700], desc: 'cat' },
      { type: 'text', bbox: [850, 100, 950, 600], text: 'HOME', desc: 'text "HOME"' },
    ],
  },
}

interface AnalyzeJob {
  state: string
  current?: string
  error?: string
  result?: { json: string; elements: number; model: string; warnings: { level: string; msg: string }[] } | null
}

const analyzed = (model = FLORENCE): AnalyzeJob => ({
  state: 'done',
  result: { json: JSON.stringify(DRAFT), elements: 2, model, warnings: [] },
})

/** A multipart body's fields: name -> value (a file part -> its file name). */
function formFields(body: string) {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?[^]*?\r\n\r\n([^]*?)\r\n--/g)) {
    out[m[1]] = m[2] ?? m[3]
  }
  return out
}

/**
 * Mocks the analyze job API: each POST answers a new job ("a1", "a2", …; its
 * multipart fields are collected), GET answers `job(id)` as it is at the time of the poll.
 */
async function mockAnalyze(page: Page, job: (id: string) => AnalyzeJob) {
  const bodies: Record<string, string>[] = []
  await page.route('**/api/models', (route) => route.fulfill({ json: MODELS }))
  await page.route('**/api/ideogram/analyze/jobs', (route) => {
    bodies.push(formFields(route.request().postData() ?? ''))
    return route.fulfill({ json: { job_id: `a${bodies.length}` } })
  })
  await page.route('**/api/ideogram/analyze/jobs/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? ''
    return route.fulfill({ json: { current: '', error: '', result: null, ...job(id) } })
  })
  return bodies
}

const fromImage = (page: Page) => page.getByRole('button', { name: 'From image', exact: true })
const combo = (page: Page, name: string) => page.getByRole('combobox', { name, exact: true })
const maxLength = (page: Page) => page.getByRole('spinbutton', { name: 'Max length (tokens)', exact: true })
const photo = (page: Page) => page.getByRole('img', { name: 'Reference photo', exact: true })
const hld = (page: Page) => page.getByRole('textbox', { name: 'high_level_description', exact: true })
const analyzeRun = async (page: Page) =>
  JSON.parse((await page.evaluate(() => sessionStorage.getItem('flux.bbox.analyze'))) ?? 'null') as
    { jobId: string | null; applied: boolean; error: string } | null

async function pick(page: Page, combobox: string, option: string) {
  await combo(page, combobox).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/** Picks a photo through the From image button. */
async function pickPhoto(page: Page, name = 'ref.png') {
  const chooser = page.waitForEvent('filechooser')
  await fromImage(page).click()
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: PNG })
}

/** Drops a file of this MIME type on the canvas. */
async function dropPhoto(page: Page, name: string, type: string) {
  const dt = await page.evaluateHandle(([n, t]) => {
    // A browser object (the e2e tsconfig has no DOM lib).
    const DT = (globalThis as unknown as { DataTransfer: new () => { items: { add(f: File): void } } }).DataTransfer
    const d = new DT()
    d.items.add(new File([new Uint8Array([1, 2, 3])], n, { type: t }))
    return d
  }, [name, type])
  const host = page.getByTestId('bbox-drop')
  await host.dispatchEvent('dragover', { dataTransfer: dt })
  await host.dispatchEvent('drop', { dataTransfer: dt })
}

/** Leaves for Models and waits until the view has unmounted. */
async function leaveAndReturn(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page).toHaveURL(/\/models$/)
  await expect(page.getByTestId('bbox-json')).toHaveCount(0)
  await nav.getByRole('link', { name: 'Bbox editor', exact: true }).click()
  await expect(page.getByTestId('bbox-json')).toBeVisible()
}

test('florence draft loads into an untouched canvas', async ({ page }) => {
  let state = 'analyzing'
  const bodies = await mockAnalyze(page, () => (state === 'done' ? analyzed() : { state }))
  await page.goto('/bbox')
  await expect(page.locator('input[type="file"]')).toHaveAttribute('accept', 'image/*,.heic,.heif')
  await pickPhoto(page)

  const progress = page.getByTestId('job-progress')
  await expect(progress).toContainText('Analyzing…')
  await expect(photo(page)).toHaveAttribute('src', /^blob:/)
  await expect(fromImage(page)).toBeDisabled()
  expect(bodies).toEqual([{ file: 'ref.png', engine: 'florence' }])

  state = 'done'
  await expect.poll(() => caption(page)).toEqual(DRAFT)
  await expect(page.getByText(`Draft ready: 2 elements (${FLORENCE}).`)).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(selectedBox(page)).toHaveAttribute('data-index', '0')
  await expect(progress).toHaveCount(0)
  await expect(photo(page)).toHaveCount(0)
  await expect(fromImage(page)).toBeEnabled()
  expect(await analyzeRun(page)).toMatchObject({ jobId: null, applied: true })
})

test('replacing an edited canvas asks first', async ({ page }) => {
  const bodies = await mockAnalyze(page, () => analyzed())
  await page.goto('/bbox')
  await hld(page).fill('Keep me.')
  await expect.poll(async () => (await caption(page)).high_level_description).toBe('Keep me.')

  // A non-image drop sends nothing; a file with no MIME type but an image extension is taken.
  await dropPhoto(page, 'notes.txt', 'text/plain')
  await dropPhoto(page, 'photo.heic', '')
  const dialog = page.getByRole('dialog', { name: 'Replace the current canvas with the image draft?' })
  await expect(dialog).toBeVisible()
  expect(bodies).toEqual([{ file: 'photo.heic', engine: 'florence' }])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect((await caption(page)).high_level_description).toBe('Keep me.')

  // Refused once: coming back does not ask again, the draft waits behind Load draft.
  const loadDraft = page.getByRole('button', { name: 'Load draft', exact: true })
  await expect(loadDraft).toBeVisible()
  await leaveAndReturn(page)
  await expect(loadDraft).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await caption(page)).high_level_description).toBe('Keep me.')

  await loadDraft.click()
  await dialog.getByRole('button', { name: 'Replace', exact: true }).click()
  await expect.poll(() => caption(page)).toEqual(DRAFT)
  await expect(page.getByText(`Draft ready: 2 elements (${FLORENCE}).`)).toBeVisible()
})

test('vlm fields only for hybrid and vlm', async ({ page, request }) => {
  const bodies = await mockAnalyze(page, () => ({ state: 'error', error: 'Stopped.' }))
  await page.goto('/bbox')
  await expect(combo(page, 'Engine')).toHaveText('Florence-2 — fast, measured bboxes')
  await combo(page, 'Engine').click()
  await expect(page.getByRole('option')).toHaveText([
    'Florence-2 — fast, measured bboxes',
    'Hybrid — Florence bboxes + VLM prose',
    'VLM only — full draft, estimated bboxes',
  ])
  await page.keyboard.press('Escape')
  await expect(combo(page, 'Model')).toHaveCount(0)
  await expect(combo(page, 'Quantization')).toHaveCount(0)
  await expect(maxLength(page)).toHaveCount(0)

  await pick(page, 'Engine', 'Hybrid — Florence bboxes + VLM prose')
  await expect(combo(page, 'Model')).toHaveText('Model Two')
  await expect(combo(page, 'Quantization')).toHaveText('4-bit (saves VRAM)')
  await expect(maxLength(page)).toHaveValue('1536')
  // An invalid length blocks the analysis.
  await maxLength(page).fill('10')
  await expect(page.getByText('Enter a whole number from 64 to 8192')).toBeVisible()
  await expect(fromImage(page)).toBeDisabled()
  await maxLength(page).fill('2048')
  await pick(page, 'Quantization', 'None (fp16)')
  await pickPhoto(page)
  await expect.poll(() => bodies).toEqual([
    { file: 'ref.png', engine: 'hybrid', model: 'org/two', quant: 'none', max_tokens: '2048' },
  ])
  await expect(page.getByTestId('job-progress')).toHaveAttribute('data-state', 'error')
  await expect(fromImage(page)).toBeEnabled()

  await pick(page, 'Engine', 'VLM only — full draft, estimated bboxes')
  await pick(page, 'Model', 'Model One')
  await pickPhoto(page)
  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[1]).toEqual({ file: 'ref.png', engine: 'vlm', model: 'org/one', quant: 'none', max_tokens: '2048' })

  // Engine and model are saved in the bbox form.
  await expect.poll(async () => {
    const forms = ((await (await request.get('/api/settings')).json()) as { forms: Record<string, Record<string, unknown>> }).forms
    return forms.bbox && { engine: forms.bbox.engine, model: forms.bbox.model }
  }).toEqual({ engine: 'vlm', model: 'org/one' })
  await page.reload()
  await expect(combo(page, 'Engine')).toHaveText('VLM only — full draft, estimated bboxes')
  await expect(combo(page, 'Model')).toHaveText('Model One')

  await pick(page, 'Engine', 'Florence-2 — fast, measured bboxes')
  await expect(combo(page, 'Model')).toHaveCount(0)
  await expect(maxLength(page)).toHaveCount(0)
  await pickPhoto(page)
  await expect.poll(() => bodies.length).toBe(3)
  expect(bodies[2]).toEqual({ file: 'ref.png', engine: 'florence' })
})

test('analysis survives navigation', async ({ page }) => {
  let finished = false
  let state = 'pending'
  await mockAnalyze(page, () =>
    finished ? analyzed() : state === 'loading_model'
      ? { state, current: 'Downloading Florence-2: 40%' }
      : { state })
  await page.goto('/bbox')
  await pickPhoto(page)
  const progress = page.getByTestId('job-progress')
  await expect(progress).toContainText('Starting…')
  state = 'loading_model'
  await expect(progress).toContainText('Downloading Florence-2: 40%')
  state = 'analyzing'
  await expect(progress).toContainText('Analyzing…')

  await leaveAndReturn(page)
  await expect(progress).toContainText('Analyzing…')
  await expect(photo(page)).toBeVisible()
  await expect(fromImage(page)).toBeDisabled()

  // It finishes while the view is closed and is applied on return, once.
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Models', exact: true }).click()
  await expect(page.getByTestId('bbox-json')).toHaveCount(0)
  finished = true
  await nav.getByRole('link', { name: 'Bbox editor', exact: true }).click()
  await expect.poll(() => caption(page)).toEqual(DRAFT)
  await expect(progress).toHaveCount(0)
  expect(await analyzeRun(page)).toMatchObject({ jobId: null, applied: true })

  // Later edits are not overwritten by a return or a reload.
  await hld(page).fill('Edited after the draft.')
  await expect.poll(async () => (await caption(page)).high_level_description).toBe('Edited after the draft.')
  await leaveAndReturn(page)
  await page.reload()
  await expect(page.getByTestId('bbox-json')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await caption(page)).high_level_description).toBe('Edited after the draft.')
})

test('analysis error shows first line', async ({ page }) => {
  await mockAnalyze(page, () => ({
    state: 'error',
    error: 'Image analysis failed: CUDA out of memory.\nTraceback (most recent call last):\n  File "x"',
  }))
  await page.goto('/bbox')
  const before = await page.getByTestId('bbox-json').textContent()
  await pickPhoto(page)
  const progress = page.getByTestId('job-progress')
  await expect(progress).toHaveAttribute('data-state', 'error')
  await expect(progress).toContainText('Image analysis failed: CUDA out of memory.')
  await expect(progress).not.toContainText('Traceback')
  await expect(page.locator('[title*="Traceback"]')).toHaveCount(1)
  await expect(fromImage(page)).toBeEnabled()
  await expect(page.getByTestId('bbox-json')).toHaveText(before!)
  expect(await analyzeRun(page)).toMatchObject({ jobId: null })

  // The error is kept for the tab until dismissed.
  await page.reload()
  await expect(progress).toContainText('Image analysis failed: CUDA out of memory.')
  await page.getByRole('button', { name: 'Dismiss the error', exact: true }).click()
  await expect(progress).toHaveCount(0)
  expect(await analyzeRun(page)).toMatchObject({ jobId: null, error: '' })
  await page.reload()
  await expect(page.getByTestId('bbox-json')).toBeVisible()
  await expect(progress).toHaveCount(0)
})

/** A v15 prompt in the real library (a unique marker in its HLD); returns its row's marker. */
async function libraryPrompt(request: APIRequestContext, marker: string) {
  const prompt = JSON.stringify({
    aspect_ratio: '1:1',
    high_level_description: `${marker} studio prompt`,
    compositional_deconstruction: { background: 'A plain grey wall.', elements: [] },
  })
  const res = await request.post('/api/prompts/library', { data: { category: 'ideogram', prompt, input_text: '', action: 'manual' } })
  expect(res.ok()).toBe(true)
}

/** From the Prompt studio library: Open on canvas (the studio hands the prompt to /bbox). */
async function handOffFromStudio(page: Page, marker: string) {
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Prompt studio', exact: true }).click()
  await expect(page.getByTestId('bbox-json')).toHaveCount(0)
  await page.getByRole('region', { name: 'Prompt library', exact: true }).getByTestId('library-row')
    .filter({ hasText: marker }).getByRole('button', { name: 'Open on canvas', exact: true }).click()
  await expect(page).toHaveURL(/\/bbox$/)
}

const STUDIO_TITLE = 'Replace the current canvas with the prompt from the studio?'
const DRAFT_TITLE = 'Replace the current canvas with the image draft?'

test('a draft that finishes during the studio confirm waits for it', async ({ page, request }) => {
  const m = `marker-drafthandoff-${Date.now()}`
  await libraryPrompt(request, m)
  let finished = false
  await mockAnalyze(page, () => (finished ? analyzed() : { state: 'analyzing' }))
  await page.goto('/bbox')
  await hld(page).fill('Keep me.')
  await expect.poll(async () => (await caption(page)).high_level_description).toBe('Keep me.')
  await pickPhoto(page)
  await expect(page.getByTestId('job-progress')).toContainText('Analyzing…')

  await handOffFromStudio(page, m)
  const studio = page.getByRole('dialog', { name: STUDIO_TITLE })
  await expect(studio).toBeVisible()
  finished = true
  // The result arrives (and is kept) while the studio question stays as it was.
  await expect.poll(async () => (await analyzeRun(page))?.jobId).toBeNull()
  await expect(studio).toBeVisible()
  await expect(page.getByRole('dialog', { name: DRAFT_TITLE })).toHaveCount(0)

  await studio.getByRole('button', { name: 'Replace', exact: true }).click()
  await expect(page.getByText('Prompt loaded for editing.')).toBeVisible()
  await expect.poll(async () => (await caption(page)).high_level_description).toBe(`${m} studio prompt`)
  // Then the draft is offered.
  const draft = page.getByRole('dialog', { name: DRAFT_TITLE })
  await draft.getByRole('button', { name: 'Replace', exact: true }).click()
  await expect.poll(() => caption(page)).toEqual(DRAFT)
})

test('a studio handoff during the draft confirm waits for it', async ({ page, request }) => {
  const m = `marker-handoffdraft-${Date.now()}`
  await libraryPrompt(request, m)
  let finished = false
  await mockAnalyze(page, () => (finished ? analyzed() : { state: 'analyzing' }))
  await page.goto('/bbox')
  await hld(page).fill('Keep me.')
  await expect.poll(async () => (await caption(page)).high_level_description).toBe('Keep me.')
  await pickPhoto(page)
  await expect(page.getByTestId('job-progress')).toContainText('Analyzing…')

  // Done while away; back through a studio handoff, both want the canvas.
  finished = true
  await handOffFromStudio(page, m)
  const draft = page.getByRole('dialog', { name: DRAFT_TITLE })
  await expect(draft).toBeVisible()
  await page.waitForTimeout(500)
  await expect(draft).toBeVisible()
  await draft.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await caption(page)).high_level_description).toBe('Keep me.')

  const studio = page.getByRole('dialog', { name: STUDIO_TITLE })
  await studio.getByRole('button', { name: 'Replace', exact: true }).click()
  await expect.poll(async () => (await caption(page)).high_level_description).toBe(`${m} studio prompt`)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
