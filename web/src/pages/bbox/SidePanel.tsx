import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { BookmarkPlus, Copy, Download } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { V15Findings, type V15Finding } from '@/components/V15Findings'
import { moveEl, parseRatio, removeEl, setEl, toggleBbox, toJson, type Doc, type El } from '@/editors/bbox/model'
import { useDebounced } from '@/hooks/useDebounced'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { useMutationWithToast } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { errorText } from './normalize'

interface SidePanelProps {
  doc: Doc
  selected: number | null
  onSelect: (i: number | null) => void
  onChange: (update: (d: Doc) => Doc) => void
}

/** Words as the server lint counts them (Python `str.split()`). */
const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0)

const field =
  'w-full resize-y rounded-lg border border-line bg-bg/60 px-2.5 py-1.5 text-sm leading-relaxed outline-none focus-visible:border-accent-from/60 focus-visible:shadow-glow'

/**
 * The classic side panel: the head card and one card per element (array
 * order, bottom to top), the live server lint, the exports and the JSON.
 */
export function SidePanel({ doc, selected, onSelect, onChange }: SidePanelProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const json = toJson(doc)
  const pretty = toJson(doc, true)

  // A selection made on the canvas scrolls the list (only the list, never the page) to its card.
  useEffect(() => {
    const list = listRef.current
    const card = selected === null ? null : list?.querySelector(`[data-testid="bbox-card"][data-index="${selected}"]`)
    if (!list || !card) return
    const l = list.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    if (c.top < l.top) list.scrollTop += c.top - l.top - 4
    else if (c.bottom > l.bottom) list.scrollTop += c.bottom - l.bottom + 4
  }, [selected])

  return (
    <aside aria-label="Prompt" className="flex min-w-0 flex-col gap-4 rounded-xl border border-line bg-surface p-4">
      <div ref={listRef} className="-mr-2 flex max-h-[52vh] flex-col gap-2 overflow-y-auto pr-2">
        <HeadCard doc={doc} onChange={onChange} />
        {doc.elements.length === 0 && (
          <p className="px-1 py-2 text-sm text-text-dim">
            Add an element with + obj or + text. One subject = one element (parts go into desc).
          </p>
        )}
        {doc.elements.map((el, i) => (
          <ElementCard
            key={el.key}
            el={el}
            index={i}
            count={doc.elements.length}
            selected={i === selected}
            onSelect={() => onSelect(i)}
            onChange={onChange}
          />
        ))}
      </div>
      <Lint json={json} />
      <Actions json={json} pretty={pretty} />
      <pre
        data-testid="bbox-json"
        className="max-h-40 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-text"
      >
        {pretty}
      </pre>
    </aside>
  )
}

function Counter({ n, max, testId }: { n: number; max: number; testId: string }) {
  return (
    <span
      data-testid={testId}
      className={cn('font-mono text-[11px] tabular-nums text-text-dim', n > max && 'font-semibold text-warning')}
    >
      {n}/{max} words
    </span>
  )
}

function Field({ id, label, counter, children }: { id: string; label: string; counter?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="font-mono text-[11px] text-text-dim">{label}</label>
        {counter}
      </div>
      {children}
    </div>
  )
}

function HeadCard({ doc, onChange }: { doc: Doc; onChange: SidePanelProps['onChange'] }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-bg/40 p-3">
      <Field id={`${id}-ar`} label="aspect_ratio">
        <RatioField
          id={`${id}-ar`}
          value={doc.aspect_ratio}
          onChange={(aspect_ratio) => onChange((d) => ({ ...d, aspect_ratio }))}
        />
      </Field>
      <Field id={`${id}-hld`} label="high_level_description" counter={<Counter n={words(doc.hld)} max={50} testId="hld-counter" />}>
        <textarea
          id={`${id}-hld`}
          value={doc.hld}
          onChange={(e) => {
            const hld = e.target.value
            onChange((d) => ({ ...d, hld }))
          }}
          className={cn(field, 'min-h-16')}
        />
      </Field>
      <Field id={`${id}-bg`} label="background (scene shell only)">
        <textarea
          id={`${id}-bg`}
          value={doc.bg}
          onChange={(e) => {
            const bg = e.target.value
            onChange((d) => ({ ...d, bg }))
          }}
          className={cn(field, 'min-h-20')}
        />
      </Field>
    </div>
  )
}

/** Applied on blur or Enter, so typing keeps the focus; a bad value goes back to the current ratio. */
function RatioField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value)
  // A ratio set elsewhere (the toolbar, a load) replaces the typed text.
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setText(value)
  }
  const commit = () => {
    const v = text.trim()
    if (!parseRatio(v)) {
      setText(value)
      return
    }
    setText(v)
    if (v !== value) onChange(v)
  }
  return (
    <Input
      id={id}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className="h-8 font-mono"
    />
  )
}

