// Pure functions of the ComfyUI page, run in Node (no page): Playwright transpiles the TS module.
import { expect, test } from './fixtures.ts'
import { downloadName, fmtEta, fmtProgress, loraName, promptPreview, sourceLabel } from '../src/pages/comfy/format.ts'
import { pollJobCore } from '../src/pages/comfy/pollJobCore.ts'

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

test('gallery lora name', () => {
  expect(loraName('a.safetensors')).toBe('a.safetensors')
  expect(loraName({ lora: 'old.safetensors', strength: 1 })).toBe('old.safetensors')
  expect(loraName(null)).toBe('')
  expect(loraName(undefined)).toBe('')
  expect(loraName({ other: 1 })).toBe('{"other":1}')
})

// ---- pollJobCore (the batch's polling loop), with a stubbed `get` ----

type Job = { id: string; state: string }
const GONE = new Error('gone')

/** `get` answers these in turn (an Error is thrown); the polled ids are collected. */
function stubGet(answers: (Job | Error)[]) {
  const ids: string[] = []
  const get = async (id: string) => {
    ids.push(id)
    const a = answers.shift() ?? new Error('no more answers')
    if (a instanceof Error) throw a
    return a
  }
  return { ids, get }
}
const isGone = (e: unknown) => e === GONE

test('pollJobCore waits out errors and ends with the job', async () => {
  const stub = stubGet([new TypeError('network down'), new Error('500'), { id: 'j', state: 'running' }, { id: 'j', state: 'cancelled' }])
  const seen: string[] = []
  const job = await pollJobCore(stub.get, isGone, 'j', { intervalMs: 1, onUpdate: (j) => seen.push(j.state) })
  expect(job).toEqual({ id: 'j', state: 'cancelled' })
  expect(seen).toEqual(['running', 'cancelled'])
  expect(stub.ids).toEqual(['j', 'j', 'j', 'j'])
})

test('pollJobCore ends on done and error, and is gone', async () => {
  for (const state of ['done', 'error']) {
    const stub = stubGet([{ id: 'j', state: 'pending' }, { id: 'j', state }])
    expect(await pollJobCore(stub.get, isGone, 'j', { intervalMs: 1 })).toEqual({ id: 'j', state })
  }
  const stub = stubGet([{ id: 'j', state: 'running' }, GONE, { id: 'j', state: 'done' }])
  expect(await pollJobCore(stub.get, isGone, 'j', { intervalMs: 1 })).toBe('gone')
  expect(stub.ids).toHaveLength(2)
})

test('pollJobCore rejects when onUpdate throws', async () => {
  // Not a transient error: it must not be retried (the loop would never end).
  const stub = stubGet([{ id: 'j', state: 'running' }, { id: 'j', state: 'running' }, { id: 'j', state: 'done' }])
  const polling = pollJobCore(stub.get, isGone, 'j', {
    intervalMs: 1,
    onUpdate: () => {
      throw new Error('update failed')
    },
  })
  // A loop that retries never settles: give it half a second.
  const outcome = await Promise.race([
    polling.then(() => 'resolved', (e: Error) => e.message),
    new Promise((r) => setTimeout(() => r('still polling'), 500)),
  ])
  expect(outcome).toBe('update failed')
  expect(stub.ids).toHaveLength(1)
})

test('pollJobCore stops when aborted', async () => {
  const stub = stubGet(Array.from({ length: 1000 }, () => ({ id: 'j', state: 'running' })))
  const ctrl = new AbortController()
  const polling = pollJobCore(stub.get, isGone, 'j', { signal: ctrl.signal, intervalMs: 50 })
  await expect.poll(() => stub.ids.length).toBe(1)
  ctrl.abort(new Error('left the page'))
  await expect(polling).rejects.toThrow('left the page')
  const polls = stub.ids.length
  await new Promise((r) => setTimeout(r, 150))
  expect(stub.ids).toHaveLength(polls)
})

// ---- pollJob (pollJobCore over the app's fetch), its 404 path ----

// pollJob imports app modules ('@/…', extensionless): loaded at run time only, so the Node typecheck does not follow it.
const POLL_JOB = '../src/pages/comfy/pollJob.ts'
type PollJob = (id: string, opts: { intervalMs?: number }) => Promise<Job | 'gone'>
const loadPollJob = async () => (await import(POLL_JOB)).pollJob as PollJob

test('pollJob fetches the job URL and is gone on 404', async () => {
  const pollJob = await loadPollJob()
  const answers: (Job | number)[] = [{ id: 'j/1', state: 'running' }, 500, 404]
  const urls: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    urls.push(url)
    const a = answers.shift() ?? 500
    if (typeof a === 'number') return new Response(JSON.stringify({ detail: `status ${a}` }), { status: a })
    return new Response(JSON.stringify(a))
  }) as typeof fetch
  try {
    expect(await pollJob('j/1', { intervalMs: 1 })).toBe('gone')
    expect(urls).toEqual(Array(3).fill('/api/comfy/job/j%2F1'))
  } finally {
    globalThis.fetch = real
  }
})
