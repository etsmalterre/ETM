// A sous-traitant's own orders, as the espace partenaire (espace-partenaire-etsmalterre) shows them — read by
// GET /api/site/espace/partenaires/:id/commandes[/:idCommande[/bon-de-commande]] (routes/webservice-site.ts).
// The shapes are the portal's contract (its packages/api `CommandeResumeApi` / `CommandeDetailApi`), field for field.
//
// Same data and rules as Sous-traitants › Ennoblissement (routes/commandes-sous-traitant.ts, whose cycle
// lib/cycle-ennoblissement.ts is reused, never re-derived), with three differences:
//  - scoped to ONE sous-traitant: an order of another one is « not found », never an error that tells it exists;
//  - only the ennoblissement orders (a knitter has its own statuses, lib/sst-tricotage.ts: none here yet), and only
//    once the bon de commande was e-mailed (an `envoi_email` row of type 13): an order Malterre still prepares
//    (« À envoyer ») is never listed;
//  - only what the partner may see. Never add: prices and tariffs (line `prix`, the € total, pricing-sst), the
//    Malterre customer (its name, its order, the client line the matter is reserved to — `IDcommande_client`,
//    affectations), the order `commentaire` and `journal`, the LINE `commentaire`, the Journal tab's facts
//    (journal_commande_sst, journal_lot), relances and reports of a délai (who was chased, motif, imputable),
//    whose move a step is on Malterre's side or its chase date (`main`, `relance`, red / amber), Tricobot's
//    readings, the lot's measures and tolerances, roll numbers, the rapport de contrôle and which client a
//    soumission went to. The bon de commande PDF is the document Malterre e-mails: it carries what was sent
//    (the partner's own prices included) and nothing is added to it here.
//
// Steps. ETM's cycle says where an order and its lots stand AND whose move it is at Malterre; the partner is told
// where they stand for IT. Order (EtapeCommande of lib/cycle-ennoblissement.ts → the portal's):
//   non_envoye    → not listed (the bon de commande is not sent)
//   attente_delai → delai_a_donner
//   en_teinture   → en_traitement — or delai_a_donner while a line still to deliver has no délai: ETM asks it
//                   line by line too (the daily Point, « délai pas encore donné »)
//   en_controle   → en_controle when everything came back (no écru left at the partner, no lot in reprise);
//                   with a solde or a lot in reprise the partner still holds matter of the order: en_traitement
//                   (ETM prints « En contrôle » from the first lot received; the portal's step means « every
//                   line came back »)
//   a_cloturer    → terminee: every lot is validated and nothing is left at the partner. Closing the order is
//                   Malterre's bookkeeping, not a step of the partner's work
//   terminee      → terminee
// Lot (EtapeLot there → the portal's), before its reception:
//   coloris_soumis     → coloris_soumis
//   ok_ramer_a_envoyer → coloris_soumis: the client said yes but Malterre has not passed it on yet (the
//                        « coloris validé » mail). The partner learns it from Malterre, not ahead of it
//   en_rame            → coloris_valide (its move: finish the lot)
//   reteinture         → coloris_refuse (its move: dye again), with the client's reason
//   attente_mesures    → not listed: a lot row without anything asked, the line says « en traitement »
// …once received:
//   en_reprise         → en_reprise (its move), with the motif typed at « Reprendre »
//   valide             → valide
//   refuse_client      → en_controle: Malterre decides what becomes of it (a reprise shows as en_reprise)
//   any other step     → mesures_a_transmettre while the partner's own measures are missing (ETM asks them every
//                        day whatever else is in progress on the lot), else en_controle: Malterre's controls,
//                        soumissions, rapport de contrôle and validation are one step for the partner
// A closed order shows every lot « validé »: nothing is expected of the partner any more.
//
// Twelve sliding months (Vincent 2026-11-26): the space serves the work in progress, not the archive. A finished
// order leaves it — list, detail and bon de commande alike, « not found » — once it had no movement since the
// first day of the twelve sliding months (`debutDouzeMois`): its bon de commande was sent before and no lot of it
// came back since. An order that is not finished stays whatever its age. The window opens the same day as
// « Qualité de service » (lib/espace-partenaire-indicateurs.ts) and a lot's return is read from the same suivi
// lot rows, so every line shown there opens its order.

