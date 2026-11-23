import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FolderOpen, Upload } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { FolderPicker } from '@/components/FolderPicker'
import { GpuSelect } from '@/components/GpuSelect'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { ROLE_LABEL } from '@/lib/format'
import { useMutationWithToast, useSetModelsDir, useSettings } from '@/lib/queries'
import type { Role, Settings } from '@/lib/types'
import { cn } from '@/lib/utils'
import { comfyUrlChanged, fetchComfyConfig } from '@/pages/comfy/queries'

/** A settings card; a labelled region so tests and screen readers can find it by title. */
function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div>
        <h2 id={id} className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-1 text-xs text-text-dim">{description}</p>}
      </div>
      {children}
    </section>
  )
}

const accent = 'bg-linear-to-r from-accent-from to-accent-to text-white'

function ModelsFolderSection() {
  const settings = useSettings()
  const save = useSetModelsDir()
  const saved = settings.data?.models_dir
  const [dir, setDir] = useState('')
  const [picking, setPicking] = useState(false)

  // Follows the stored value when it loads or changes (e.g. after a save).
  useEffect(() => {
    if (saved !== undefined) setDir(saved)
  }, [saved])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate(dir.trim())
  }

  return (
    <Section title="Models folder" description="Downloaded models go here, each in its own subfolder.">
      <form onSubmit={submit} className="flex items-center gap-2">
        <Input
          aria-label="Models folder"
          placeholder="/path/to/models"
          value={dir}
          disabled={settings.isPending}
          onChange={(e) => setDir(e.target.value)}
          className="font-mono"
        />
        <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
          <FolderOpen />
          Choose…
        </Button>
        <Button type="submit" size="sm" disabled={!dir.trim() || save.isPending} className={accent}>
          Save
        </Button>
      </form>
      <FolderPicker
        open={picking}
        onOpenChange={setPicking}
        title="Choose the models folder"
        initialPath={saved || undefined}
        onPick={(d) => save.mutate(d)}
      />
    </Section>
  )
}

const ROLES: Role[] = ['vlm', 'florence', 'upscale']

function GpuSection() {
  const settings = useSettings()
  const assign = useMutationWithToast(
    (v: { role: Role; device: string }) => api('/api/gpu/assign', { method: 'POST', json: v }),
    { success: 'GPU assignment saved', invalidate: [['settings'], ['gpus'], ['gpu']] },
  )

  return (
    <Section
      title="GPU"
      description="Which card each model runs on. Moving a role unloads its model; it loads again on next use."
    >
      <div className="flex flex-col divide-y divide-line">
        {ROLES.map((role) => (
          <div key={role} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
            <span className="text-sm">{ROLE_LABEL[role]}</span>
            {settings.data ? (
              <GpuSelect
                label={ROLE_LABEL[role]}
                value={settings.data.gpu[role]}
                // Captioning on CPU is not offered until fp16 VLM on CPU is verified.
                hideCpu={role === 'vlm'}
                onChange={(device) => assign.mutate({ role, device })}
              />
            ) : (
              <Skeleton className="h-8 w-56" />
            )}
          </div>
        ))}
      </div>
    </Section>
  )
}

interface TokenStatus {
  set: boolean
  tail: string
}

function HfTokenSection() {
  const status = useQuery({ queryKey: ['hf-token'], queryFn: () => api<TokenStatus>('/api/hf/token') })
  // Held only in this input; never cached or stored by the UI.
  const [token, setToken] = useState('')
  // No mutation variables: those would keep the token in the mutation cache.
  const save = useMutationWithToast(
    () => api<TokenStatus>('/api/hf/token', { method: 'POST', json: { token: token.trim() } }),
    { success: 'Token saved', invalidate: [['hf-token']] },
  )
  const clear = useMutationWithToast(
    () => api<TokenStatus>('/api/hf/token', { method: 'DELETE' }),
    { success: 'Token cleared', invalidate: [['hf-token']] },
  )

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate(undefined, { onSuccess: () => setToken('') })
  }

  return (
    <Section
      title="Hugging Face token"
      description="For gated repositories. Kept on this machine; the app only ever shows its last 4 characters."
    >
      <div className="flex items-center gap-2">
        {status.isPending ? (
          <Skeleton className="h-5 w-20" />
        ) : (
          <Badge
            variant="outline"
            className={cn('font-mono', status.data?.set ? 'border-success/40 text-success' : 'text-text-dim')}
          >
            {status.data?.set ? `set …${status.data.tail}` : 'not set'}
          </Badge>
        )}
        {status.data?.set && (
          <Button
            variant="ghost"
            size="sm"
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
            className="text-text-dim hover:text-danger"
          >
            Clear
          </Button>
        )}
      </div>
      <form onSubmit={submit} className="flex items-center gap-2">
        <Input
          type="password"
          aria-label="Token"
          placeholder="hf_…"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="font-mono"
        />
        <Button type="submit" size="sm" disabled={!token.trim() || save.isPending} className={accent}>
          Save
        </Button>
      </form>
    </Section>
  )
}

