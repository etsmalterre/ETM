// The lab tablet « Tirelle » (apps/tirelle, routes/tirelle.ts, 2026-11-03):
// Laetitia's controls of the tirelles, done in the lab instead of on a PC.
//
// What happens to a lot's tirelle, physically (Vincent, 2026-11-03):
//   - the dyer's carton of tirelles arrives with the lot (the dyer's own
//     controls come by mail and are typed in ETM, not here);
//   - BEFORE THE WASH: she cuts a round and a 50 × 50 cm square (lot written on
//     it) out of each tirelle, weighs the round, measures the laize, compares
//     the round with the « rond 0 » of the ref + coloris in the binder;
//   - the squares are washed and dried, as many at once as she likes;
//   - AFTER THE WASH: she measures stab H, stab L and vrillage on the square,
//     stores square + tirelle in a casier and marks the lot done.
// Two statuses only (Vincent, 2026-11-03: « pas besoin d'étapes ») — the
// machine and the dryer are not tracked, a lot simply waits in « après
// lavage » until it is done. The status moves on its own once the measures
// asked before the wash are given.
// A reprise (lib/reprises.ts) erases every control of the lot and puts it back
// on the tablet as « à jeter »: round, square and tirelle go to the bin, the
// reworked lot will bring a new tirelle.
//
// The measures live where they always did, on suivilot (*_tirelle,
// coloris_tirelle, emplacement_tirelle) — Qualité › Suivi lots reads and edits
// the same columns. `tirelle_labo` (migration 0057) only holds « done » and the
// bin run. What is ASKED stays the reference's (lib/controles-lot.ts) and the
// coloris rule stays lib/coloris-lot.ts.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import {
  CONTROLES_PAR_DEFAUT,
  controlesDeRef,
  mesuresManquantes,
  type ControlesRef,
  type MesuresDemandees,
} from './controles-lot.js'
import { colorisAControler, rondsZero, rondZeroDe, lireVerdictColoris, type VerdictColoris } from './coloris-lot.js'
import { horsBornes, horsRetrait } from './analyse-qualite.js'
import { VRILLAGE_MAX, lireSaisieVrillage, VrillageInvalide } from './vrillage.js'
import { lireSaisieStab, StabInvalide, valeurStab } from './stabilites.js'

// ── The steps (pure) ─────────────────────────────────────

export type EtapeLabo = 'a_jeter' | 'avant_lavage' | 'apres_lavage'

export const ORDRE_ETAPES: EtapeLabo[] = ['a_jeter', 'avant_lavage', 'apres_lavage']

export const LIBELLE_ETAPE: Record<EtapeLabo, string> = {
  a_jeter: 'À jeter',
  avant_lavage: 'Contrôles avant lavage',
  apres_lavage: 'Contrôles après lavage',
}

export interface LaboRow {
  termine_le: string | null
  a_jeter_depuis: string | null
  a_jeter_motif: string | null
  a_jeter_casier: string | null
}

export interface MesuresTirelle {
  laize: number
  poids: number
  /** NULL = not measured, 0 is a measure (#1358). */
  stabh: number | null
  stabl: number | null
  vrillage: number | null
  coloris: VerdictColoris | null
}

/** What is measured before the wash (on the round) / after it (on the square). */
export function demandesParPhase(d: MesuresDemandees, colorisDu: boolean): { rond: string[]; carre: string[] } {
  const rond: string[] = []
  if (d.laize) rond.push('laize')
  if (d.poids) rond.push('poids')
  if (colorisDu) rond.push('coloris')
  const carre: string[] = []
  if (d.stabilites) carre.push('stabilités')
  if (d.vrillage) carre.push('vrillage')
  return { rond, carre }
}

/** Where a lot stands in the lab, or null when the lab is done with it.
 *  `manque` = mesuresManquantes() of the Malterre side (the cycle's own list).
 *  Measures typed on a PC (Suivi lots) count: the tablet never asks twice. */
export function etapeLabo(f: {
  demandees: MesuresDemandees
  colorisDu: boolean
  manque: string[]
  labo: LaboRow | null
}): EtapeLabo | null {
  const { labo } = f
  if (labo?.a_jeter_depuis) return 'a_jeter'
  if (labo?.termine_le) return null
  const { rond } = demandesParPhase(f.demandees, f.colorisDu)
  if (rond.some((m) => f.manque.includes(m))) return 'avant_lavage'
  // Waits here, washed or not, until she marks it done (casier).
  return 'apres_lavage'
}

