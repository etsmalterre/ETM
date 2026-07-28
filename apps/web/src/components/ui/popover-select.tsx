// Styled, portal-positioned dropdown components. Replaces native <select>
// where the option list needs to be styled (hand cursor, hover states,
// theming) or where the trigger sits inside a clipping ancestor (KV rows,
// scrollable detail panels). See `mps_designer §11bis` for the full picture.
//
// - `PopoverSelect`        — short ID-keyed lists (< 30 items), no search
// - `SearchableCombobox<T>` — long lists (30+ items), typed live filter
//
// Both portal the option list into `document.body` and position it via
// `getBoundingClientRect()` from the trigger. They close on outside click
// and on outer scroll, but explicitly NOT on scrolls inside the popover
// itself (the option list scrolls).

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── PopoverSelect (generic styled ID-keyed dropdown) ─────

export interface PopoverSelectOption {
  id: number
  primary: string
  /** Compact label shown right of primary on the *trigger button* and right
   *  of primary on the *option row*. Kept short. */
  secondary?: string
  /** Multi-line detail rendered below the primary on each option row only
   *  (NOT on the trigger button). Use newlines (`\n`) for layout — each line
   *  becomes a separate `<span>`. Use this when the user needs to verify a
   *  selection at a glance, e.g. addresses showing street + postal + city. */
  description?: string
}

