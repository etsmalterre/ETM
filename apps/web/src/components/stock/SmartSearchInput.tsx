import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// Field-scoped search chips — the toolbar search of the table-centric stock
// screens (FinisStock, DiversStock, …). A chip restricts its term to ONE
// column — the fix for "searching BD matches location BD but also every lot
// containing bd". While typing, a suggestion popover offers one entry per
// field below; picking one converts the typed term into a chip. Chips
// AND-combine with each other and with the remaining free text.

export interface SearchFieldDef<K extends string> {
  key: K
  label: string
}

/** A single active search criterion. field=null → match any column. */
export interface SearchChip<K extends string = string> {
  field: K | null
  value: string
}

/** Apply the chips to a row set: each chip ANDs, restricted to its column
 *  (field=null chips match any column, like a locked-in free term). */
export function filterRowsByChips<T, K extends Extract<keyof T, string>>(
  rows: T[],
  chips: SearchChip<K>[],
  haystacks: (row: T) => string[],
): T[] {
  let out = rows
  for (const chip of chips) {
    const v = chip.value.toLowerCase()
    out = out.filter((r) => {
      if (chip.field) {
        const cell = r[chip.field]
        return typeof cell === 'string' && cell.toLowerCase().includes(v)
      }
      return haystacks(r).some((h) => h.includes(v))
    })
  }
  return out
}

export function SmartSearchInput<K extends string>({
  value,
  onValueChange,
  chips,
  onChipsChange,
  fields,
  placeholder,
  chipPlaceholder = 'Ajouter un critère…',
  className,
}: {
  value: string
  onValueChange: (v: string) => void
  chips: SearchChip<K>[]
  onChipsChange: (chips: SearchChip<K>[]) => void
  fields: readonly SearchFieldDef<K>[]
  placeholder: string
  chipPlaceholder?: string
  className?: string
}) {
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [suggestIdx, setSuggestIdx] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const fieldLabel = useCallback(
    (key: K) => fields.find((f) => f.key === key)?.label ?? key,
    [fields],
  )

  // Close the suggestion popover on any outside click.
  useEffect(() => {
    if (!suggestOpen) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setSuggestOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [suggestOpen])

  // Convert the currently-typed term into a chip (field=null → any column).
  const addChip = useCallback(
    (field: K | null) => {
      const v = value.trim()
      if (!v) return
      onChipsChange([...chips, { field, value: v }])
      onValueChange('')
      setSuggestOpen(false)
      setSuggestIdx(0)
      inputRef.current?.focus()
    },
    [value, chips, onChipsChange, onValueChange],
  )

  const removeChip = useCallback(
    (idx: number) => {
      onChipsChange(chips.filter((_, i) => i !== idx))
    },
    [chips, onChipsChange],
  )

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      {/* top-2.5 (not top-1/2) so the icon stays on the first row when chips wrap */}
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
      {/* The wrapper is the single focus indicator (thin ring); the inner
          input suppresses the app-wide :focus-visible gold ring, which
          otherwise draws a second ring inside this one. */}
      <div
        className="min-h-9 w-full pl-8 pr-3 py-[3px] rounded-md border border-input bg-white flex flex-wrap items-center gap-1 cursor-text focus-within:ring-1 focus-within:ring-ring"
        onClick={() => inputRef.current?.focus()}
      >
        {chips.map((c, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-0.5 pl-2 pr-0.5 py-0.5 rounded bg-zinc-100 border border-border/60 text-xs max-w-full"
          >
            <span className="truncate">
              {c.field ? (
                <>
                  <span className="text-muted-foreground">{fieldLabel(c.field)} : </span>
                  <span className="font-medium text-foreground">{c.value}</span>
                </>
              ) : (
                <span className="font-medium text-foreground">{c.value}</span>
              )}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                removeChip(i)
              }}
              className="rounded-sm p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-colors"
              title="Retirer ce critère"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value)
            setSuggestOpen(e.target.value.trim().length > 0)
            setSuggestIdx(0)
          }}
          onFocus={() => {
            if (value.trim()) setSuggestOpen(true)
          }}
          onKeyDown={(e) => {
            const count = fields.length + 1
            if (suggestOpen && value.trim()) {
              // 'Down'/'Up' are the legacy names some environments emit
              if (e.key === 'ArrowDown' || e.key === 'Down') {
                e.preventDefault()
                setSuggestIdx((i) => (i + 1) % count)
                return
              }
              if (e.key === 'ArrowUp' || e.key === 'Up') {
                e.preventDefault()
                setSuggestIdx((i) => (i - 1 + count) % count)
                return
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                addChip(suggestIdx === 0 ? null : fields[suggestIdx - 1].key)
                return
              }
              if (e.key === 'Escape') {
                setSuggestOpen(false)
                return
              }
            }
            if (e.key === 'Backspace' && value === '' && chips.length > 0) {
              removeChip(chips.length - 1)
            }
          }}
          placeholder={chips.length > 0 ? chipPlaceholder : placeholder}
          className="flex-1 min-w-[140px] h-7 text-sm bg-transparent focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      </div>

      {/* Suggestion popover — one row per scoped field, "toutes les colonnes" first */}
      {suggestOpen && value.trim() !== '' && (
        <div className="absolute left-0 right-0 top-full mt-1 z-40 rounded-md border border-border/60 bg-white shadow-lg overflow-hidden">
          <div className="max-h-64 overflow-y-auto py-1 scrollbar-transparent">
            <button
              type="button"
              onClick={() => addChip(null)}
              onMouseEnter={() => setSuggestIdx(0)}
              className={cn(
                'w-full px-3 py-1.5 text-sm text-left transition-colors flex items-center gap-1.5',
                suggestIdx === 0 ? 'bg-accent/10 text-accent' : 'hover:bg-zinc-100',
              )}
            >
              <Search className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
              <span className="truncate">« {value.trim()} » — toutes les colonnes</span>
            </button>
            {fields.map((f, i) => (
              <button
                key={f.key}
                type="button"
                onClick={() => addChip(f.key)}
                onMouseEnter={() => setSuggestIdx(i + 1)}
                className={cn(
                  'w-full px-3 py-1.5 text-sm text-left transition-colors truncate',
                  suggestIdx === i + 1 ? 'bg-accent/10 text-accent' : 'hover:bg-zinc-100',
                )}
              >
                <span className="text-muted-foreground">{f.label} :</span> {value.trim()}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