import { mpsPg } from './mps-pg.js'
import { consumedEcruIds } from './fini-sources.js'
import {
  etatCommande, etapeLot, lireCommandesEnnoblissement,
  type CommandeFait, type EtapeLot, type EtatCommande, type LotFait,
} from './cycle-ennoblissement.js'
import { ecruToutRevenu, ligneLivreeLe } from './ligne-sst-livree.js'
import { familleOfTypeSst } from './sst-tricotage.js'
import { urgencesLignes } from './urgence-sst.js'
import { buildCommandePdfData, renderCommandePdfBuffer } from '../routes/commandes-sous-traitant.js'

// ── Steps (pure, tested) ────────────────────────────────────

export type EtapeCommandePartenaire = 'delai_a_donner' | 'en_traitement' | 'en_controle' | 'terminee'
export type EtapeLignePartenaire = 'delai_a_donner' | 'en_traitement' | 'livree'
export type EtapeLotPartenaire =
  | 'coloris_soumis'
  | 'coloris_valide'
  | 'coloris_refuse'
  | 'mesures_a_transmettre'
  | 'en_controle'
  | 'en_reprise'
  | 'valide'

/** The lot steps where the next move is the partner's (the portal's A_VOUS_LOT). */
export const LOT_A_VOUS: ReadonlySet<EtapeLotPartenaire> = new Set(['coloris_valide', 'coloris_refuse', 'mesures_a_transmettre', 'en_reprise'])

/** ETM's order step as the partner reads it; null = not the partner's to see yet. `delaiManquant`: a line still to
 *  deliver has no délai. */
export function etapeCommandePartenaire(
  e: Pick<EtatCommande, 'etape' | 'solde' | 'enReprise'>,
  delaiManquant = false,
): EtapeCommandePartenaire | null {
  const chezLePartenaire: EtapeCommandePartenaire = delaiManquant ? 'delai_a_donner' : 'en_traitement'
  switch (e.etape) {
    case 'non_envoye': return null
    case 'attente_delai': return 'delai_a_donner'
    case 'en_teinture': return chezLePartenaire
    case 'en_controle': return e.solde || (e.enReprise?.length ?? 0) > 0 ? chezLePartenaire : 'en_controle'
    case 'a_cloturer': return 'terminee'
    case 'terminee': return 'terminee'
  }
}

/** ETM's lot step as the partner reads it; null = nothing to tell (the lot is not listed). */
export function etapeLotPartenaire(etape: EtapeLot, recu: boolean, mesuresTeinturier: boolean): EtapeLotPartenaire | null {
  if (etape === 'valide') return 'valide'
  if (etape === 'en_reprise') return 'en_reprise'
  if (!recu) {
    if (etape === 'coloris_soumis' || etape === 'ok_ramer_a_envoyer') return 'coloris_soumis'
    if (etape === 'en_rame') return 'coloris_valide'
    if (etape === 'reteinture') return 'coloris_refuse'
    return null
  }
  if (etape === 'refuse_client') return 'en_controle'
  return mesuresTeinturier ? 'en_controle' : 'mesures_a_transmettre'
}

export function etapeLignePartenaire(livree: boolean, delai: string | null): EtapeLignePartenaire {
  return livree ? 'livree' : delai ? 'en_traitement' : 'delai_a_donner'
}

// ── Shapes (the portal's contract) ──────────────────────────

export interface CommandeResume {
  /** The number printed on the bon de commande (IDcommande_sous_traitant). */
  id: number
  date: string | null
  /** Day the bon de commande was first e-mailed. */
  envoyeeLe: string | null
  etape: EtapeCommandePartenaire
  nbLignes: number
  lignesLivrees: number
  /** Earliest délai among the lines not delivered yet. */
  delai: string | null
  /** Σ lines, Ml ordered. */
  quantiteMl: number
  /** Σ écru handed over, kg. */
  poidsKg: number
  /** An urgency was asked on a line still to deliver. */
  urgente: boolean
  /** Lots whose next move is the partner's. */
  lotsAVous: number
  /** « REF - coloris » of each line. */
  articles: string[]
}

export interface Adresse {
  nom: string
  lignes: string[]
  cp: string
  ville: string
  pays: string
}

export interface LigneCommande {
  id: number
  reference: string
  coloris: string
  designation: string
  traitements: string[]
  consigne: string | null
  quantiteMl: number
  nbPieces: number
  poidsKg: number
  delai: string | null
  urgenceSouhaiteeLe: string | null
  recuMl: number
  livreeLe: string | null
  etape: EtapeLignePartenaire
}

