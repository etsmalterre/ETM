import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// Field-scoped search chips — the toolbar search of the table-centric stock
// screens (FinisStock, DiversStock, …). A chip restricts its term to ONE
// column — the fix for "searching BD matches location BD but also every lot
// containing bd". While typing, a suggestion popover offers one entry per
// field below; picking one converts the typed term into a chip. Chips
// AND-combine with each other and with the remaining free text.
//
// Optional TAGS (Clients › Commandes): predefined filters drawn as the real
// pills of the screen. The popover lists them on focus, before anything is
// typed; typing narrows them by label (accents ignored). A picked tag becomes
// a pill inside the bar, left of the text; tags AND-combine too. Without the
// `tags` prop the widget behaves exactly as before.

export interface SearchTagDef<T> {
  key: string
  label: string
  /** The tag drawn as the screen's own pill; `trailing` (the remove cross in
   *  the bar) goes inside it. */
  renderPill: (trailing?: ReactNode) => ReactNode
  /** Rows carrying the tag, shown in the popover (0 = not offered). */
  count: number
  predicate: (row: T) => boolean
}

/** Lowercased, accent-free: « exp » finds « Prête à expédier » and « Expédiée ». */
export function foldSearchText(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** Tags whose label contains the typed term (accents ignored); empty term = all. */
export function matchTags<T>(tags: readonly SearchTagDef<T>[], term: string): SearchTagDef<T>[] {
  const t = foldSearchText(term.trim())
  return t ? tags.filter((tag) => foldSearchText(tag.label).includes(t)) : [...tags]
}

/** Keep the rows carrying EVERY active tag (AND). An unknown key filters nothing. */
export function filterRowsByTags<T>(rows: T[], activeKeys: readonly string[], tags: readonly SearchTagDef<T>[]): T[] {
  const preds = activeKeys
    .map((k) => tags.find((t) => t.key === k)?.predicate)
    .filter((p): p is (row: T) => boolean => !!p)
  return preds.length === 0 ? rows : rows.filter((r) => preds.every((p) => p(r)))
}

type Suggestion<K extends string> = { kind: 'tag'; key: string } | { kind: 'field'; field: K | null }

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

const NO_CHIPS: never[] = []
const NO_FIELDS: never[] = []
const NO_TAGS: never[] = []

export function SmartSearchInput<K extends string, T = unknown>({
  value,
  onValueChange,
  chips = NO_CHIPS,
  onChipsChange,
  fields = NO_FIELDS,
  tags = NO_TAGS,
  activeTags = NO_TAGS,
  onActiveTagsChange,
  placeholder,
  chipPlaceholder = 'Ajouter un critère…',
  className,
}: {
  value: string
  onValueChange: (v: string) => void
  chips?: SearchChip<K>[]
  onChipsChange?: (chips: SearchChip<K>[]) => void
  fields?: readonly SearchFieldDef<K>[]
  /** Predefined filters (see the header comment); omitted = no tags. */
  tags?: readonly SearchTagDef<T>[]
  activeTags?: readonly string[]
  onActiveTagsChange?: (keys: string[]) => void
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

  const activeTagDefs = useMemo(
    () => activeTags.map((k) => tags.find((t) => t.key === k)).filter((t): t is SearchTagDef<T> => !!t),
    [activeTags, tags],
  )

  // Popover rows: the matching tags not yet picked (offered only when some row
  // carries them), then (once a term is typed) the field-scoped chips.
  const suggestions = useMemo<Suggestion<K>[]>(() => {
    const out: Suggestion<K>[] = matchTags(tags, value)
      .filter((t) => t.count > 0 && !activeTags.includes(t.key))
      .map((t) => ({ kind: 'tag' as const, key: t.key }))
    if (value.trim() && fields.length > 0) {
      out.push({ kind: 'field', field: null }, ...fields.map((f) => ({ kind: 'field' as const, field: f.key })))
    }
    return out
  }, [tags, activeTags, value, fields])
  const popoverVisible = suggestOpen && suggestions.length > 0
  const idx = Math.min(suggestIdx, Math.max(0, suggestions.length - 1))

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
      onChipsChange?.([...chips, { field, value: v }])
      onValueChange('')
      setSuggestOpen(false)
      setSuggestIdx(0)
      inputRef.current?.focus()
    },
    [value, chips, onChipsChange, onValueChange],
  )

  const removeChip = useCallback(
    (i: number) => {
      onChipsChange?.(chips.filter((_, j) => j !== i))
    },
    [chips, onChipsChange],
  )

  // A picked tag consumes the term typed to find it.
  const addTag = useCallback(
    (key: string) => {
      onActiveTagsChange?.([...activeTags, key])
      onValueChange('')
      setSuggestIdx(0)
      inputRef.current?.focus()
    },
    [activeTags, onActiveTagsChange, onValueChange],
  )

  const removeTag = useCallback(
    (key: string) => {
      onActiveTagsChange?.(activeTags.filter((k) => k !== key))
    },
    [activeTags, onActiveTagsChange],
  )

  const pick = (sug: Suggestion<K>) => {
    if (sug.kind === 'tag') addTag(sug.key)
    else addChip(sug.field)
  }

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
        {activeTagDefs.map((t) => (
          <span key={t.key} className="inline-flex max-w-full">
            {t.renderPill(
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  removeTag(t.key)
                  inputRef.current?.focus()
                }}
                className="-mr-1 ml-0.5 rounded-full p-0.5 opacity-70 hover:opacity-100 hover:bg-black/10 transition-colors"
                title="Retirer ce filtre"
              >
                <X className="h-2.5 w-2.5" />
              </button>,
            )}
          </span>
        ))}
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
            // the tags show on an empty bar too; the field rows need a term
            setSuggestOpen(tags.length > 0 || e.target.value.trim().length > 0)
            setSuggestIdx(0)
          }}
          onFocus={() => {
            if (tags.length > 0 || value.trim()) setSuggestOpen(true)
          }}
          // a click in the already-focused bar reopens the tags after Escape or a pick
          onClick={() => {
            if (tags.length > 0) setSuggestOpen(true)
          }}
          onKeyDown={(e) => {
            const count = suggestions.length
            if (popoverVisible) {
              // 'Down'/'Up' are the legacy names some environments emit
              if (e.key === 'ArrowDown' || e.key === 'Down') {
                e.preventDefault()
                setSuggestIdx((idx + 1) % count)
                return
              }
              if (e.key === 'ArrowUp' || e.key === 'Up') {
                e.preventDefault()
                setSuggestIdx((idx - 1 + count) % count)
                return
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                pick(suggestions[idx])
                return
              }
              if (e.key === 'Escape') {
                setSuggestOpen(false)
                return
              }
            }
            if (e.key === 'Backspace' && value === '') {
              // the last pill drawn goes first: chips sit right of the tags
              if (chips.length > 0) removeChip(chips.length - 1)
              else if (activeTagDefs.length > 0) removeTag(activeTagDefs[activeTagDefs.length - 1].key)
            }
          }}
          placeholder={chips.length > 0 || activeTagDefs.length > 0 ? chipPlaceholder : placeholder}
          className="flex-1 min-w-[140px] h-7 text-sm bg-transparent focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      </div>

      {/* Suggestion popover: tags first, then one row per scoped field ("toutes les colonnes" first) */}
      {popoverVisible && (
        <div className="absolute left-0 right-0 top-full mt-1 z-40 rounded-md border border-border/60 bg-white shadow-lg overflow-hidden">
          <div className="max-h-64 overflow-y-auto py-1 scrollbar-transparent">
            {suggestions.map((sug, i) => {
              const active = idx === i
              if (sug.kind === 'tag') {
                const tag = tags.find((t) => t.key === sug.key)!
                return (
                  <button
                    key={`tag:${sug.key}`}
                    type="button"
                    onClick={() => pick(sug)}
                    onMouseEnter={() => setSuggestIdx(i)}
                    className={cn(
                      'w-full px-3 py-1.5 text-sm text-left transition-colors flex items-center gap-2',
                      active ? 'bg-accent/10' : 'hover:bg-zinc-100',
                    )}
                  >
                    {tag.renderPill()}
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">{tag.count}</span>
                  </button>
                )
              }
              return sug.field === null ? (
                <button
                  key="field:*"
                  type="button"
                  onClick={() => pick(sug)}
                  onMouseEnter={() => setSuggestIdx(i)}
                  className={cn(
                    'w-full px-3 py-1.5 text-sm text-left transition-colors flex items-center gap-1.5',
                    active ? 'bg-accent/10 text-accent' : 'hover:bg-zinc-100',
                  )}
                >
                  <Search className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                  <span className="truncate">« {value.trim()} » — toutes les colonnes</span>
                </button>
              ) : (
                <button
                  key={`field:${sug.field}`}
                  type="button"
                  onClick={() => pick(sug)}
                  onMouseEnter={() => setSuggestIdx(i)}
                  className={cn(
                    'w-full px-3 py-1.5 text-sm text-left transition-colors truncate',
                    active ? 'bg-accent/10 text-accent' : 'hover:bg-zinc-100',
                  )}
                >
                  <span className="text-muted-foreground">{fieldLabel(sug.field)} :</span> {value.trim()}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