export function PopoverSelect({
  options,
  value,
  onChange,
  emptyLabel = '— aucun —',
  hideEmpty = false,
  disabled,
  disabledTitle,
  size = 'default',
  widthClass,
}: {
  options: PopoverSelectOption[]
  value: number
  onChange: (id: number) => void
  /** Label for the `id=0` "none" option at the top of the popover. */
  emptyLabel?: string
  /** Hide the "none" option from the popover entirely. Use when the field
   *  is required AND has a sensible default — the user can switch between
   *  options but cannot un-select. The `emptyLabel` is still used as the
   *  button label fallback if `value` doesn't match any option (defensive). */
  hideEmpty?: boolean
  disabled?: boolean
  disabledTitle?: string
  size?: 'default' | 'sm'
  /** Override the trigger width (default: `w-[220px]` at size="sm", `w-full`
   *  otherwise). For short values — a year, a code — where 220px would crowd
   *  the row. The popover itself stays at least 240px wide regardless, so the
   *  options remain readable from a narrow trigger. */
  widthClass?: string
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)

  const reposition = useCallback(() => {
    const el = buttonRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: r.left, top: r.bottom, width: r.width })
  }, [])

  useEffect(() => {
    if (!open) return
    reposition()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (buttonRef.current?.contains(t)) return
      if (popoverRef.current?.contains(t)) return
      setOpen(false)
    }
    // Ignore scrolls inside the popover itself — the options list is
    // scrollable and must not close on internal scroll.
    const onScroll = (e: Event) => {
      if (popoverRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, reposition])

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  const selected = options.find((o) => o.id === value)
  const buttonLabel = value === 0
    ? emptyLabel
    : selected
      ? (selected.secondary ? `${selected.primary} — ${selected.secondary}` : selected.primary)
      : emptyLabel

  const isSm = size === 'sm'
  return (
    <div className={cn('relative inline-block align-middle', widthClass ?? (isSm ? 'w-[220px]' : 'w-full'))}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'w-full rounded-md border bg-white flex items-center justify-between gap-2 transition-colors cursor-pointer',
          'focus:outline-none focus:ring-2 focus:ring-ring',
          isSm ? 'h-7 pl-2 pr-1.5 text-sm' : 'h-9 pl-3 pr-2 text-sm',
          open ? 'border-ring' : 'border-input hover:border-ring/60',
          disabled && 'bg-zinc-100 text-muted-foreground cursor-not-allowed hover:border-input',
          value === 0 && !disabled && 'text-muted-foreground',
        )}
        title={disabled ? disabledTitle : undefined}
      >
        <span className="truncate text-left">{buttonLabel}</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && !disabled && pos && createPortal(
        <div
          ref={popoverRef}
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top + 6,
            width: Math.max(pos.width, 240),
          }}
          className="z-[100] rounded-lg border bg-white shadow-lg py-1 max-h-64 overflow-y-auto scrollbar-transparent"
        >
          {!hideEmpty && (
            <>
              <button
                type="button"
                onClick={() => { onChange(0); setOpen(false) }}
                className={cn(
                  'w-full px-3 py-2 text-left text-sm italic transition-colors flex items-center justify-between cursor-pointer',
                  value === 0 ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:bg-zinc-100',
                )}
              >
                <span>{emptyLabel}</span>
              </button>
              {options.length > 0 && <div className="my-1 border-t" />}
            </>
          )}
          {options.map((o) => {
            const active = o.id === value
            const descLines = o.description?.split('\n').map((l) => l.trim()).filter(Boolean) ?? []
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => { onChange(o.id); setOpen(false) }}
                className={cn(
                  'w-full flex flex-col items-stretch gap-0.5 px-3 py-2 text-left text-sm transition-colors cursor-pointer',
                  active ? 'bg-accent/10 text-accent' : 'hover:bg-zinc-100',
                )}
              >
                <div className="flex items-center justify-between gap-3 min-w-0">
                  <span className="font-medium truncate">{o.primary}</span>
                  {o.secondary && (
                    <span className="text-xs text-muted-foreground truncate flex-shrink-0">{o.secondary}</span>
                  )}
                </div>
                {descLines.length > 0 && (
                  <div className="flex flex-col text-[11px] text-muted-foreground leading-snug">
                    {descLines.map((line, i) => (
                      <span key={i} className="truncate">{line}</span>
                    ))}
                  </div>
                )}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}

// ── SearchableCombobox (generic typed-search dropdown) ──

export interface SearchableComboboxProps<T> {
  options: T[]
  value: number
  onChange: (id: number) => void
  getId: (item: T) => number
  /** Primary line (e.g. reference, client name). */
  getPrimary: (item: T) => string
  /** Secondary line shown right of the primary (e.g. designation). */
  getSecondary?: (item: T) => string | null | undefined
  disabled?: boolean
  loading?: boolean
  placeholder: string
  /** `'sm'` matches the compact right-panel KV row (h-7, right-aligned, capped width). */
  size?: 'default' | 'sm'
}

export function SearchableCombobox<T>({
  options, value, onChange, getId, getPrimary, getSecondary, disabled, loading, placeholder, size = 'default',
}: SearchableComboboxProps<T>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)

  const selectedLabel = useMemo(() => {
    const sel = options.find((o) => getId(o) === value)
    if (!sel) return ''
    const primary = getPrimary(sel) || ''
    const secondary = getSecondary?.(sel) || ''
    return secondary ? `${primary} — ${secondary}` : primary
  }, [options, value, getId, getPrimary, getSecondary])

  useEffect(() => {
    if (disabled) {
      setOpen(false)
      setQuery('')
    }
  }, [disabled])
  useEffect(() => {
    if (value === 0) setQuery('')
  }, [value])

  const reposition = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: r.left, top: r.bottom, width: r.width })
  }, [])
  useEffect(() => {
    if (!open) return
    reposition()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (inputRef.current?.contains(t)) return
      if (popoverRef.current?.contains(t)) return
      setOpen(false)
    }
    const onScroll = (e: Event) => {
      if (popoverRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, reposition])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => {
      const hay = `${getPrimary(o) ?? ''} ${getSecondary?.(o) ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [options, query, getPrimary, getSecondary])

  const displayValue = open ? query : selectedLabel

  const isSm = size === 'sm'
  return (
    <div className={cn('relative inline-block align-middle', isSm ? 'w-[220px]' : 'w-full')}>
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        onFocus={() => { if (!disabled) setOpen(true) }}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          if (value !== 0) onChange(0)
        }}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          'w-full rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring cursor-text',
          isSm ? 'h-7 px-2 text-sm text-right' : 'h-9 px-3 text-sm',
          disabled && 'bg-zinc-100 text-muted-foreground cursor-not-allowed',
        )}
      />
      {open && !disabled && pos && createPortal(
        <div
          ref={popoverRef}
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top + 6,
            width: Math.max(pos.width, 260),
          }}
          className="z-[100] max-h-64 overflow-y-auto rounded-lg border bg-white shadow-lg scrollbar-transparent"
        >
          {loading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Chargement…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground italic">
              {options.length === 0 ? placeholder : 'Aucun résultat'}
            </div>
          ) : (
            filtered.map((o) => {
              const id = getId(o)
              const active = id === value
              const primary = getPrimary(o) || '—'
              const secondary = getSecondary?.(o)
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    onChange(id)
                    setQuery('')
                    setOpen(false)
                    inputRef.current?.blur()
                  }}
                  className={cn(
                    'w-full flex items-start gap-2 px-3 py-2 text-left text-sm transition-colors cursor-pointer',
                    active ? 'bg-accent/10 text-accent' : 'hover:bg-zinc-100',
                  )}
                >
                  <span className="font-medium">{primary}</span>
                  {secondary && (
                    <span className="text-xs text-muted-foreground truncate">
                      {secondary}
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