export interface Lot {
  lot: string
  idLigne: number
  reference: string
  coloris: string
  etape: EtapeLotPartenaire
  recuLe: string | null
  nbRouleaux: number
  metrageMl: number
  motif: string | null
}

export interface CommandeDetail extends Omit<CommandeResume, 'articles'> {
  adresseLivraison: Adresse | null
  lignes: LigneCommande[]
  lots: Lot[]
}

// ── Reads (native PostgreSQL, flat, merged in JS) ───────────

const TYPE_DOC_BON = 13
const round1 = (v: number) => Math.round(v * 10) / 10
const str = (v: unknown) => String(v ?? '').trim()
/** A lot number as two tables may spell it (stock_fini / suivilot: case and spaces differ). */
const cleLot = (lot: string) => lot.trim().toUpperCase()
const isoYmd = (ymd: string | null) => (ymd && /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null)

function aujourdhui(): string {
  const t = new Date()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/** First day of the twelve sliding months ending with the current one (2026-11-24 → 2025-12-01). Pure. */
export function debutDouzeMois(aujourdhui: string): string {
  const d = new Date(Date.UTC(Number(aujourdhui.slice(0, 4)), Number(aujourdhui.slice(5, 7)) - 12, 1))
  return d.toISOString().slice(0, 10)
}

/** No movement in the twelve months: the bon de commande left before `depuis` and no lot came back since. Such an
 *  order is shown only while it is not finished. Pure. */
export function sansMouvementDepuis(envoyeeLe: string | null, recuDepuis: boolean, depuis: string): boolean {
  return !recuDepuis && (envoyeeLe ?? '') < depuis
}

/** True when the sous-traitant exists and its orders are ennoblissement ones (not a knitter's). */
async function estEnnoblisseur(idSousTraitant: number): Promise<boolean> {
  const rows = await mpsPg()<{ type: number }[]>`
    SELECT COALESCE(idtype_sst, 0) AS type FROM sous_traitant WHERE idsous_traitant = ${idSousTraitant}`
  return rows.length > 0 && familleOfTypeSst(Number(rows[0].type)) === 'ennoblissement'
}

interface Entete { id: number; date: string | null; soldee: boolean; idadresse: number; envoyee: string | null }

/** The partner's orders whose bon de commande was e-mailed, newest first. */
async function entetesEnvoyees(idSousTraitant: number, idCommande?: number): Promise<Entete[]> {
  const sql = mpsPg()
  const rows = await sql<{ id: number; date: string | null; soldee: number; idadresse: number; envoyee: string | null }[]>`
    SELECT c.idcommande_sous_traitant AS id, to_char(c.date_commande, 'YYYY-MM-DD') AS date,
           COALESCE(c.est_soldee, 0)::int AS soldee, COALESCE(c.idadresse_livraison, 0) AS idadresse,
           to_char(e.premier, 'YYYY-MM-DD') AS envoyee
    FROM commande_sous_traitant c
    JOIN (SELECT idreference, min(date) AS premier FROM envoi_email WHERE idtype_doc = ${TYPE_DOC_BON} GROUP BY idreference) e
      ON e.idreference = c.idcommande_sous_traitant
    WHERE c.idsous_traitant = ${idSousTraitant}
      ${idCommande ? sql`AND c.idcommande_sous_traitant = ${idCommande}` : sql``}
    ORDER BY c.idcommande_sous_traitant DESC`
  return rows.map((r) => ({ id: Number(r.id), date: r.date, soldee: Number(r.soldee) === 1, idadresse: Number(r.idadresse), envoyee: r.envoyee }))
}

/** Of these orders, the ones a lot of which came back since `depuis`: a suivi lot row dated since (what « Qualité
 *  de service » dates a line's first lot by), or a roll entered in stock since. */
async function recuesDepuis(cmdIds: number[], depuis: string): Promise<Set<number>> {
  if (cmdIds.length === 0) return new Set()
  const rows = await mpsPg()<{ cmd: number }[]>`
    SELECT DISTINCT l.idcommande_sous_traitant AS cmd
    FROM ligne_commande_sous_traitant l
    JOIN (SELECT idligne_commande_sous_traitant AS ligne FROM suivilot WHERE date >= ${depuis}::date
          UNION
          SELECT idref_commande_source AS ligne FROM stock_fini WHERE date_saisie >= ${depuis}::date) r
      ON r.ligne = l.idligne_commande_sous_traitant
    WHERE l.idcommande_sous_traitant = ANY(${cmdIds})`
  return new Set(rows.map((r) => Number(r.cmd)))
}

interface LigneRow { id: number; cmd: number; type: number; ref: number; coloris: number; quantite: number; delai: string | null; termine: boolean }

async function lignesDe(cmdIds: number[]): Promise<LigneRow[]> {
  if (cmdIds.length === 0) return []
  const rows = await mpsPg()<{ id: number; cmd: number; type: number; ref: number; coloris: number; quantite: number; delai: string | null; termine: boolean }[]>`
    SELECT idligne_commande_sous_traitant AS id, idcommande_sous_traitant AS cmd, COALESCE(type, 0)::int AS type,
           COALESCE(idreference, 0) AS ref, COALESCE(idcoloris, 0) AS coloris, COALESCE(quantite, 0)::float8 AS quantite,
           to_char(date_livraison, 'YYYY-MM-DD') AS delai, COALESCE(sstatut::text, '') LIKE 'Termin%' AS termine
    FROM ligne_commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})
    ORDER BY idligne_commande_sous_traitant`
  return rows.map((r) => ({
    id: Number(r.id), cmd: Number(r.cmd), type: Number(r.type), ref: Number(r.ref), coloris: Number(r.coloris),
    quantite: Number(r.quantite) || 0, delai: r.delai, termine: !!r.termine,
  }))
}

/** « REF » and coloris of each line. A dyer line (type 2) names a ref_fini; its coloris catalog depends on the
 *  reference (wash only → colori_ecru, dyed → ref_fini_colori, CLAUDE.md § polymorphism). */
async function libelles(lignes: LigneRow[]): Promise<Map<number, { reference: string; coloris: string }>> {
  const out = new Map<number, { reference: string; coloris: string }>()
  const refs = [...new Set(lignes.map((l) => l.ref).filter((x) => x > 0))]
  const cols = [...new Set(lignes.map((l) => l.coloris).filter((x) => x > 0))]
  const sql = mpsPg()
  type Nom = { id: number; nom: string | null }
  const aucun = Promise.resolve([] as Nom[])
  const [fini, ecru, colFini, colEcru] = await Promise.all([
    refs.length ? sql<(Nom & { teinture: number })[]>`
      SELECT idref_fini AS id, reference::text AS nom, COALESCE(avec_teinture, 0)::int AS teinture FROM ref_fini WHERE idref_fini = ANY(${refs})` : Promise.resolve([] as (Nom & { teinture: number })[]),
    refs.length ? sql<Nom[]>`SELECT idref_ecru AS id, reference::text AS nom FROM ref_ecru WHERE idref_ecru = ANY(${refs})` : aucun,
    cols.length ? sql<Nom[]>`SELECT idref_fini_colori AS id, reference::text AS nom FROM ref_fini_colori WHERE idref_fini_colori = ANY(${cols})` : aucun,
    cols.length ? sql<Nom[]>`SELECT idcolori_ecru AS id, reference::text AS nom FROM colori_ecru WHERE idcolori_ecru = ANY(${cols})` : aucun,
  ])
  const m = (rows: Nom[]) => new Map(rows.map((r) => [Number(r.id), str(r.nom)]))
  const [finiM, ecruM, colFiniM, colEcruM] = [m(fini), m(ecru), m(colFini), m(colEcru)]
  const teinture = new Map(fini.map((r) => [Number(r.id), Number(r.teinture)]))
  for (const l of lignes) {
    const fini2 = l.type === 2
    const reference = (fini2 ? finiM.get(l.ref) ?? ecruM.get(l.ref) : ecruM.get(l.ref) ?? finiM.get(l.ref)) ?? ''
    const teint = fini2 && (teinture.get(l.ref) ?? 1) !== 0
    const coloris = (teint ? colFiniM.get(l.coloris) ?? colEcruM.get(l.coloris) : colEcruM.get(l.coloris) ?? colFiniM.get(l.coloris)) ?? ''
    out.set(l.id, { reference, coloris })
  }
  return out
}

/** An article reads « REF - coloris » (CLAUDE.md § Conventions). */
export function article(reference: string, coloris: string): string {
  return [reference, coloris].map((s) => s.trim()).filter(Boolean).join(' - ')
}

/** « REF - coloris » of these order lines, by line id (the service figures name their lines). */
export async function articlesDesLignes(ligneIds: number[]): Promise<Map<number, string>> {
  const ids = [...new Set(ligneIds.filter((x) => x > 0))]
  if (ids.length === 0) return new Map()
  const rows = await mpsPg()<{ id: number; type: number; ref: number; coloris: number }[]>`
    SELECT idligne_commande_sous_traitant AS id, COALESCE(type, 0)::int AS type, COALESCE(idreference, 0) AS ref, COALESCE(idcoloris, 0) AS coloris
    FROM ligne_commande_sous_traitant WHERE idligne_commande_sous_traitant = ANY(${ids})`
  const lignes: LigneRow[] = rows.map((r) => ({ id: Number(r.id), cmd: 0, type: Number(r.type), ref: Number(r.ref), coloris: Number(r.coloris), quantite: 0, delai: null, termine: false }))
  const noms = await libelles(lignes)
  return new Map(lignes.map((l) => [l.id, article(noms.get(l.id)?.reference ?? '', noms.get(l.id)?.coloris ?? '')]))
}

/** Of these orders, the ones the partner can open: its own, bon de commande e-mailed. */
export async function commandesEnvoyees(idSousTraitant: number, cmdIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(cmdIds.filter((x) => x > 0))]
  if (ids.length === 0) return new Set()
  const rows = await mpsPg()<{ id: number }[]>`
    SELECT DISTINCT c.idcommande_sous_traitant AS id
    FROM commande_sous_traitant c JOIN envoi_email e ON e.idtype_doc = ${TYPE_DOC_BON} AND e.idreference = c.idcommande_sous_traitant
    WHERE c.idsous_traitant = ${idSousTraitant} AND c.idcommande_sous_traitant = ANY(${ids})`
  return new Set(rows.map((r) => Number(r.id)))
}