// ── Tolerances (Qualité › Analyse's rules) ───────────────

export interface Tolerances {
  laize: { min: number; max: number }
  poids: { min: number; max: number }
  /** Référentiel retraits (negative = shrinkage); null = none. */
  stabh: number | null
  stabl: number | null
  vrillageMax: number
}

export interface HorsTolerance {
  laize: boolean | null
  poids: boolean | null
  stabh: boolean | null
  stabl: boolean | null
  vrillage: boolean | null
  coloris: boolean | null
}

const pos = (v: number) => (v > 0 ? v : null)

export function horsTolerance(m: MesuresTirelle, t: Tolerances): HorsTolerance {
  return {
    laize: horsBornes(pos(m.laize), t.laize.min, t.laize.max),
    poids: horsBornes(pos(m.poids), t.poids.min, t.poids.max),
    stabh: horsRetrait(m.stabh, t.stabh),
    stabl: horsRetrait(m.stabl, t.stabl),
    vrillage: m.vrillage == null ? null : m.vrillage > t.vrillageMax,
    coloris: m.coloris == null ? null : m.coloris === 'ecart',
  }
}

// ── Reads ────────────────────────────────────────────────

export interface LotLabo {
  idsuivilot: number
  lot: string
  reception: string | null
  sous_traitant: string
  reference: string
  coloris: string
  etape: EtapeLabo
  /** The measures the reference asks of us, by phase. */
  demandes: { rond: string[]; carre: string[] }
  /** Still missing among them (mesuresManquantes). */
  manque: string[]
  mesures: MesuresTirelle
  tolerances: Tolerances
  hors: HorsTolerance
  /** The binder's reference round: null when the lot is not a dyed fini. */
  rond0: { lot: string; date: string | null; estCeLot: boolean } | null
  emplacement: string
  a_jeter: { depuis: string; motif: string; casier: string } | null
}

