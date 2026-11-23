// Pure functions of the ComfyUI page, run in Node (no page): Playwright transpiles the TS module.
import { expect, test } from './fixtures.ts'
import { downloadName, fmtEta, fmtProgress, loraName, promptPreview, sourceLabel } from '../src/pages/comfy/format.ts'
import { pollJobCore } from '../src/pages/comfy/pollJobCore.ts'
import {
  buildKnownEnums, controlSchema, fixEnumValue, getSchema, getSchemaForName, isDictValue, isLinkValue, numberSpec, parseJson,
  sortNodeIds, type ObjectInfo,
} from '../src/pages/comfy/editor/schema.ts'

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

// ---- The workflow editor's schema helpers ----

const INFO: ObjectInfo = {
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { default: 0, min: 0, max: 18446744073709551615 }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 8, min: 0, max: 100, step: 0.1 }],
        sampler_name: [['euler', 'dpmpp_2m'], {}],
        scheduler: [['simple', 'karras'], {}],
      },
      optional: { denoise: ['FLOAT', {}] },
    },
  },
  KSamplerAdvanced: { input: { required: { sampler_name: [['euler', 'uni_pc'], {}] } } },
  LoraLoader: { input: { required: { lora_name: [['b.safetensors', 'a.safetensors'], {}] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['flux.safetensors'], {}] } } },
}

test('isLinkValue and isDictValue', () => {
  expect(isLinkValue(['4', 0])).toBe(true)
  expect(isLinkValue([4, 1])).toBe(true)
  expect(isLinkValue(['4'])).toBe(false)
  expect(isLinkValue([{ a: 1 }, 2])).toBe(false)
  expect(isLinkValue([null, 2])).toBe(false)
  expect(isLinkValue('4')).toBe(false)
  expect(isLinkValue({ 0: '4', 1: 0 })).toBe(false)
  expect(isDictValue({ on: true })).toBe(true)
  expect(isDictValue({})).toBe(true)
  expect(isDictValue(['4', 0])).toBe(false)
  expect(isDictValue(null)).toBe(false)
  expect(isDictValue('x')).toBe(false)
})

test('buildKnownEnums unions every node type and sorts', () => {
  const enums = buildKnownEnums(INFO)
  expect(enums.sampler_name).toEqual(['dpmpp_2m', 'euler', 'uni_pc'])
  expect(enums.lora_name).toEqual(['a.safetensors', 'b.safetensors'])
  expect(Object.keys(enums).sort()).toEqual(['ckpt_name', 'lora_name', 'sampler_name', 'scheduler'])
  expect(buildKnownEnums(null)).toEqual({})
})

test('getSchema reads required, then optional', () => {
  expect(getSchema(INFO, 'KSampler', 'steps')).toEqual(['INT', { default: 20, min: 1, max: 10000 }])
  expect(getSchema(INFO, 'KSampler', 'denoise')).toEqual(['FLOAT', {}])
  expect(getSchema(INFO, 'KSampler', 'nope')).toBeNull()
  expect(getSchema(INFO, 'Unknown', 'steps')).toBeNull()
  expect(getSchema(null, 'KSampler', 'steps')).toBeNull()
})

test('getSchemaForName guesses lora, ckpt and sampler lists', () => {
  const enums = buildKnownEnums(INFO)
  // The exact field name first.
  expect(getSchemaForName(enums, 'scheduler')).toEqual([enums.scheduler, {}])
  // lora: any name containing it (e.g. rgthree's `lora`).
  expect(getSchemaForName(enums, 'lora')).toEqual([enums.lora_name, {}])
  expect(getSchemaForName(enums, 'LoRA_02')).toEqual([enums.lora_name, {}])
  // ckpt / checkpoint, and exactly `model` (not any name containing it).
  expect(getSchemaForName(enums, 'ckpt')).toEqual([enums.ckpt_name, {}])
  expect(getSchemaForName(enums, 'base_checkpoint')).toEqual([enums.ckpt_name, {}])
  expect(getSchemaForName(enums, 'model')).toEqual([enums.ckpt_name, {}])
  expect(getSchemaForName(enums, 'model_type')).toBeNull()
  // sampler.
  expect(getSchemaForName(enums, 'sampler')).toEqual([enums.sampler_name, {}])
  // Not known (no vae list here), or no schemas at all.
  expect(getSchemaForName(enums, 'vae')).toBeNull()
  expect(getSchemaForName(enums, 'text')).toBeNull()
  expect(getSchemaForName(null, 'lora')).toBeNull()
})