interface EcruLigne { nb: number; kg: number; ids: number[] }

/** The écru handed over per line (stock_ecru.IDref_commande_affectation — the pointer survives the dyeing):
 *  count and kg for every line, the piece ids only for `avecIds` (the lines whose return is still followed). */
async function ecruParLigne(ligneIds: number[], avecIds: number[]): Promise<Map<number, EcruLigne>> {
  const out = new Map<number, EcruLigne>()
  if (ligneIds.length === 0) return out
  const sql = mpsPg()
  const [sommes, pieces] = await Promise.all([
    sql<{ ligne: number; nb: number; kg: number }[]>`
      SELECT idref_commande_affectation AS ligne, count(*)::int AS nb, COALESCE(sum(poids), 0)::float8 AS kg
      FROM stock_ecru WHERE idref_commande_affectation = ANY(${ligneIds}) GROUP BY 1`,
    avecIds.length === 0 ? Promise.resolve([] as { ligne: number; id: number }[]) : sql<{ ligne: number; id: number }[]>`
      SELECT idref_commande_affectation AS ligne, idstock_ecru AS id
      FROM stock_ecru WHERE idref_commande_affectation = ANY(${avecIds})`,
  ])
  for (const r of sommes) out.set(Number(r.ligne), { nb: Number(r.nb), kg: Number(r.kg) || 0, ids: [] })
  for (const r of pieces) out.get(Number(r.ligne))?.ids.push(Number(r.id))
  return out
}