interface LotBrut {
  idsuivilot: string
  lot: string | null
  etat: string
  reception: string | null
  ref: string
  coloris_id: string
  idcoloris: string
  laize_tirelle: string | null
  poids_tirelle: string | null
  stabh_tirelle: string | null
  stabl_tirelle: string | null
  vrillage_tirelle: string | null
  coloris_tirelle: string | null
  emplacement: string | null
  stabh_demandee: string | null
  stabl_demandee: string | null
  sst: string | null
  labo_id: string | null
  termine_le: string | null
  a_jeter_depuis: string | null
  a_jeter_motif: string | null
  a_jeter_casier: string | null
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const ts = (v: unknown) => (v == null ? null : new Date(v as string).toISOString())

/** The lots that have something to do in the lab, or the given ones (any state,
 *  for the writes: `ids`). Ordered by reception, oldest first. */
export async function lireLotsLabo(opts: { ids?: number[] } = {}, sql: Sql = mpsPg()): Promise<LotLabo[]> {
  const ids = opts.ids?.filter((x) => x > 0)
  // In the queue: a lot received and still open (not in reprise, not validated),
  // or one the lab already holds and has not finished — or must throw away.
  const filtre = ids
    ? sql`s.idsuivilot = ANY(${ids})`
    : sql`((s.date IS NOT NULL AND COALESCE(s.idetatlot, 0) NOT IN (2, 3, 4))
           OR (t.idsuivilot IS NOT NULL AND (t.a_jeter_depuis IS NOT NULL
               OR (t.termine_le IS NULL AND COALESCE(s.idetatlot, 0) <> 2))))`
  const rows = await sql<LotBrut[]>`
    SELECT s.idsuivilot, trim(s.lot::text) AS lot, COALESCE(s.idetatlot, 0) AS etat,
           to_char(s.date, 'YYYY-MM-DD') AS reception,
           COALESCE(NULLIF(s.idref_fini, 0), l.idreference, 0) AS ref,
           COALESCE(s.idref_fini_colori, 0) AS coloris_id, COALESCE(s.idcoloris, 0) AS idcoloris,
           s.laize_tirelle, s.poids_tirelle, s.stabh_tirelle, s.stabl_tirelle, s.vrillage_tirelle, s.coloris_tirelle,
           trim(s.emplacement_tirelle::text) AS emplacement,
           s.stabh_demandee, s.stabl_demandee, st.nom::text AS sst,
           t.idsuivilot AS labo_id, t.termine_le, t.a_jeter_depuis, t.a_jeter_motif, t.a_jeter_casier
    FROM suivilot s
    LEFT JOIN ligne_commande_sous_traitant l ON l.idligne_commande_sous_traitant = s.idligne_commande_sous_traitant
    LEFT JOIN sous_traitant st ON st.idsous_traitant = s.idsous_traitant
    LEFT JOIN tirelle_labo t ON t.idsuivilot = s.idsuivilot
    WHERE ${filtre}
    ORDER BY s.date NULLS LAST, s.idsuivilot`
  if (rows.length === 0) return []

  const refIds = [...new Set(rows.map((r) => num(r.ref)).filter((x) => x > 0))]
  const refs = new Map<number, Record<string, unknown>>()
  if (refIds.length) {
    const rr = await sql<Record<string, unknown>[]>`
      SELECT idref_fini AS id, trim(reference::text) AS reference, COALESCE(avec_teinture, 0)::int AS avec_teinture,
        COALESCE(laizeht_min, 0)::float8 AS laize_min, COALESCE(laizeht_max, 0)::float8 AS laize_max,
        COALESCE(poids_min, 0)::float8 AS poids_min, COALESCE(poids_max, 0)::float8 AS poids_max,
        COALESCE(stab_hauteur, 0)::float8 AS stab_hauteur, COALESCE(stab_largeur, 0)::float8 AS stab_largeur,
        controle_ennoblisseur, controle_malterre,
        controle_ennoblisseur_laize, controle_ennoblisseur_poids, controle_ennoblisseur_stab, controle_ennoblisseur_vrillage,
        controle_malterre_laize, controle_malterre_poids, controle_malterre_stab, controle_malterre_vrillage
      FROM ref_fini WHERE idref_fini = ANY(${refIds})`
    for (const r of rr) refs.set(Number(r.id), r)
  }
  const teinte = (ref: number) => num(refs.get(ref)?.avec_teinture)

  // Coloris names: a dyed fini's in ref_fini_colori, a wash-only fini's in colori_ecru (#1158).
  const finiCol = [...new Set(rows.filter((r) => teinte(num(r.ref)) > 0).map((r) => num(r.coloris_id)).filter((x) => x > 0))]
  const ecruCol = [...new Set(rows.filter((r) => teinte(num(r.ref)) === 0).map((r) => num(r.idcoloris)).filter((x) => x > 0))]
  const [nomsFini, nomsEcru] = await Promise.all([
    finiCol.length ? sql<{ id: number; nom: string | null }[]>`SELECT idref_fini_colori AS id, trim(reference::text) AS nom FROM ref_fini_colori WHERE idref_fini_colori = ANY(${finiCol})` : [],
    ecruCol.length ? sql<{ id: number; nom: string | null }[]>`SELECT idcolori_ecru AS id, trim(reference::text) AS nom FROM colori_ecru WHERE idcolori_ecru = ANY(${ecruCol})` : [],
  ])
  const nomFini = new Map(nomsFini.map((r) => [Number(r.id), r.nom ?? '']))
  const nomEcru = new Map(nomsEcru.map((r) => [Number(r.id), r.nom ?? '']))

  const rond0 = await rondsZero(rows.map((r) => ({ ref: num(r.ref), coloris: num(r.coloris_id) })))

  const out: LotLabo[] = []
  for (const r of rows) {
    const id = Number(r.idsuivilot)
    const ref = num(r.ref)
    const fiche = refs.get(ref)
    const controles: ControlesRef = fiche ? controlesDeRef(fiche) : CONTROLES_PAR_DEFAUT
    const labo: LaboRow | null = r.labo_id != null
      ? {
          termine_le: ts(r.termine_le),
          a_jeter_depuis: ts(r.a_jeter_depuis),
          a_jeter_motif: r.a_jeter_motif,
          a_jeter_casier: r.a_jeter_casier,
        }
      : null
    // A reference « sans contrôle Malterre » asks nothing of the lab (except a bin run).
    if (!controles.malterre && !labo?.a_jeter_depuis) continue
    const colorisId = num(r.coloris_id)
    const r0 = rondZeroDe(rond0, ref, colorisId)
    const avecTeinture = teinte(ref)
    const mesures: MesuresTirelle = {
      laize: num(r.laize_tirelle),
      poids: num(r.poids_tirelle),
      stabh: valeurStab(r.stabh_tirelle),
      stabl: valeurStab(r.stabl_tirelle),
      vrillage: r.vrillage_tirelle == null ? null : num(r.vrillage_tirelle),
      coloris: lireVerdictColoris(r.coloris_tirelle),
    }
    const colorisDu = controles.malterre && colorisAControler(avecTeinture, id, r0)
    const demandees = controles.mesures.malterre
    const manque = mesuresManquantes(
      { laize: mesures.laize, poids: mesures.poids, stabH: mesures.stabh, stabL: mesures.stabl, vrillage: mesures.vrillage, colorisManquant: colorisDu && !mesures.coloris },
      demandees,
    )
    const etape = etapeLabo({ demandees, colorisDu, manque, labo })
    if (!etape) continue
    // Nothing asked missing and the lab never touched it: done on a PC, not ours.
    if (manque.length === 0 && !labo) continue
    const stabRef = (lotV: unknown, ficheV: unknown) => {
      const v = num(lotV) !== 0 ? num(lotV) : num(ficheV)
      return v !== 0 ? v : null
    }
    const tolerances: Tolerances = {
      laize: { min: num(fiche?.laize_min), max: num(fiche?.laize_max) },
      poids: { min: num(fiche?.poids_min), max: num(fiche?.poids_max) },
      stabh: stabRef(r.stabh_demandee, fiche?.stab_hauteur),
      stabl: stabRef(r.stabl_demandee, fiche?.stab_largeur),
      vrillageMax: VRILLAGE_MAX,
    }
    out.push({
      idsuivilot: id,
      lot: r.lot ?? '',
      reception: r.reception,
      sous_traitant: (r.sst ?? '').trim(),
      reference: String(fiche?.reference ?? ''),
      coloris: avecTeinture > 0 ? nomFini.get(colorisId) ?? '' : nomEcru.get(num(r.idcoloris)) ?? '',
      etape,
      demandes: demandesParPhase(demandees, colorisDu),
      manque,
      mesures,
      tolerances,
      hors: horsTolerance(mesures, tolerances),
      rond0: avecTeinture > 0 && r0 ? { lot: r0.lot, date: r0.date, estCeLot: r0.idsuivilot === id } : null,
      emplacement: (r.emplacement ?? '').trim(),
      a_jeter: labo?.a_jeter_depuis
        ? { depuis: labo.a_jeter_depuis, motif: labo.a_jeter_motif ?? '', casier: labo.a_jeter_casier ?? '' }
        : null,
    })
  }
  return out
}

// ── Writes ───────────────────────────────────────────────

export class RefusLabo extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message) }
}