test('controlSchema keeps only specs that pick a control', () => {
  expect(controlSchema(['INT', {}])).toEqual(['INT', {}])
  expect(controlSchema([['a'], {}])).toEqual([['a'], {}])
  expect(controlSchema(['STRING', { multiline: true }])).toEqual(['STRING', { multiline: true }])
  expect(controlSchema(['MODEL'])).toBeNull()
  expect(controlSchema(null)).toBeNull()
})

test('numberSpec: schema bounds, and fractions by value or name', () => {
  expect(numberSpec(['INT', { min: 1, max: 10000 }], 20, 'steps')).toEqual({ decimal: false, min: 1, max: 10000 })
  expect(numberSpec(['INT', { min: 8, max: 16384, step: 8 }], 1024, 'width')).toEqual({ decimal: false, min: 8, max: 16384, step: 8 })
  // A "no limit" maximum (the seed's 2^64) is dropped.
  expect(numberSpec(['INT', { min: 0, max: 18446744073709551615 }], 42, 'seed')).toEqual({ decimal: false, min: 0 })
  // FLOAT: fractions, step 0.01 unless the schema has one.
  expect(numberSpec(['FLOAT', { min: 0, max: 100, step: 0.1 }], 1, 'cfg')).toEqual({ decimal: true, min: 0, max: 100, step: 0.1 })
  expect(numberSpec(['FLOAT', {}], 1, 'x')).toEqual({ decimal: true, step: 0.01 })
  // Not a number field.
  expect(numberSpec(['STRING', {}], 5, 'text')).toBeNull()
  expect(numberSpec([['a', 'b'], {}], 5, 'x')).toBeNull()
  expect(numberSpec(null, 'text', 'x')).toBeNull()
  expect(numberSpec(null, null, 'cfg')).toBeNull()
  // No schema: a fraction reads fractions, a whole number reads whole numbers…
  expect(numberSpec(null, 0.75, 'anything')).toEqual({ decimal: true, step: 0.01 })
  expect(numberSpec(null, 20, 'steps')).toEqual({ decimal: false, step: 1 })
  expect(numberSpec(null, 42, 'seed')).toEqual({ decimal: false, step: 1 })
  // …except names that hold fractions (JSON `1.0` arrives as 1).
  for (const name of ['cfg', 'denoise', 'shift', 'strength', 'strength_model', 'lora_strength', 'CFG']) {
    expect(numberSpec(null, 1, name), name).toEqual({ decimal: true, step: 0.01 })
  }
  for (const name of ['steps', 'cfg_scale_steps', 'width', 'my_shift_count']) {
    expect(numberSpec(null, 1, name), name).toEqual({ decimal: false, step: 1 })
  }
})

test('parseJson gives the value or the error', () => {
  expect(parseJson('{"a": [1, 2]}')).toEqual({ value: { a: [1, 2] } })
  expect(parseJson('null')).toEqual({ value: null })
  const bad = parseJson('{"a": ')
  expect('error' in bad && bad.error).toMatch(/^Invalid JSON: /)
})

test('sortNodeIds numeric, else alphabetical', () => {
  expect(sortNodeIds(['10', '9', '3', '11'])).toEqual(['3', '9', '10', '11'])
  expect(sortNodeIds(['b', 'a', 'c'])).toEqual(['a', 'b', 'c'])
})

test('fixEnumValue turns a listed Windows path into the listed one', () => {
  const choices = ['dir/a.safetensors', 'b.safetensors']
  expect(fixEnumValue(choices, 'dir\\a.safetensors')).toBe('dir/a.safetensors')
  expect(fixEnumValue(choices, 'b.safetensors')).toBe('b.safetensors')
  // Not on the list either way: kept as it is.
  expect(fixEnumValue(choices, 'other\\c.safetensors')).toBe('other\\c.safetensors')
  expect(fixEnumValue(choices, null)).toBe('')
  expect(fixEnumValue([1, 2], 2)).toBe('2')
})
