import { useQueryClient } from '@tanstack/react-query'
import { PlugZap, Save } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { setUrlDraft, useComfyForm } from './formStore'
import { errorText, patchConfig, useComfyConfig, type ConnectionTest } from './queries'
import { StatusLine, type Status } from './StatusLine'

/**
 * The ComfyUI server URL (the same setting as in Settings). Test connection
 * tests the URL in the field: an unsaved one is saved first.
 */
export function ConnectionCard() {
  const qc = useQueryClient()
  const config = useComfyConfig()
  const draft = useComfyForm().url
  const saved = config.data?.url
  const value = draft ?? saved ?? ''
  const dirty = draft !== undefined && draft.trim() !== saved
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()

  /** The saved URL (as the server normalised it), or null after showing the error. */
  const save = async () => {
    try {
      const r = await api<{ url: string }>('/api/comfy/url', { method: 'POST', json: { url: value.trim() } })
      void patchConfig(qc, { url: r.url })
      // Another server has other LoRAs.
      void qc.invalidateQueries({ queryKey: ['comfy-loras'] })
      setUrlDraft(undefined)
      return r.url
    } catch (e) {
      setStatus({ tone: 'err', text: `Error: ${errorText(e)}` })
      return null
    }
  }

  const run = async (test: boolean) => {
    setBusy(true)
    try {
      if (dirty) {
        const url = await save()
        if (url === null) return
        if (!test) setStatus({ tone: 'ok', text: `Saved: ${url}` })
      }
      if (!test) return
      setStatus({ tone: 'info', text: 'Connecting to ComfyUI…' })
      try {
        const r = await api<ConnectionTest>('/api/comfy/test', { method: 'POST' })
        const v = r.stats?.system?.comfyui_version || r.stats?.system?.os || 'ok'
        setStatus({ tone: 'ok', text: `Connected to ${r.url} (${v}).` })
      } catch (e) {
        setStatus({ tone: 'err', text: `No connection: ${errorText(e)}` })
      }
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (dirty && !busy) void run(false)
  }

  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5">
      <h2 id={id} className="text-sm font-semibold">Connection</h2>
      <form onSubmit={submit} className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-url`} className="text-xs font-medium text-text-dim">ComfyUI address (server URL)</label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`${id}-url`}
            placeholder="http://127.0.0.1:8188"
            value={value}
            disabled={config.isPending}
            onChange={(e) => setUrlDraft(e.target.value)}
            className="min-w-60 flex-1 font-mono"
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy || !dirty}>
            <Save />
            Save
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || config.isPending} onClick={() => void run(true)}>
            <PlugZap />
            Test connection
          </Button>
        </div>
      </form>
      <StatusLine status={status} />
    </section>
  )
}
