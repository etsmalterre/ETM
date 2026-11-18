// One step of a piece's provenance in a stock drawer (Finis › Stock, Tombé
// Métier › Stock): a yarn, the knitting, the dyeing. A leading icon, the step
// (a yarn reference, « Tricotage », « Ennoblissement »), then one line: who
// did it, and the order and the lot it came from as LINKS to their own screens
// (Vincent 2026-11-18: « mettre les liens vers les commandes, vers les lots »).
//
// One component for both screens. A piece of the chain without a screen to
// open (a lot number with no fiche) is printed as plain text, never a dead link.

import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

export interface LienProvenance {
  libelle: string
  /** Where it opens; absent = plain text. */
  to?: string | null
  /** The tooltip: where the link leads. */
  title?: string
}

export function ProvenanceRow({ icon, title, qui, liens = [] }: {
  icon: ReactNode
  title: string
  /** Who did the step: the supplier, the knitter, the dyer. */
  qui?: string | null
  liens?: ReadonlyArray<LienProvenance | null | false | undefined>
}) {
  const parts: ReactNode[] = []
  if (qui) parts.push(<span key="qui">{qui}</span>)
  liens.forEach((l, i) => {
    if (!l) return
    parts.push(l.to ? (
      <Link key={i} to={l.to} title={l.title} className="text-accent-blue hover:underline">{l.libelle}</Link>
    ) : (
      <span key={i}>{l.libelle}</span>
    ))
  })
  return (
    <div className="flex items-start gap-2">
      <span className="flex-shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{title}</p>
        {parts.length > 0 && (
          // Wraps rather than truncates: a link cut off by an ellipsis cannot be clicked.
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {parts.map((p, i) => (
              <Fragment key={i}>{i > 0 && <span aria-hidden> · </span>}{p}</Fragment>
            ))}
          </p>
        )}
      </div>
    </div>
  )
}

/** The links of the app's own objects, as the provenance rows open them. */
export const lienCommandeFil = (id: number | null | undefined): LienProvenance | null =>
  id ? { libelle: `Commande N° ${id}`, to: `/fils/commandes?commande=${id}`, title: 'Ouvrir la commande de fil' } : null

export const lienLotFil = (l: { IDstock_fil: number; lot: string }): LienProvenance =>
  ({ libelle: `Lot ${l.lot}`, to: `/fils/stock?lot=${l.IDstock_fil}`, title: 'Ouvrir le lot de fil dans Fils › Stock' })

/** A sous-traitant order: the redirect picks Ennoblissement or Tricotage by the sous-traitant's type. */
export const lienCommandeSst = (id: number | null | undefined): LienProvenance | null =>
  id ? { libelle: `Commande N° ${id}`, to: `/sous-traitants/commandes?commande=${id}`, title: 'Ouvrir la commande du sous-traitant' } : null

/** A dyer's lot: its fiche in Qualité › Suivi lots when it has one, plain text otherwise. */
export const lienLot = (lot: string | null | undefined, idsuivilot: number | null | undefined): LienProvenance | null =>
  lot ? {
    libelle: `Lot ${lot}`,
    to: idsuivilot ? `/qualite/suivi-lots?lot=${idsuivilot}&statut=tous` : null,
    title: 'Ouvrir la fiche du lot dans Qualité › Suivi lots',
  } : null