async function lotOuRefus(id: number, sql: Sql = mpsPg()): Promise<LotLabo> {
  const [l] = await lireLotsLabo({ ids: [id] }, sql)
  if (!l) throw new RefusLabo('lot_inconnu', 'Ce lot n’est plus dans le labo.', 404)
  return l
}

/** A typed decimal (« 155 », « 155,5 »), null when empty. */
function lireNombre(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim().replace(',', '.')
  if (s === '') return null
  const x = Number(s)
  if (!Number.isFinite(x)) throw new RefusLabo('nombre_invalide', `« ${String(v)} » n’est pas un nombre.`, 400)
  return x
}

function borner(x: number | null, min: number, max: number, libelle: string): number | null {
  if (x === null) return null
  if (x < min || x > max) throw new RefusLabo('valeur_hors_limites', `${libelle} : ${x} est hors des limites (${min} à ${max}).`, 400)
  return Math.round(x * 10) / 10
}

async function toucherLabo(sql: Sql, id: number): Promise<void> {
  await sql`INSERT INTO tirelle_labo (idsuivilot) VALUES (${id}) ON CONFLICT (idsuivilot) DO NOTHING`
}

/** Before the wash (on the round): laize, poids, coloris vs the rond 0. Every
 *  measure the reference asks here is required; a later call corrects them.
 *  Once given, the lot moves to « après lavage » on its own. An écart of
 *  coloris carries its why into the lot's observations, like on Suivi lots. */