interface FiniRow { ligne: number; lot: string; metrage: number; jour: string | null }

/** The rolls received back per line (stock_fini.IDref_commande_source). No roll number, no measure. */
async function finiParLigne(ligneIds: number[]): Promise<Map<number, FiniRow[]>> {
  const out = new Map<number, FiniRow[]>()
  if (ligneIds.length === 0) return out
  const rows = await mpsPg()<{ ligne: number; lot: string | null; metrage: number; jour: string | null }[]>`
    SELECT idref_commande_source AS ligne, lot::text AS lot, COALESCE(metrage, 0)::float8 AS metrage,
           to_char(date_saisie, 'YYYYMMDD') AS jour
    FROM stock_fini WHERE idref_commande_source = ANY(${ligneIds})`
  for (const r of rows) {
    const arr = out.get(Number(r.ligne)) ?? []
    arr.push({ ligne: Number(r.ligne), lot: str(r.lot), metrage: Number(r.metrage) || 0, jour: r.jour })
    out.set(Number(r.ligne), arr)
  }
  return out
}

// ── Assembly ────────────────────────────────────────────────

interface LotVu { fait: LotFait; idLigne: number; etape: EtapeLotPartenaire }

/** The lots of an order the partner is told about, each on its line, with its step. A lot known only from an old
 *  soumission mail carries no line (LotFait.idligne 0): it is placed on the order's line when it has only one. */
