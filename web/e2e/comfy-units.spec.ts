// Pure functions of the ComfyUI page, run in Node (no page): Playwright transpiles the TS module.
import { expect, test } from '@playwright/test'
import { downloadName, fmtEta, fmtProgress, promptPreview, sourceLabel } from '../src/pages/comfy/format.ts'

test('fmtEta formats like classic', () => {
  expect(fmtEta(0)).toBe('0s')
  expect(fmtEta(12.4)).toBe('12s')
  expect(fmtEta(59.6)).toBe('1m 00s')
  expect(fmtEta(65)).toBe('1m 05s')
  expect(fmtEta(754)).toBe('12m 34s')
  expect(fmtEta(3599)).toBe('59m 59s')
  expect(fmtEta(3600)).toBe('1h 00m')
  expect(fmtEta(3600 * 2 + 60 * 7 + 59)).toBe('2h 07m')
  expect(fmtEta(3600 * 30 + 60 * 15)).toBe('30h 15m')
})

test('fmtProgress formats like classic', () => {
  expect(fmtProgress(null)).toBe('')
  expect(fmtProgress(undefined)).toBe('')
  expect(fmtProgress({})).toBe('')
  expect(fmtProgress({ value: 0, max: 0, speed: 0, eta: 0 })).toBe('')
  // Each part only when present: a count when there is a max, speed > 0, eta > 0.
  expect(fmtProgress({ value: 3, max: 20, speed: 0, eta: 0 })).toBe('  ·  3/20')
  expect(fmtProgress({ max: 20 })).toBe('  ·  0/20')
  expect(fmtProgress({ value: 3, max: 20, speed: 1.5, eta: 11.6 })).toBe('  ·  3/20  ·  1.50 it/s  ·  ~12s left')
  expect(fmtProgress({ value: 7, max: 48, speed: 0.123, eta: 754 })).toBe('  ·  7/48  ·  0.12 it/s  ·  ~12m 34s left')
  expect(fmtProgress({ value: 1, max: 1000, speed: 0.01, eta: 3600 * 2 + 60 * 7 })).toBe('  ·  1/1000  ·  0.01 it/s  ·  ~2h 07m left')
  expect(fmtProgress({ speed: 2, eta: 0 })).toBe('  ·  2.00 it/s')
  expect(fmtProgress({ eta: 5 })).toBe('  ·  ~5s left')
})

test('gallery card prompt and source label', () => {
  expect(promptPreview('short', 'f.png')).toBe('short')
  expect(promptPreview('x'.repeat(70), 'f.png')).toBe('x'.repeat(70))
  expect(promptPreview('x'.repeat(71), 'f.png')).toBe(`${'x'.repeat(70)}…`)
  // No prompt: the file name (classic).
  expect(promptPreview('', 'f.png')).toBe('f.png')
  expect(sourceLabel('lora_test')).toBe('LoRA test')
  expect(sourceLabel('editor')).toBe('Editor')
  expect(sourceLabel('ideogram')).toBe('Ideogram')
  expect(sourceLabel('other')).toBe('other')
})

test('gallery download name', () => {
  expect(downloadName({ id: 'abc', filename: 'ComfyUI_00001_.png' })).toBe('ComfyUI_00001_.png')
  expect(downloadName({ id: 'abc', filename: 'render' })).toBe('render.png')
  expect(downloadName({ id: 'abc', filename: '' })).toBe('abc.png')
  expect(downloadName({ id: '', filename: '' })).toBe('image.png')
})

// ---- pollJob (the batch's polling core) against a stubbed fetch ----

// pollJob imports app modules ('@/…', extensionless): loaded at run time only, so the Node typecheck does not follow it.
const POLL_JOB = '../src/pages/comfy/pollJob.ts'
type Job = { id: string; state: string }
type PollJob = (
  id: string,
  opts: { signal?: AbortSignal; intervalMs?: number; onUpdate?: (job: Job) => void },
) => Promise<Job | 'gone'>
const loadPollJob = async () => (await import(POLL_JOB)).pollJob as PollJob

/** fetch answers these in turn (an Error is thrown, a number is that status); the requested URLs are collected. */
function stubFetch(answers: (Job | number | Error)[]) {
  const urls: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    urls.push(url)
    const a = answers.shift() ?? 500
    if (a instanceof Error) throw a
    if (typeof a === 'number') return new Response(JSON.stringify({ detail: `status ${a}` }), { status: a })
    return new Response(JSON.stringify(a))
  }) as typeof fetch
  return { urls, restore: () => { globalThis.fetch = real } }
}

test('pollJob waits out errors and ends with the job', async () => {
  const pollJob = await loadPollJob()
  const stub = stubFetch([new TypeError('network down'), 500, { id: 'j', state: 'running' }, { id: 'j', state: 'cancelled' }])
  try {
    const seen: string[] = []
    const job = await pollJob('j', { intervalMs: 1, onUpdate: (j) => seen.push(j.state) })
    expect(job).toEqual({ id: 'j', state: 'cancelled' })
    expect(seen).toEqual(['running', 'cancelled'])
    expect(stub.urls).toEqual(Array(4).fill('/api/comfy/job/j'))
  } finally {
    stub.restore()
  }
})

test('pollJob ends on done and error, and is gone on 404', async () => {
  const pollJob = await loadPollJob()
  for (const state of ['done', 'error']) {
    const stub = stubFetch([{ id: 'j', state: 'pending' }, { id: 'j', state }])
    try {
      expect(await pollJob('j', { intervalMs: 1 })).toEqual({ id: 'j', state })
    } finally {
      stub.restore()
    }
  }
  const stub = stubFetch([{ id: 'j', state: 'running' }, 404, { id: 'j', state: 'done' }])
  try {
    expect(await pollJob('j', { intervalMs: 1 })).toBe('gone')
    expect(stub.urls).toHaveLength(2)
  } finally {
    stub.restore()
  }
})

test('pollJob stops when aborted', async () => {
  const pollJob = await loadPollJob()
  const stub = stubFetch(Array.from({ length: 1000 }, () => ({ id: 'j', state: 'running' })))
  try {
    const ctrl = new AbortController()
    const polling = pollJob('j', { signal: ctrl.signal, intervalMs: 50 })
    await expect.poll(() => stub.urls.length).toBe(1)
    ctrl.abort(new Error('left the page'))
    await expect(polling).rejects.toThrow('left the page')
    const polls = stub.urls.length
    await new Promise((r) => setTimeout(r, 150))
    expect(stub.urls).toHaveLength(polls)
  } finally {
    stub.restore()
  }
})
