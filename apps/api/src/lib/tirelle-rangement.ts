// The lab's shelf of tirelles, against the database (LIVA #1380): search a
// stored tirelle, read the boxes, empty one. Rules and the shelf itself:
// lib/tirelle-boites.ts.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { clientsDesLotsLabo } from './tirelle-labo.js'
import { noterLot, type ParLot } from './journal-lot.js'
import { BOITES, RECHERCHE_MAX, RECHERCHE_MIN, correspond, lireBoite, termesRecherche, type EtatBoite } from './tirelle-boites.js'

// ── Reads ────────────────────────────────────────────────

export interface TirelleTrouvee {
  idsuivilot: number
  lot: string
  reception: string | null
  reference: string
  coloris: string
  sous_traitant: string
  /** Who the lot is for, by name (empty = stock). */
  clients: string[]
  /** The box holding square + tirelle. */
  boite: string
  /** After a reprise: the tirelle is still in its box, to be thrown. */
  a_jeter: boolean
}

interface LotRange {
  idsuivilot: string
  lot: string | null
  reception: string | null
  reference: string | null
  coloris: string | null
  emplacement: string | null
  sst: string | null
  ligne_sst: string | null
  cmd_sst: string | null
  a_jeter: boolean | null
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** The stored tirelles matching a search, or the content of one box, most
 *  recent reception first. ⚠️ Only lots IN A BOX: a lot without one is not
 *  shown at all (Vincent 2026-11-18: « si ce n'est pas là, ce n'est pas là »),
 *  which also hides everything noted before the boxes (« Carton », « 0 »). */
export async function chercherTirelles(
  opts: { q?: string; boite?: string },
  sql: Sql = mpsPg(),
): Promise<{ lots: TirelleTrouvee[]; total: number }> {
  const boite = opts.boite ? lireBoite(opts.boite) : null
  const termes = boite ? [] : termesRecherche(opts.q ?? '')
  if (!boite && termes.join('').length < RECHERCHE_MIN) return { lots: [], total: 0 }

  // ~6 000 lots: read them all and match in JS, accents folded (no `unaccent`
  // on the server). A coloris name lives in ref_fini_colori for a dyed fini,
  // in colori_ecru for a wash-only one (#1158).
  const rows = await sql<LotRange[]>`
    SELECT s.idsuivilot, trim(s.lot::text) AS lot, to_char(s.date, 'YYYY-MM-DD') AS reception,
           trim(rf.reference::text) AS reference,
           CASE WHEN COALESCE(rf.avec_teinture, 0) > 0 THEN trim(rfc.reference::text) ELSE trim(ce.reference::text) END AS coloris,
           trim(s.emplacement_tirelle::text) AS emplacement, st.nom::text AS sst,
           COALESCE(s.idligne_commande_sous_traitant, 0) AS ligne_sst, COALESCE(l.idcommande_sous_traitant, 0) AS cmd_sst,
           (t.a_jeter_depuis IS NOT NULL) AS a_jeter
    FROM suivilot s
    LEFT JOIN ligne_commande_sous_traitant l ON l.idligne_commande_sous_traitant = s.idligne_commande_sous_traitant
    LEFT JOIN ref_fini rf ON rf.idref_fini = COALESCE(NULLIF(s.idref_fini, 0), l.idreference, 0)
    LEFT JOIN ref_fini_colori rfc ON rfc.idref_fini_colori = s.idref_fini_colori
    LEFT JOIN colori_ecru ce ON ce.idcolori_ecru = s.idcoloris
    LEFT JOIN sous_traitant st ON st.idsous_traitant = s.idsous_traitant
    LEFT JOIN tirelle_labo t ON t.idsuivilot = s.idsuivilot
    ORDER BY s.date DESC NULLS LAST, s.idsuivilot DESC`

  const trouves = rows
    .flatMap((r) => {
      const b = lireBoite(r.emplacement ?? '')
      return b ? [{ r, boite: b }] : []
    })
    .filter(({ r, boite: b }) => (boite
      ? b === boite
      : correspond({ lot: r.lot ?? '', reference: r.reference ?? '', coloris: r.coloris ?? '' }, termes)))
  const page = boite ? trouves : trouves.slice(0, RECHERCHE_MAX)

  const clients = await clientsDesLotsLabo(page.map(({ r }) => ({
    id: Number(r.idsuivilot), ligne: num(r.ligne_sst), lot: r.lot ?? '', commande: num(r.cmd_sst),
  })), sql)

  return {
    total: trouves.length,
    lots: page.map(({ r, boite: b }) => ({
      idsuivilot: Number(r.idsuivilot),
      lot: r.lot ?? '',
      reception: r.reception,
      reference: r.reference ?? '',
      coloris: r.coloris ?? '',
      sous_traitant: (r.sst ?? '').trim(),
      clients: clients.get(Number(r.idsuivilot)) ?? [],
      boite: b,
      a_jeter: !!r.a_jeter,
    })),
  }
}

/** The 48 boxes with what each holds. */
export async function lireBoites(sql: Sql = mpsPg()): Promise<EtatBoite[]> {
  // Dated by the lots' RECEPTION, not by the day they were stored: a box filled
  // from a PC (Qualité › Suivi lots, the 2026-11 tidy-up) has no storing date.
  const rows = await sql<{ emplacement: string | null; range_le: string | null }[]>`
    SELECT trim(s.emplacement_tirelle::text) AS emplacement, to_char(s.date, 'YYYY-MM-DD') AS range_le
    FROM suivilot s
    WHERE length(trim(COALESCE(s.emplacement_tirelle::text, ''))) BETWEEN 2 AND 6`
  const par = new Map<string, EtatBoite>(BOITES.map((b) => [b, { boite: b, n: 0, du: null, au: null }]))
  for (const r of rows) {
    const b = lireBoite(r.emplacement ?? '')
    const e = b ? par.get(b) : undefined
    if (!e) continue
    e.n += 1
    if (r.range_le) {
      if (!e.du || r.range_le < e.du) e.du = r.range_le
      if (!e.au || r.range_le > e.au) e.au = r.range_le
    }
  }
  return BOITES.map((b) => par.get(b)!)
}

// ── Write ────────────────────────────────────────────────

export class RefusBoite extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message) }
}

/** Empty a box: its tirelles are thrown away, so its lots lose their location.
 *  Nothing else of the lot changes (measures, lab state). */
export async function viderBoite(v: unknown, par: ParLot | null): Promise<{ boite: string; lots: string[] }> {
  const boite = lireBoite(v)
  if (!boite) throw new RefusBoite('boite_inconnue', 'Cette boîte n’existe pas (A1 à F8).', 404)
  const vides = await mpsPg()<{ idsuivilot: string; lot: string | null }[]>`
    UPDATE suivilot SET emplacement_tirelle = ''
    WHERE upper(regexp_replace(COALESCE(emplacement_tirelle::text, ''), '[[:space:]]', '', 'g')) = ${boite}
    RETURNING idsuivilot, trim(lot::text) AS lot`
  if (vides.length === 0) throw new RefusBoite('boite_vide', `La boîte ${boite} est déjà vide.`)
  for (const l of vides) {
    await noterLot({ idsuivilot: Number(l.idsuivilot), evenement: 'tirelle_boite_videe', detail: `Boîte ${boite} vidée`, par })
  }
  return { boite, lots: vides.map((l) => l.lot ?? '').filter(Boolean) }
}