export function lotsVus(lots: readonly LotFait[], ligneIds: readonly number[], terminee: boolean): LotVu[] {
  const out: LotVu[] = []
  for (const fait of lots) {
    const idLigne = fait.idligne && ligneIds.includes(fait.idligne) ? fait.idligne : ligneIds.length === 1 ? ligneIds[0] : 0
    if (!idLigne) continue
    const etape = terminee && fait.reception ? 'valide' : etapeLotPartenaire(etapeLot(fait), !!fait.reception, fait.mesuresTeinturier)
    if (!etape || (terminee && etape !== 'valide')) continue
    out.push({ fait, idLigne, etape })
  }
  return out.sort((a, b) => a.idLigne - b.idLigne || a.fait.lot.localeCompare(b.fait.lot, 'fr', { numeric: true }))
}

interface LigneVue {
  row: LigneRow
  livree: boolean
  /** YYYY-MM-DD the last piece came back, once all did. */
  livreeLe: string | null
  enReprise: boolean
  ecru: EcruLigne
}

/** Where each line of an order stands. `revenus`: the écru ids that came back dyed. */
function lignesVues(
  lignes: LigneRow[],
  terminee: boolean,
  ecru: Map<number, EcruLigne>,
  revenus: ReadonlySet<number>,
  lots: readonly LotVu[],
  fini?: Map<number, FiniRow[]>,
): LigneVue[] {
  const enReprise = new Set(lots.filter((l) => l.etape === 'en_reprise').map((l) => l.idLigne))
  return lignes.map((row) => {
    const e = ecru.get(row.id) ?? { nb: 0, kg: 0, ids: [] }
    const nbRevenus = e.ids.filter((id) => revenus.has(id)).length
    const receptions = (fini?.get(row.id) ?? []).map((f) => f.jour ?? '')
    // A lot back at the partner for a reprise reopens its line, as ETM does (LIVA #1377).
    const reprise = !terminee && enReprise.has(row.id)
    const livree = terminee || row.termine || (!reprise && ecruToutRevenu(e.nb, nbRevenus))
    const jour = reprise ? null : terminee || row.termine
      ? receptions.filter(Boolean).sort().at(-1) ?? null
      : ligneLivreeLe(e.nb, nbRevenus, receptions)
    return { row, livree, livreeLe: livree ? isoYmd(jour) : null, enReprise: reprise, ecru: e }
  })
}

interface Vue {
  entete: Entete
  etape: EtapeCommandePartenaire
  lignes: LigneVue[]
  lots: LotVu[]
  urgences: Map<number, string | null>
}

