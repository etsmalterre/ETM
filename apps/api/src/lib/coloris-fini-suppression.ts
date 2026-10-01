// Deleting a dyed coloris of a fini reference (Finis › Références › Coloris).
//
// LIVA #1254 — Pierrot's request, 2026-10-01: an étude accepted on sample /1, then on /2
// once the client changed its mind, leaves the /1 coloris behind — and it is
// offered in every coloris picker from then on. The legacy let him delete it
// from the Référence › Coloris tab; ETM had no delete at all. Decision Vincent:
//   - a dedicated key `delete_coloris_fini`, closed by default;
//   - only a coloris NOTHING uses: a roll, an order / devis / sst line, a
//     client designation or contract, a lot follow-up, an étude… — any of
//     these makes it history, and it stays (409 listing what holds it);
//   - the étude is never deleted with it: an étude pointing at the coloris
//     is one of the blockers.
// Only the dyed catalog (`ref_fini_colori`). A wash-only fini shows the écru's
// coloris (`colori_ecru`), which belong to Tombé Métier, not to this screen.
//
// Every id below is polymorphic (CLAUDE.md « Per-table polymorphism »), so a
// usage is matched on the fini reference AND the coloris wherever the table
// carries both. A colliding id from another catalog can only over-block —
// the safe side. Two tables are deliberately not consulted:
//   - `tarif_coloris`: dead since 2022 (last `date_calcul`), its ids mix
//     three catalogs and no ETM screen reads it;
//   - `code_sp`: keyed by the coloris NAME without the sample number, so it
//     belongs to every sample of the colour, not to this row.
//
// Native PostgreSQL (lib/mps-pg.ts): the check and the DELETE run in one
// transaction on a locked row, so nothing can attach to the coloris between.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'

export interface UsageColoris {
  /** What holds the coloris, plural French label (« Rouleaux finis »). */
  quoi: string
  n: number
  /** A few identifiers to find them (order numbers, roll numbers…). */
  exemples: string[]
}

const EXEMPLES_MAX = 5

/** French sentence listing what holds a coloris. Pure. */
export function messageUsages(usages: UsageColoris[]): string {
  const parts = usages.map((u) => {
    const ex = u.exemples.length > 0
      ? ` (${u.exemples.join(', ')}${u.n > u.exemples.length ? '…' : ''})`
      : ''
    return `${u.quoi} : ${u.n}${ex}`
  })
  return `Ce coloris est utilisé — ${parts.join(' ; ')}. Il fait partie de l’historique et ne peut pas être supprimé.`
}

const distinctStr = (v: unknown[]) =>
  Array.from(new Set(v.map((x) => String(x ?? '').trim()).filter((x) => x !== '' && x !== '0')))

/** Everything that holds coloris `idColoris` of fini reference `idRefFini`.
 *  `ignorerEtude` leaves one étude out (the re-acceptance of that étude is
 *  replacing its own coloris). Empty = free to delete. */