interface ElementCardProps {
  el: El
  index: number
  count: number
  selected: boolean
  onSelect: () => void
  onChange: SidePanelProps['onChange']
}

function ElementCard({ el, index, count, selected, onSelect, onChange }: ElementCardProps) {
  const id = useId()
  const text = el.type === 'text'
  return (
    <div
      data-testid="bbox-card"
      data-index={index}
      data-selected={selected || undefined}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('button, input, textarea, label')) onSelect()
      }}
      className={cn(
        'flex flex-col gap-2.5 rounded-lg border p-3 transition-[background-color,border-color] duration-150 motion-reduce:transition-none',
        selected ? 'border-accent-from/55 bg-accent-from/[0.07]' : 'border-line bg-bg/40 hover:border-white/15',
      )}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', text ? 'bg-bbox-text' : 'bg-bbox-obj')} />
        <b className="text-sm font-semibold">{el.type} #{index + 1}</b>
        <div className="ml-auto flex gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            title="bring forward"
            aria-label="Bring forward"
            disabled={index === count - 1}
            onClick={() => onChange((d) => moveEl(d, index, 'forward'))}
          >
            ▲
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="send backward"
            aria-label="Send backward"
            disabled={index === 0}
            onClick={() => onChange((d) => moveEl(d, index, 'backward'))}
          >
            ▼
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="remove"
            aria-label="Remove element"
            onClick={() => onChange((d) => removeEl(d, index))}
            className="text-text-dim hover:text-danger"
          >
            ×
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-text-dim">
        <span>{el.bbox ? `bbox [${el.bbox.join(', ')}]` : 'no bbox'}</span>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={!!el.bbox}
            onChange={(e) => {
              const on = e.target.checked
              onChange((d) => toggleBbox(d, index, on))
            }}
            className="size-3.5 accent-accent-from"
          />
          bbox
        </label>
      </div>
      {text && (
        <Field id={`${id}-text`} label={'text (verbatim, \\n = new line)'}>
          <textarea
            id={`${id}-text`}
            value={el.text}
            onChange={(e) => {
              const text = e.target.value
              onChange((d) => setEl(d, index, { text }))
            }}
            className={cn(field, 'min-h-10 font-mono')}
          />
        </Field>
      )}
      <Field id={`${id}-desc`} label="desc" counter={<Counter n={words(el.desc)} max={60} testId="desc-counter" />}>
        <textarea
          id={`${id}-desc`}
          value={el.desc}
          onChange={(e) => {
            const desc = e.target.value
            onChange((d) => setEl(d, index, { desc }))
          }}
          className={cn(field, 'min-h-14')}
        />
      </Field>
    </div>
  )
}

/** The server's v15 lint of the JSON, 400 ms after the last change. */
function Lint({ json }: { json: string }) {
  const settled = useDebounced(json, 400)
  // Keyed by the JSON, so an older answer never overwrites a newer one.
  const lint = useQuery({
    queryKey: ['lint', settled],
    queryFn: () => api<{ warnings: V15Finding[] }>('/api/prompts/lint', { method: 'POST', json: { prompt: settled } }),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  })
  // A failed check must not leave the findings of an older JSON on screen.
  if (lint.isError) {
    return (
      <p role="alert" className="rounded-lg border border-danger/25 bg-danger/[0.06] px-3 py-2 text-sm text-danger">
        Could not check the prompt: {errorText(lint.error)}
      </p>
    )
  }
  if (!lint.data) return <p className="text-sm text-text-dim">Checking…</p>
  return <V15Findings findings={lint.data.warnings} />
}

function Actions({ json, pretty }: { json: string; pretty: string }) {
  const save = useMutationWithToast(
    (prompt: string) =>
      api<{ id: number }>('/api/prompts/library', {
        method: 'POST',
        json: { category: 'ideogram', prompt, input_text: 'bbox editor', action: 'manual' },
      }),
    { invalidate: [['prompt-library']], onSuccess: (r) => toast.success(`Saved to the library (#${r.id}).`) },
  )
  const copy = (text: string) =>
    copyText(text).then(
      () => toast.success('Copied to clipboard.'),
      (e: Error) => toast.error(e.message),
    )
  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'caption_v15.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => copy(json)}>
        <Copy />
        Copy (minified)
      </Button>
      <Button size="sm" variant="outline" onClick={() => copy(pretty)}>Pretty</Button>
      <Button size="sm" variant="outline" onClick={download}>
        <Download />
        Download
      </Button>
      <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate(json)}>
        <BookmarkPlus />
        Save to library
      </Button>
    </div>
  )
}