/** Every listed order of the partner with its step, lines and lots; one order (`idCommande`) also reads its rolls. */
async function vues(idSousTraitant: number, idCommande?: number): Promise<{ vues: Vue[]; fini: Map<number, FiniRow[]> }> {
  const vide = { vues: [] as Vue[], fini: new Map<number, FiniRow[]>() }
  if (!(await estEnnoblisseur(idSousTraitant))) return vide
  const toutes = await entetesEnvoyees(idSousTraitant, idCommande)
  // Twelve sliding months: a closed order without a movement since is dropped before anything else is read of it.
  const depuis = debutDouzeMois(aujourdhui())
  const recues = await recuesDepuis(toutes.filter((e) => (e.envoyee ?? '') < depuis).map((e) => e.id), depuis)
  const horsFenetre = (e: Entete) => sansMouvementDepuis(e.envoyee, recues.has(e.id), depuis)
  const entetes = toutes.filter((e) => !(e.soldee && horsFenetre(e)))
  if (entetes.length === 0) return vide
  const lignes = await lignesDe(entetes.map((e) => e.id))
  const parCommande = new Map<number, LigneRow[]>()
  for (const l of lignes) parCommande.set(l.cmd, [...(parCommande.get(l.cmd) ?? []), l])

  // The cycle is read for the open orders only (a closed one is « terminée » whatever its lots say), which keeps a
  // long history to a handful of flat reads; the detail of a closed order still reads its lots.
  const ouvertes = entetes.filter((e) => !e.soldee).map((e) => e.id)
  const aLire = idCommande ? entetes.map((e) => e.id) : ouvertes
  const lignesOuvertes = lignes.filter((l) => ouvertes.includes(l.cmd))
  const [faits, ecru, fini, urgences] = await Promise.all([
    lireCommandesEnnoblissement(aLire),
    // The pieces themselves only where their return is still followed (open orders).
    ecruParLigne(lignes.map((l) => l.id), lignesOuvertes.map((l) => l.id)),
    idCommande ? finiParLigne(lignes.map((l) => l.id)) : Promise.resolve(new Map<number, FiniRow[]>()),
    urgencesLignes(lignesOuvertes.map((l) => ({ id: l.id, delai: l.delai })), aujourdhui()),
  ])
  const revenus = await consumedEcruIds(lignesOuvertes.flatMap((l) => ecru.get(l.id)?.ids ?? []))

  const out: Vue[] = []
  for (const entete of entetes) {
    const ls = parCommande.get(entete.id) ?? []
    if (ls.length === 0) continue // nothing ordered: nothing to show
    const fait: CommandeFait | undefined = faits.get(entete.id)
    const etat = fait ? etatCommande(fait) : null
    // Closed, or every lot validated with nothing left at the partner (ETM « À clôturer »).
    const terminee = entete.soldee || etat?.etape === 'a_cloturer'
    const lots = lotsVus(fait?.lots ?? [], ls.map((l) => l.id), terminee)
    const lignesV = lignesVues(ls, terminee, ecru, revenus, lots, idCommande ? fini : undefined)
    const delaiManquant = lignesV.some((l) => !l.livree && !l.row.delai)
    const etape = terminee ? 'terminee' : etat ? etapeCommandePartenaire(etat, delaiManquant) : null
    if (!etape) continue // « À envoyer » again (lines back to Non_Envoye): not the partner's to see
    if (etape === 'terminee' && horsFenetre(entete)) continue // finished without being closed, out of the window
    out.push({
      entete, etape, lignes: lignesV, lots,
      urgences: new Map(lignesV.filter((l) => !l.livree && urgences.has(l.row.id)).map((l) => [l.row.id, urgences.get(l.row.id)!.dateSouhaitee])),
    })
  }
  return { vues: out, fini }
}

function resume(v: Vue, noms: Map<number, { reference: string; coloris: string }>): CommandeResume {
  const ouvertes = v.lignes.filter((l) => !l.livree)
  return {
    id: v.entete.id,
    date: v.entete.date,
    envoyeeLe: v.entete.envoyee,
    etape: v.etape,
    nbLignes: v.lignes.length,
    lignesLivrees: v.lignes.length - ouvertes.length,
    delai: v.etape === 'terminee' ? null : ouvertes.map((l) => l.row.delai).filter((d): d is string => !!d).sort()[0] ?? null,
    quantiteMl: round1(v.lignes.reduce((s, l) => s + l.row.quantite, 0)),
    poidsKg: round1(v.lignes.reduce((s, l) => s + l.ecru.kg, 0)),
    urgente: v.urgences.size > 0,
    lotsAVous: v.etape === 'terminee' ? 0 : v.lots.filter((l) => LOT_A_VOUS.has(l.etape)).length,
    articles: [...new Set(v.lignes.map((l) => article(noms.get(l.row.id)?.reference ?? '', noms.get(l.row.id)?.coloris ?? '')).filter(Boolean))],
  }
}

/** The partner's orders, newest first: those in progress, and those finished within the twelve sliding months.
 *  [] for an unknown sous-traitant, a knitter, or none sent. */
export async function listeCommandesPartenaire(idSousTraitant: number): Promise<CommandeResume[]> {
  const { vues: vs } = await vues(idSousTraitant)
  const noms = await libelles(vs.flatMap((v) => v.lignes.map((l) => l.row)))
  return vs.map((v) => resume(v, noms))
}