export async function usagesColorisFini(
  idRefFini: number,
  idColoris: number,
  opts: { ignorerEtude?: number; sql?: Sql } = {},
): Promise<UsageColoris[]> {
  const s = opts.sql ?? mpsPg()
  const ignorer = opts.ignorerEtude ?? 0
  const out: UsageColoris[] = []
  const add = (quoi: string, n: number, exemples: unknown[] = []) => {
    if (n > 0) out.push({ quoi, n, exemples: distinctStr(exemples).slice(0, EXEMPLES_MAX) })
  }

  const rouleaux = await s<{ numero: string | null }[]>`
    SELECT numero FROM stock_fini
    WHERE idref_fini = ${idRefFini} AND idcoloris = ${idColoris}
    ORDER BY idstock_fini DESC`
  add('Rouleaux finis', rouleaux.length, rouleaux.map((r) => r.numero))

  const cmd = await s<{ numero: number | null }[]>`
    SELECT c.numero FROM ligne_commande_client l
    JOIN commande_client c ON c.idcommande_client = l.idcommande_client
    WHERE l.idreference = ${idRefFini} AND l.idcolori = ${idColoris}
    ORDER BY c.idcommande_client DESC`
  add('Lignes de commande client', cmd.length, cmd.map((r) => r.numero && `N° ${r.numero}`))

  const devis = await s<{ numero: number | null }[]>`
    SELECT d.numero FROM ligne_devis_etm l
    JOIN devis_etm d ON d.iddevis_etm = l.iddevis_etm
    WHERE l.idreference = ${idRefFini} AND l.idcolori = ${idColoris}
    ORDER BY d.iddevis_etm DESC`
  add('Lignes de devis', devis.length, devis.map((r) => r.numero && `N° ${r.numero}`))

  // sst type 2 = fini line (lib/sst-line-kind.ts).
  const sst = await s<{ idcommande_sous_traitant: number }[]>`
    SELECT idcommande_sous_traitant FROM ligne_commande_sous_traitant
    WHERE type = 2 AND idreference = ${idRefFini} AND idcoloris = ${idColoris}
    ORDER BY idcommande_sous_traitant DESC`
  add('Lignes de commande sous-traitant', sst.length, sst.map((r) => `N° ${r.idcommande_sous_traitant}`))

  const lots = await s<{ lot: string | null }[]>`
    SELECT lot FROM suivilot
    WHERE idref_fini_colori = ${idColoris}
       OR (idref_fini = ${idRefFini} AND idcoloris = ${idColoris})`
  add('Suivis de lot', lots.length, lots.map((r) => r.lot))

  const desig = await s<{ designation: string | null }[]>`
    SELECT d.designation FROM ref_client_colori r
    LEFT JOIN designation_client d ON d.iddesignation_client = r.iddesignation_client
    WHERE r.idref_fini_colori = ${idColoris}`
  add('Désignations / contrats client', desig.length, desig.map((r) => r.designation))

  const etudes = await s<{ libelle: string | null }[]>`
    SELECT libelle FROM etude_col
    WHERE idref_fini_colori = ${idColoris} AND idetude_col <> ${ignorer}`
  add('Études coloris', etudes.length, etudes.map((r) => r.libelle))

  const [gammes] = await s<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM colori_fini WHERE idref_fini_colori = ${idColoris}`
  add('Gammes de coloris', Number(gammes?.n) || 0)

  const [photos] = await s<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM photo_produit
    WHERE idref_fini = ${idRefFini} AND idcoloris = ${idColoris}`
  add('Photos produit', Number(photos?.n) || 0)

  const [mentions] = await s<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM mention_qualite
    WHERE idreference = ${idRefFini} AND idcoloris = ${idColoris}`
  add('Mentions qualité', Number(mentions?.n) || 0)

  const [minis] = await s<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM stock_mini
    WHERE idreference = ${idRefFini} AND idcoloris = ${idColoris}`
  add('Stocks minimum', Number(minis?.n) || 0)

  const [confection] = await s<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM textile_ligne_cmd_confection
    WHERE idref_fini = ${idRefFini} AND idcoloris = ${idColoris}`
  add('Lignes de confection', Number(confection?.n) || 0)

  return out
}

export class ColorisIntrouvable extends Error {}
export class ColorisUtilise extends Error {
  constructor(public usages: UsageColoris[]) {
    super(messageUsages(usages))
  }
}

/** Delete an unused dyed coloris. Throws ColorisIntrouvable when the row is
 *  not a coloris of that reference, ColorisUtilise when anything holds it.
 *  Returns the deleted label. */
export async function supprimerColorisFini(idRefFini: number, idColoris: number): Promise<string> {
  return mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    const rows = await tx<{ reference: string | null }[]>`
      SELECT reference FROM ref_fini_colori
      WHERE idref_fini_colori = ${idColoris} AND idref_fini = ${idRefFini}
      FOR UPDATE`
    if (rows.length === 0) throw new ColorisIntrouvable()
    const usages = await usagesColorisFini(idRefFini, idColoris, { sql: tx })
    if (usages.length > 0) throw new ColorisUtilise(usages)
    await tx`DELETE FROM ref_fini_colori WHERE idref_fini_colori = ${idColoris}`
    return (rows[0].reference ?? '').trim()
  }) as Promise<string>
}

// ── Re-accepting an étude on another sample ────────────────────────────────
//
// Accepting an étude creates « <libellé>/<échantillon> » as a new coloris and
// points the étude at it. Accepting it again on another sample used to create
// a SECOND coloris (and a libellé « …/1/2 »), leaving the first one behind —
// the very row Pierrot then asked to delete. When the étude's current coloris
// is its own earlier acceptance (same label as the étude) and nothing else
// holds it, the re-acceptance renames it instead.

/** The libellé an acceptance on `sample` gives: the earlier acceptance's
 *  « /n » suffix is replaced, never stacked, when the étude was already
 *  accepted (`dejaAccepte`). Pure. */
export function libelleAcceptation(libelle: string, sample: string, dejaAccepte: boolean): string {
  const base = dejaAccepte ? libelle.replace(/\s*\/\s*\d+\s*$/, '') : libelle
  const suffix = `/${sample}`
  return base.endsWith(suffix) ? base : `${base}${suffix}`
}
