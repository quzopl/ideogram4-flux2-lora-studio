import type { Page } from '@playwright/test'
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

  // Escape deselects; the keys then do nothing.
  await page.keyboard.press('Escape')
  await expect(selectedBox(page)).toHaveCount(0)
  await expect(page.locator('[data-h]')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Delete')
  expect(await bboxOf(page, 0)).toEqual([209, 191, 509, 491])
  expect((await caption(page)).compositional_deconstruction.elements).toHaveLength(2)

  await box(page, 0).click()
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await caption(page)).compositional_deconstruction.elements.map((e) => e.type)).toEqual(['text'])
  await expect(selectedBox(page)).toHaveCount(0)
  await box(page, 0).click()
  await page.keyboard.press('Backspace')
  await expect.poll(async () => (await caption(page)).compositional_deconstruction.elements).toEqual([])
  await expect(page.getByText('Add an element with + obj or + text.')).toBeVisible()
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