interface UrlFieldProps<T> {
  label: string
  queryKey: string
  load: () => Promise<T>
  /** The URL in what `load` returns (the query may be shared with another view). */
  urlOf: (data: T) => string
  save: (url: string) => Promise<unknown>
  success: string
  /** After a successful save. */
  onSaved?: () => void
}

function UrlField<T>({ label, queryKey, load, urlOf, save, success, onSaved }: UrlFieldProps<T>) {
  const query = useQuery({ queryKey: [queryKey], queryFn: load, select: urlOf })
  const [url, setUrl] = useState('')
  const mutation = useMutationWithToast(save, { success, invalidate: [[queryKey]], onSuccess: onSaved })

  useEffect(() => {
    if (query.data !== undefined) setUrl(query.data)
  }, [query.data])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    mutation.mutate(url.trim())
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-sm">{label}</span>
      <Input
        aria-label={label}
        value={url}
        disabled={query.isPending}
        onChange={(e) => setUrl(e.target.value)}
        className="font-mono"
      />
      <Button type="submit" size="sm" variant="outline" disabled={mutation.isPending || url === query.data}>
        Save
      </Button>
    </form>
  )
}

function ServicesSection() {
  const qc = useQueryClient()
  return (
    <Section title="Services" description="Local servers the app talks to.">
      <UrlField
        label="LM Studio URL"
        queryKey="lmstudio"
        load={() => api<{ url: string }>('/api/lmstudio')}
        urlOf={(r) => r.url}
        save={(url) => api('/api/lmstudio', { method: 'POST', json: { url } })}
        success="LM Studio URL saved"
      />
      <UrlField
        label="ComfyUI URL"
        queryKey="comfy-config"
        load={fetchComfyConfig}
        urlOf={(c) => c.url}
        save={(url) => api('/api/comfy/url', { method: 'POST', json: { url } })}
        success="ComfyUI URL saved"
        onSaved={() => void comfyUrlChanged(qc)}
      />
    </Section>
  )
}

function BackupSection() {
  const file = useRef<HTMLInputElement>(null)
  const restore = useMutationWithToast(
    (doc: unknown) => api<Settings>('/api/settings/import', { method: 'POST', json: doc }),
    { success: 'Settings imported', invalidate: [['settings'], ['store-models'], ['gpus']] },
  )

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = '' // the same file can be picked again
    if (!f) return
    let doc: unknown
    try {
      doc = JSON.parse(await f.text())
    } catch {
      toast.error('Not a valid settings file.')
      return
    }
    restore.mutate(doc)
  }

  return (
    <Section
      title="Backup"
      description="Models folder, GPU roles, saved forms and presets. The Hugging Face token is never included."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <a href="/api/settings/export" download>
            <Download />
            Export settings
          </a>
        </Button>
        <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => file.current?.click()}>
          <Upload />
          Import…
        </Button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          aria-label="Settings file"
          className="hidden"
          onChange={pick}
        />
      </div>
    </Section>
  )
}

export function SettingsPage() {
  return (
    <div className="flex max-w-3xl flex-col gap-5 px-10 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-text-dim">Where models live, which GPU runs what, and the services the app uses.</p>
      </div>
      <ModelsFolderSection />
      <GpuSection />
      <HfTokenSection />
      <ServicesSection />
      <BackupSection />
    </div>
  )
}
