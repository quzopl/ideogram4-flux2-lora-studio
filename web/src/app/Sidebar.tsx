import {
  Boxes,
  ExternalLink,
  ImageUpscale,
  Images,
  Settings,
  Sparkles,
  SquareDashedMousePointer,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { motion } from 'motion/react'
import { NavLink } from 'react-router'
import { cn } from '@/lib/utils'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

const STUDIO: NavItem[] = [
  { to: '/dataset', label: 'Dataset', icon: Images },
  { to: '/prompts', label: 'Prompt studio', icon: Sparkles },
  { to: '/bbox', label: 'Bbox editor', icon: SquareDashedMousePointer },
  { to: '/comfy', label: 'ComfyUI', icon: Workflow },
  { to: '/upscale', label: 'Upscale', icon: ImageUpscale },
]

const SYSTEM: NavItem[] = [
  { to: '/models', label: 'Models', icon: Boxes },
  { to: '/settings', label: 'Settings', icon: Settings },
]

function Item({ to, label, icon: Icon }: NavItem) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'group relative flex h-9 items-center gap-3 rounded-xl px-3 text-sm outline-none transition-colors',
          'focus-visible:shadow-glow',
          isActive ? 'text-text' : 'text-text-dim hover:bg-white/[0.03] hover:text-text',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.div
              layoutId="nav-active"
              transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              className="absolute inset-0 rounded-xl bg-linear-to-r from-accent-from/25 via-accent-from/10 to-accent-to/10 ring-1 ring-white/10 ring-inset"
            >
              <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-linear-to-b from-accent-from to-accent-to" />
            </motion.div>
          )}
          <Icon
            className={cn(
              'relative size-4 shrink-0 transition-colors',
              isActive ? 'text-accent-to' : 'text-text-dim group-hover:text-text',
            )}
          />
          <span className="relative truncate">{label}</span>
        </>
      )}
    </NavLink>
  )
}

export function Sidebar() {
  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-line bg-surface/70 backdrop-blur-xl">
      <div className="flex h-16 items-center gap-3 px-5">
        <img src="/favicon.svg" alt="" className="size-7" />
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">FLUX LoRA</div>
          <div className="text-xs text-text-dim">Studio</div>
        </div>
      </div>

      <nav aria-label="Main" className="flex flex-1 flex-col gap-1 px-3 py-2">
        {STUDIO.map((item) => (
          <Item key={item.to} {...item} />
        ))}
        <div className="mx-3 my-3 h-px bg-line" />
        {SYSTEM.map((item) => (
          <Item key={item.to} {...item} />
        ))}
      </nav>

      <a
        href="/legacy/"
        className="mx-3 mb-4 flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-text-dim transition-colors hover:bg-white/[0.03] hover:text-text"
      >
        <ExternalLink className="size-3.5" />
        Classic UI
      </a>
    </aside>
  )
}
