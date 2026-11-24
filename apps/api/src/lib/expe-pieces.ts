// Expe: the pieces an avis carries, for the drawer of the screen « Transports »
// (repo expe, pages/Transports.tsx). Read-only: the avis is built in ETM
// (Clients › Expéditions), Expe only shows what travels.
//
//   - avis d'expédition: its rolls, grouped by the order line they ship
//     (ligne_expedition). A roll is on the avis when stock_fini.IDligne_expedition
//     or stock_ecru.IDligne_expedition_ETM names one of its lines, the same fact
//     as the count on the transport (lib/expe-departs.ts).
//   - avis divers: its cartons and the articles packed in each. No price:
//     Expe follows the movement, not the invoice.
//
// A transport leaves from ONE place (lib/expe-transports.ts): when the caller
// names it, only the rolls sitting there are listed, so the drawer shows the
// same rolls as the transport counts.
//
// Rows are loaded by routes/expeditions.ts (loadPiecesAvis), which owns the
// labels of a line and of a roll. This file only shapes them.

export interface RouleauPiece {
  id: number
  kind: 'ecru' | 'fini'
  numero: string | null
  lot: string | null
  poids: number
  metrage: number
  coloris_reference: string | null
  second_choix: boolean
}

/** A roll as read, before it is filed under its line. */
export interface RouleauBrut extends RouleauPiece {
  idligne_expedition: number
  /** 0 = the factory, else the sous-traitant holding the roll. */
  idmagasin: number
}

export interface LigneBrute {
  idligne_expedition: number
  ref_label: string | null
  colori_reference: string | null
}

export interface LignePieces extends LigneBrute {
  rouleaux: RouleauPiece[]
  poids: number
  metrage: number
}

export interface ArticleCarton {
  id: number
  label: string
  variations: string
  quantite: number
  unite: number
  unite_label: string
}

export interface CartonPieces {
  id: number
  /** The carton's free text, one entry per line typed. */
  detail: string[]
  articles: ArticleCarton[]
}

export interface PiecesAvis {
  kind: 'formelle' | 'divers'
  id: number
  lignes: LignePieces[]
  cartons: CartonPieces[]
}

/** The place asked by the client: a magasin id (0 = the factory), or null
 *  when none is named (every roll of the avis). */
export function lireLieu(brut: unknown): number | null {
  if (brut === undefined || brut === null || String(brut).trim() === '') return null
  const n = Number(brut)
  return Number.isInteger(n) && n >= 0 ? n : null
}

const arrondi = (x: number) => Math.round(x * 1000) / 1000

/** The rolls of an avis under the order line they ship, in the order of the
 *  lines. A line without any roll (here, or at the place asked) is left out. */
export function grouperRouleaux(
  lignes: readonly LigneBrute[],
  rouleaux: readonly RouleauBrut[],
  lieu: number | null = null,
): LignePieces[] {
  const parLigne = new Map<number, RouleauPiece[]>()
  for (const r of rouleaux) {
    if (lieu !== null && r.idmagasin !== lieu) continue
    const { idligne_expedition, idmagasin: _idmagasin, ...piece } = r
    const liste = parLigne.get(idligne_expedition) ?? []
    liste.push(piece)
    parLigne.set(idligne_expedition, liste)
  }
  const out: LignePieces[] = []
  for (const l of lignes) {
    const liste = parLigne.get(l.idligne_expedition)
    if (!liste || liste.length === 0) continue
    liste.sort((a, b) => (a.numero ?? '').localeCompare(b.numero ?? '', 'fr', { numeric: true }) || a.id - b.id)
    out.push({
      ...l,
      rouleaux: liste,
      poids: arrondi(liste.reduce((s, r) => s + r.poids, 0)),
      metrage: arrondi(liste.reduce((s, r) => s + r.metrage, 0)),
    })
  }
  return out
}

/** The free text of a carton as lines, blank ones dropped. */
export function lignesDetail(detail: string | null | undefined): string[] {
  return String(detail ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

/** An article of a carton: the text typed on it wins over the catalogue name
 *  (as Clients › Expéditions prints it). */
export function libelleArticle(designation: string | null | undefined, refDesignation: string | null | undefined, idRef: number): string {
  return String(designation ?? '').trim() || String(refDesignation ?? '').trim() || `Réf #${idRef}`
}