export async function enregistrerAvantLavage(id: number, b: { laize?: unknown; poids?: unknown; coloris?: unknown; note?: unknown }): Promise<LotLabo | null> {
  const l = await lotOuRefus(id)
  if (l.etape === 'a_jeter') throw new RefusLabo('lot_a_jeter', 'Ce lot est parti en reprise : jetez d’abord son rond, son carré et sa tirelle.')
  const laize = borner(lireNombre(b.laize), 10, 400, 'Laize')
  const poids = borner(lireNombre(b.poids), 10, 2000, 'Poids')
  const coloris = b.coloris === undefined || b.coloris === null || b.coloris === '' ? null : lireVerdictColoris(b.coloris)
  if (b.coloris && !coloris) throw new RefusLabo('coloris_invalide', 'Coloris : conforme ou écart.', 400)
  const manque: string[] = []
  if (l.demandes.rond.includes('laize') && !laize) manque.push('la laize')
  if (l.demandes.rond.includes('poids') && !poids) manque.push('le poids')
  if (l.demandes.rond.includes('coloris') && !coloris) manque.push('le coloris')
  if (manque.length) throw new RefusLabo('mesure_manquante', `Il manque ${manque.join(', ')}.`, 400)
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : ''

  await mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql
    await tx`UPDATE suivilot SET
        laize_tirelle = ${laize ?? l.mesures.laize}, poids_tirelle = ${poids ?? l.mesures.poids},
        coloris_tirelle = ${coloris ?? l.mesures.coloris}
      WHERE idsuivilot = ${id}`
    if (coloris === 'ecart' && note) {
      await tx`UPDATE suivilot SET observations = trim(both E'\n' from COALESCE(observations::text, '') || E'\n' || ${`Écart coloris (tirelle) : ${note}`})
        WHERE idsuivilot = ${id}`
    }
    await toucherLabo(tx, id)
  })
  return (await lireLotsLabo({ ids: [id] }))[0] ?? null
}

export const CASIER_MAX = 40

/** After the wash (on the square): stab H, stab L, vrillage, and the casier
 *  where square and tirelle are stored. One gesture: the lab is done with the
 *  lot. Values already on the lot (typed on a PC) may be left as they are. */
export async function terminerApresLavage(id: number, b: { stabh?: unknown; stabl?: unknown; vrillage?: unknown; casier?: unknown }): Promise<void> {
  const l = await lotOuRefus(id)
  if (l.etape !== 'apres_lavage') {
    throw new RefusLabo('avant_lavage_incomplet', l.etape === 'a_jeter'
      ? 'Ce lot est parti en reprise : jetez d’abord son rond, son carré et sa tirelle.'
      : 'Finissez d’abord les contrôles avant lavage (laize, poids, coloris).')
  }
  let stabh: number | null
  let stabl: number | null
  try {
    stabh = lireSaisieStab('stabh_tirelle', b.stabh, 'Stab H')
    stabl = lireSaisieStab('stabl_tirelle', b.stabl, 'Stab L')
  } catch (e) {
    if (e instanceof StabInvalide) throw new RefusLabo('valeur_hors_limites', e.message, 400)
    throw e
  }
  let vrillage: number | null
  try {
    vrillage = lireSaisieVrillage('vrillage_tirelle', b.vrillage)
  } catch (e) {
    if (e instanceof VrillageInvalide) throw new RefusLabo('vrillage_invalide', e.message, 400)
    throw e
  }
  const casier = typeof b.casier === 'string' ? b.casier.trim().slice(0, CASIER_MAX) : ''
  const manque: string[] = []
  // 0 / 0 is an ultra-stable matter, a real measure (#1358). A value already on
  // the lot (typed on a PC) stands for the one left empty.
  if (l.demandes.carre.includes('stabilités') && ((stabh ?? l.mesures.stabh) === null || (stabl ?? l.mesures.stabl) === null)) {
    manque.push('les deux stabilités')
  }
  if (l.demandes.carre.includes('vrillage') && vrillage === null) manque.push('le vrillage')
  if (!casier) manque.push('le casier')
  if (manque.length) throw new RefusLabo('mesure_manquante', `Il manque ${manque.join(', ')}.`, 400)

  await mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql
    await tx`UPDATE suivilot SET
        stabh_tirelle = ${stabh ?? l.mesures.stabh}, stabl_tirelle = ${stabl ?? l.mesures.stabl},
        vrillage_tirelle = ${vrillage ?? l.mesures.vrillage}, emplacement_tirelle = ${casier}
      WHERE idsuivilot = ${id}`
    await toucherLabo(tx, id)
    await tx`UPDATE tirelle_labo SET termine_le = now(), maj_le = now() WHERE idsuivilot = ${id}`
  })
}

