// Spec tiles of the two Tombé Métier › Références modes (circulaire and
// rectiligne): the grammar of Finis › Références' Spécifications tab: an
// uppercase caption on top, the value big underneath.
// Imported RELATIVELY (TRM renders these screens through `@etm`).
import { cn } from '@/lib/utils'
import { fmtNum } from '@/lib/format'

export const tileInput = 'h-8 w-full px-2 text-sm tabular-nums rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'

/** A spec tile: uppercase caption on top, the value underneath. */
export function SpecTile({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-border/60 bg-zinc-100/80 px-3 py-2.5 min-w-0', className)}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  )
}

/** Read-mode single figure inside a SpecTile. */
export function TileValue({ value, unit, digits }: { value: number | null; unit?: string; digits?: number }) {
  if (value == null || value === 0) return <span className="text-2xl font-bold text-muted-foreground/60 leading-none">—</span>
  return (
    <span className="text-2xl font-bold tabular-nums leading-none">
      {fmtNum(value, digits ?? (Number.isInteger(value) ? 0 : 2))}
      {unit ? <span className="text-xs text-muted-foreground font-normal ml-1">{unit}</span> : null}
    </span>
  )
}

/** Read-mode text inside a SpecTile (names, not figures). */
export function TileText({ value }: { value: string | null | undefined }) {
  const v = value?.trim()
  return v
    ? <p className="text-sm font-semibold truncate" title={v}>{v}</p>
    : <p className="text-sm text-muted-foreground/60">—</p>
}

/** Full-width prose tile: multi-line text in view mode (hidden when empty),
 *  a textarea in edit mode. */
export function TextTile({ label, value, isEditing, draft, rows, onChange }: {
  label: string; value: string | null; isEditing: boolean; draft: string; rows: number; onChange: (v: string) => void
}) {
  if (!isEditing && !value?.trim()) return null
  return (
    <SpecTile label={label}>
      {isEditing ? (
        <textarea
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          className="w-full rounded-md border border-input bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
      ) : (
        <p className="text-sm whitespace-pre-line leading-snug">{value!.trim()}</p>
      )}
    </SpecTile>
  )
}

