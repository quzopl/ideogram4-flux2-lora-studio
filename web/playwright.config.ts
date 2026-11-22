import { defineConfig } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Created once in the main process; workers inherit it through the environment.
process.env.E2E_WORK ??= fs.mkdtempSync(path.join(os.tmpdir(), 'flux-prep-e2e-'))

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:8131' },
  webServer: {
    command:
      'cd .. && .venv/bin/python -m uvicorn backend.server:app --host 127.0.0.1 --port 8131',
    url: 'http://127.0.0.1:8131',
    reuseExistingServer: false,
    env: { FLUX_PREP_WORK: process.env.E2E_WORK },
  },
})
