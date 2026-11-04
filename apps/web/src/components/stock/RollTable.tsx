import type { ReactNode } from 'react'
import { Ban, Check, Minus } from 'lucide-react'
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'

// One way to show a list of rolls, everywhere (2026-11-04, LIVA #1347): the
// piece's type icon (fini = full, tombé de métier = hollow) then its numero,
// poids, métrage, lot, the screen's own columns, the notes as hover icons
// (components/stock/RollNoteIcons), the row's actions, and the roll's état as
// the LAST column, at the far right. Born in Clients › Commandes (Affectation
// drawer), shared with the Sous-traitants pieces drawer and the réception
// recap. A screen adds COLUMNS, never a fork. Nothing is ever truncated: each
// column takes its content's width and the table scrolls sideways when the
// panel is too narrow (decision Vincent 2026-11-04). Shift+click range
// selection is the caller's onToggle (mps_designer §44).

/** The tick of a selectable row (a span: the row itself is the click target). */
export function CaseACocher({ etat }: { etat: 'oui' | 'non' | 'partiel' }) {
  return (
    <span className={cn('inline-flex h-4 w-4 items-center justify-center rounded border transition-colors',
      etat === 'non' ? 'border-input bg-background' : 'border-accent bg-accent text-accent-foreground')}>
      {etat === 'oui' && <Check className="h-3 w-3" />}
      {etat === 'partiel' && <Minus className="h-3 w-3" />}
    </span>
  )
}

/** What every roll row carries. */
export interface RollTableRow {
  id: number
  numero: string | null
  lot: string | null
  poids: number | string | null
  metrage: number | string | null
}

export interface RollTableSelection<T> {
  selected: Set<number>
  /** shiftKey: the caller's §44 range handler. */
  onToggle: (id: number, shiftKey: boolean) => void
  /** Why a row cannot be picked (undefined = it can). */
  blockedReason?: (r: T) => string | undefined
  onToggleAll: () => void
  allTitle: string
}

/** A screen's own column, placed after Lot. */
export interface RollTableColumn<T> {
  key: string
  header: string
  align?: 'left' | 'right'
  cell: (r: T) => ReactNode
}

export function RollTable<T extends RollTableRow>({
  rolls, kind, selection, columns = [], numeroExtra, notes, action, etat, onRowClick, rowClassName,
}: {
  rolls: T[]
  kind: 'ecru' | 'fini'
  selection?: RollTableSelection<T>
  columns?: RollTableColumn<T>[]
  /** Small badges after the numero (reprise, hors réf, fusion, reçu). */
  numeroExtra?: (r: T) => ReactNode
  /** Hover icons (RollObservationsIcon / RollDefautsIcon …). */
  notes?: (r: T) => ReactNode
  action?: (r: T) => ReactNode
  /** The roll's état (EtatPill): the last column, at the far right. */
  etat?: (r: T) => ReactNode
  /** A click on a row that is not selectable. */
  onRowClick?: (r: T) => void
  rowClassName?: (r: T) => string | undefined
}) {
  const choisissables = selection ? rolls.filter((r) => !selection.blockedReason?.(r)) : []
  // A tombé de métier is weighed, not measured: no Métrage column unless a roll has one.
  const avecMetrage = kind === 'fini' || rolls.some((r) => Number(r.metrage) > 0)
  const nbCoches = choisissables.filter((r) => selection?.selected.has(r.id)).length
  const etatTout: 'oui' | 'non' | 'partiel' = nbCoches === 0 ? 'non' : nbCoches === choisissables.length ? 'oui' : 'partiel'
  const th = 'px-2.5 py-2 font-semibold whitespace-nowrap'
  const td = 'px-2.5 py-1.5 whitespace-nowrap'
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-x-auto scrollbar-transparent">
      <table className="w-full text-xs">
        <thead className="bg-primary/10 border-b border-primary/10">
          <tr className="text-[10px] uppercase tracking-wide text-primary/80">
            {selection && (
              <th className="px-2.5 py-2 text-center w-10">
                {choisissables.length > 0 && (
                  <button type="button" role="checkbox" aria-checked={etatTout === 'oui'} onClick={selection.onToggleAll}
                    title={etatTout === 'oui' ? 'Tout désélectionner' : selection.allTitle} className="inline-flex align-middle cursor-pointer">
                    <CaseACocher etat={etatTout} />
                  </button>
                )}
              </th>
            )}
            <th className={cn(th, 'text-left')}>Pièce</th>
            <th className={cn(th, 'text-right')}>Poids</th>
            {avecMetrage && <th className={cn(th, 'text-right')}>Métrage</th>}
            <th className={cn(th, 'pl-5 text-left')}>Lot</th>
            {columns.map((c) => (
              <th key={c.key} className={cn(th, c.align === 'right' ? 'text-right' : 'text-left')}>{c.header}</th>
            ))}
            {/* Takes the slack, so the état stays at the far right. */}
            <th className="px-2.5 py-2 w-full" />
            {etat && <th className={cn(th, 'text-left')}>État</th>}
          </tr>
        </thead>
        <tbody>
          {rolls.map((r) => {
            const bloque = selection?.blockedReason?.(r)
            const choisissable = !!selection && !bloque
            const coche = choisissable && selection!.selected.has(r.id)
            const cliquable = choisissable || !!onRowClick
            return (
              <tr key={r.id}
                onClick={choisissable ? (e) => selection!.onToggle(r.id, e.shiftKey) : onRowClick ? () => onRowClick(r) : undefined}
                className={cn('border-b border-border/40 last:border-0',
                  cliquable && 'cursor-pointer select-none',
                  coche ? 'bg-accent/10' : cliquable && 'hover:bg-accent/5',
                  rowClassName?.(r))}>
                {selection && (
                  <td className="px-2.5 py-1.5 text-center">
                    {choisissable ? <CaseACocher etat={coche ? 'oui' : 'non'} /> : bloque ? (
                      <span title={bloque} className="inline-flex h-4 w-4 items-center justify-center rounded border border-input bg-muted align-middle cursor-not-allowed">
                        <Ban className="h-2.5 w-2.5 text-muted-foreground/70" />
                      </span>
                    ) : null}
                  </td>
                )}
                <td className={td}>
                  <span className="flex items-center gap-2 font-medium tabular-nums">
                    <span title={kind === 'fini' ? 'Fini' : 'Tombé de métier'} className="inline-flex flex-shrink-0">
                      {kind === 'fini' ? <FiniRollIcon className="h-4 w-4 text-green-700" /> : <TmRollIcon className="h-4 w-4 text-muted-foreground" />}
                    </span>
                    <span>{r.numero || `Rouleau ${r.id}`}</span>
                    {numeroExtra?.(r)}
                  </span>
                </td>
                <td className={cn(td, 'text-right tabular-nums')}>{Number(r.poids) > 0 ? `${fmtNum(Number(r.poids), 1)} kg` : '—'}</td>
                {avecMetrage && <td className={cn(td, 'text-right tabular-nums')}>{Number(r.metrage) > 0 ? `${fmtNum(Number(r.metrage), 1)} Ml` : ''}</td>}
                <td className={cn(td, 'pl-5 text-muted-foreground')}>{r.lot || '—'}</td>
                {columns.map((c) => (
                  <td key={c.key} className={cn(td, c.align === 'right' && 'text-right')}>{c.cell(r)}</td>
                ))}
                <td className={td}>
                  <div className="flex items-center justify-end gap-1.5">
                    {notes?.(r)}
                    {action?.(r)}
                  </div>
                </td>
                {etat && <td className={td}>{etat(r)}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