async function lireAdresse(id: number): Promise<Adresse | null> {
  if (!(id > 0)) return null
  const [r] = await mpsPg()<Record<'nom' | 'adresse1' | 'adresse2' | 'adresse3' | 'cp' | 'ville' | 'pays', string | null>[]>`
    SELECT nom::text AS nom, adresse1::text AS adresse1, adresse2::text AS adresse2, adresse3::text AS adresse3,
           cp::text AS cp, ville::text AS ville, pays::text AS pays
    FROM adresse WHERE idadresse = ${id}`
  if (!r) return null
  // The street may sit in any of the three lines (CLAUDE.md, LIVA #1163): all of them, as the bon prints them.
  return { nom: str(r.nom), lignes: [r.adresse1, r.adresse2, r.adresse3].map(str).filter(Boolean), cp: str(r.cp), ville: str(r.ville), pays: str(r.pays) }
}

/** One order of the partner, or null — also when it exists but is another sous-traitant's, was never sent, or is
 *  finished and out of the twelve sliding months. */
export async function commandePartenaire(idSousTraitant: number, idCommande: number): Promise<CommandeDetail | null> {
  const { vues: vs, fini } = await vues(idSousTraitant, idCommande)
  const v = vs[0]
  if (!v) return null
  const [noms, pdf, adresseLivraison] = await Promise.all([
    libelles(v.lignes.map((l) => l.row)),
    // What the bon de commande prints of each reference: its designation, treatments and presentation.
    buildCommandePdfData(idCommande),
    lireAdresse(v.entete.idadresse),
  ])
  const imprime = new Map((pdf?.lignes ?? []).map((l) => [l.id ?? 0, l]))
  const enReprise = new Set(v.lots.filter((l) => l.etape === 'en_reprise').map((l) => `${l.idLigne}:${cleLot(l.fait.lot)}`))

  const lignes: LigneCommande[] = v.lignes.map((l) => {
    const nom = noms.get(l.row.id) ?? { reference: '', coloris: '' }
    const p = imprime.get(l.row.id)
    // Rolls of a lot back at the partner for a reprise are not « received » any more.
    const recus = (fini.get(l.row.id) ?? []).filter((f) => !enReprise.has(`${l.row.id}:${cleLot(f.lot)}`))
    return {
      id: l.row.id,
      reference: nom.reference,
      coloris: nom.coloris,
      designation: str(p?.ref_designation),
      traitements: p?.traitements ?? [],
      consigne: str(p?.ref_presentation) || null,
      quantiteMl: round1(l.row.quantite),
      nbPieces: l.ecru.nb,
      poidsKg: round1(l.ecru.kg),
      delai: l.row.delai,
      urgenceSouhaiteeLe: v.urgences.get(l.row.id) ?? null,
      recuMl: round1(recus.reduce((s, f) => s + f.metrage, 0)),
      livreeLe: l.livreeLe,
      etape: etapeLignePartenaire(l.livree, l.row.delai),
    }
  })
  const lots: Lot[] = v.lots.map((l) => {
    const nom = noms.get(l.idLigne) ?? { reference: '', coloris: '' }
    const rouleaux = (fini.get(l.idLigne) ?? []).filter((f) => cleLot(f.lot) === cleLot(l.fait.lot))
    return {
      lot: l.fait.lot,
      idLigne: l.idLigne,
      reference: nom.reference,
      coloris: nom.coloris,
      etape: l.etape,
      recuLe: l.fait.reception,
      nbRouleaux: rouleaux.length,
      metrageMl: round1(rouleaux.reduce((s, f) => s + f.metrage, 0)),
      motif: l.etape === 'en_reprise'
        ? l.fait.repriseMotif ?? null
        : l.etape === 'coloris_refuse' ? l.fait.coloris.reponse?.commentaire.trim() || null : null,
    }
  })
  const { articles: _articles, ...r } = resume(v, noms)
  return { ...r, adresseLivraison, lignes, lots }
}

/** The bon de commande PDF — the document Malterre e-mails the partner (Sous-traitants › Ennoblissement « PDF ») —
 *  or null when the order isn't this partner's or was never sent. Same rule as commandePartenaire. */
export async function bonDeCommandePartenaire(idSousTraitant: number, idCommande: number): Promise<{ numero: string; pdf: Buffer } | null> {
  const { vues: vs } = await vues(idSousTraitant, idCommande)
  if (!vs[0]) return null
  const data = await buildCommandePdfData(idCommande)
  if (!data) return null
  return { numero: data.numero, pdf: await renderCommandePdfBuffer(data) }
}