/** After a reprise: round, square and tirelle are in the bin. */
export async function marquerJete(id: number): Promise<void> {
  const rows = await mpsPg()<{ n: number }[]>`
    UPDATE tirelle_labo SET a_jeter_depuis = NULL, jete_le = now(), maj_le = now()
    WHERE idsuivilot = ${id} AND a_jeter_depuis IS NOT NULL RETURNING 1 AS n`
  if (rows.length === 0) throw new RefusLabo('rien_a_jeter', 'Rien à jeter pour ce lot.')
}

// ── Reprise (called by lib/reprises.ts, inside its transaction) ───

/** The measures a reprise erases: the dyer's AND ours (decision Vincent
 *  2026-11-03: the reworked lot is controlled again from scratch). The values
 *  before are kept in `reprise.lot_avant`. */
export async function effacerControlesPourReprise(tx: Sql, ligneId: number, lot: string, motif: string): Promise<void> {
  const lots = await tx<{ idsuivilot: number; recu: boolean; emplacement: string | null }[]>`
    SELECT idsuivilot, date IS NOT NULL AS recu, trim(emplacement_tirelle::text) AS emplacement
    FROM suivilot WHERE idligne_commande_sous_traitant = ${ligneId} AND trim(lot::text) = ${lot}`
  if (lots.length === 0) return
  const ids = lots.map((l) => Number(l.idsuivilot))
  await tx`UPDATE suivilot SET
      laize_sst = 0, poids_sst = 0, rendement_sst = 0, stabh_sst = NULL, stabl_sst = NULL, vrillage_sst = NULL,
      laize_tirelle = 0, poids_tirelle = 0, rendement_tirelle = 0, stabh_tirelle = NULL, stabl_tirelle = NULL,
      vrillage_tirelle = NULL, coloris_tirelle = NULL
    WHERE idsuivilot = ANY(${ids})`
  // The lab's material of a received lot goes to the bin; the reworked lot
  // comes back with a new tirelle and starts again at « rond ».
  for (const l of lots) {
    if (!l.recu) continue
    await tx`
      INSERT INTO tirelle_labo (idsuivilot, a_jeter_depuis, a_jeter_motif, a_jeter_casier)
      VALUES (${l.idsuivilot}, now(), ${motif}, ${l.emplacement ?? ''})
      ON CONFLICT (idsuivilot) DO UPDATE SET
        termine_le = NULL, jete_le = NULL,
        a_jeter_depuis = now(), a_jeter_motif = ${motif}, a_jeter_casier = ${l.emplacement ?? ''}, maj_le = now()`
  }
}

/** Where the lab stands on one lot, for Qualité › Suivi lots. null = nothing in the lab. */
export async function etatLaboDuLot(id: number): Promise<{ etape: EtapeLabo | null; libelle: string; termine_le: string | null } | null> {
  const [row] = await mpsPg()<{ termine_le: string | null }[]>`SELECT termine_le FROM tirelle_labo WHERE idsuivilot = ${id}`
  const [l] = await lireLotsLabo({ ids: [id] })
  if (!row && !l) return null
  if (l) return { etape: l.etape, libelle: LIBELLE_ETAPE[l.etape], termine_le: null }
  return row?.termine_le ? { etape: null, libelle: 'Terminé au labo', termine_le: ts(row.termine_le) } : null
}
