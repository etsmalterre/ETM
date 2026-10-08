// Point sous-traitant — storage (PG point_sst / point_sst_ligne, migration
// 0010_point_sst). A point is prepared by the automate (or « Préparer » on the
// screen), checked and edited by a person, then sent.
//
// « Actualiser » re-runs the rules and MERGES (fusionner()): an auto line the
// person left alone follows the data, an edited one keeps the person's
// values, a removed one stays removed, a line the rules no longer produce
// disappears unless the person touched it, manual lines are never touched.

import { mpsPg } from '../mps-pg.js'
import { lireFaits } from './lecture.js'
import { construirePoint, jjmm, trier, type LignePoint, type RetraitRepris, type Section } from './regles.js'

export type StatutPoint = 'brouillon' | 'programme' | 'envoye'

export interface Destinataire { email: string; nom: string }

export interface PointLigne {
  id: number
  section: Section
  ordre: number
  origine: 'auto' | 'manuel'
  cle: string | null
  idcommande: number
  idligne: number
  commande: string
  reference: string
  coloris: string
  datePrevue: string | null
  commentaire: string
  pourquoi: string
  /** What the automate proposed (auto lines); null on a manual line. */
  auto: Pick<LignePoint, 'commande' | 'reference' | 'coloris' | 'datePrevue' | 'commentaire'> | null
  modifiee: boolean
  retiree: boolean
  retour: { id: string; texte: string; par: string | null } | null
  modifieLe: string | null
  modifiePar: string | null
}

export interface Point {
  id: number
  idsousTraitant: number
  sousTraitant: string
  jour: string
  statut: StatutPoint
  genereLe: string
  generePar: string
  actualiseLe: string | null
  version: number
  introduction: string
  conclusion: string
  destinataires: Destinataire[]
  cc: Destinataire[]
  cci: Destinataire[]
  sujet: string
  avecDocx: boolean
  /** Files the person attached in the email dialog (names only; kept for a scheduled send). */
  piecesJointes: { nom: string; taille: number }[]
  envoiPrevuLe: string | null
  programmePar: string | null
  envoyeLe: string | null
  envoyePar: string | null
  erreurEnvoi: string | null
  lignes: PointLigne[]
}

export class PointIntrouvable extends Error { constructor() { super('point introuvable') } }
export class PointEnvoye extends Error { constructor() { super('Ce point est déjà envoyé : il ne se modifie plus.') } }

const CHAMPS_AUTO = ['commande', 'reference', 'coloris', 'datePrevue', 'commentaire'] as const

export const sujetParDefaut = (jour: string) => `Point du ${jour.slice(8, 10)}/${jour.slice(5, 7)}`

function versLigne(r: Record<string, any>): PointLigne {
  return {
    id: Number(r.idpoint_sst_ligne),
    section: Number(r.section) as Section,
    ordre: Number(r.ordre),
    origine: r.origine,
    cle: r.cle ?? null,
    idcommande: Number(r.idcommande_sous_traitant) || 0,
    idligne: Number(r.idligne_commande_sous_traitant) || 0,
    commande: r.commande ?? '',
    reference: r.reference ?? '',
    coloris: r.coloris ?? '',
    datePrevue: r.date_prevue ?? null,
    commentaire: r.commentaire ?? '',
    pourquoi: r.pourquoi ?? '',
    auto: r.auto ?? null,
    modifiee: !!r.modifiee,
    retiree: !!r.retiree,
    retour: r.retour_id ? { id: r.retour_id, texte: r.retour_texte ?? '', par: r.retour_par_nom ?? null } : null,
    modifieLe: r.modifie_le ? new Date(r.modifie_le).toISOString() : null,
    modifiePar: r.modifie_par_nom ?? null,
  }
}

const isoTs = (v: unknown) => (v ? new Date(v as string).toISOString() : null)

function versPoint(r: Record<string, any>, lignes: PointLigne[]): Point {
  return {
    id: Number(r.idpoint_sst),
    idsousTraitant: Number(r.idsous_traitant),
    sousTraitant: r.sous_traitant ?? '',
    jour: r.jour,
    statut: r.statut,
    genereLe: isoTs(r.genere_le)!,
    generePar: r.genere_par,
    actualiseLe: isoTs(r.actualise_le),
    version: Number(r.version),
    introduction: r.introduction ?? '',
    conclusion: r.conclusion ?? '',
    destinataires: r.destinataires ?? [],
    cc: r.cc ?? [],
    cci: r.cci ?? [],
    sujet: r.sujet ?? '',
    avecDocx: !!r.avec_docx,
    piecesJointes: r.pieces ?? [],
    envoiPrevuLe: isoTs(r.envoi_prevu_le),
    programmePar: r.programme_par_nom ?? null,
    envoyeLe: isoTs(r.envoye_le),
    envoyePar: r.envoye_par_nom ?? null,
    erreurEnvoi: r.erreur_envoi ?? null,
    lignes,
  }
}

const COLONNES_POINT = `p.idpoint_sst, p.idsous_traitant, COALESCE(s.nom, '') AS sous_traitant, to_char(p.jour, 'YYYY-MM-DD') AS jour, p.statut,
  p.genere_le, p.genere_par, p.actualise_le, p.version, p.introduction, p.conclusion, p.destinataires, p.cc, p.cci, p.sujet, p.avec_docx,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('nom', e->>'filename', 'taille', length(e->>'content_base64') * 3 / 4)), '[]')
     FROM jsonb_array_elements(p.pieces_jointes) e) AS pieces,
  p.envoi_prevu_le, p.programme_par_nom, p.envoye_le, p.envoye_par_nom, p.erreur_envoi`

export async function lirePoint(id: number): Promise<Point> {
  const sql = mpsPg()
  const [r] = await sql.unsafe(`SELECT ${COLONNES_POINT} FROM point_sst p LEFT JOIN sous_traitant s ON s.idsous_traitant = p.idsous_traitant WHERE p.idpoint_sst = $1`, [id])
  if (!r) throw new PointIntrouvable()
  const lignes = await sql<Record<string, any>[]>`
    SELECT *, to_char(date_prevue, 'YYYY-MM-DD') AS date_prevue FROM point_sst_ligne
    WHERE idpoint_sst = ${id} ORDER BY section, ordre, idpoint_sst_ligne`
  return versPoint(r, lignes.map(versLigne))
}

export interface PointResume {
  id: number
  idsousTraitant: number
  sousTraitant: string
  jour: string
  statut: StatutPoint
  envoiPrevuLe: string | null
  envoyeLe: string | null
  nbLignes: number
  nbModifiees: number
}

export async function listerPoints(limite = 120): Promise<PointResume[]> {
  const sql = mpsPg()
  const rows = await sql.unsafe(`
    SELECT ${COLONNES_POINT},
      (SELECT COUNT(*) FROM point_sst_ligne l WHERE l.idpoint_sst = p.idpoint_sst AND NOT l.retiree)::int AS nb_lignes,
      (SELECT COUNT(*) FROM point_sst_ligne l WHERE l.idpoint_sst = p.idpoint_sst AND (l.modifiee OR l.retiree OR l.origine = 'manuel'))::int AS nb_modifiees
    FROM point_sst p LEFT JOIN sous_traitant s ON s.idsous_traitant = p.idsous_traitant
    ORDER BY p.jour DESC, p.idpoint_sst DESC LIMIT $1`, [limite])
  return rows.map((r: Record<string, any>) => ({
    id: Number(r.idpoint_sst),
    idsousTraitant: Number(r.idsous_traitant),
    sousTraitant: r.sous_traitant ?? '',
    jour: r.jour,
    statut: r.statut,
    envoiPrevuLe: isoTs(r.envoi_prevu_le),
    envoyeLe: isoTs(r.envoye_le),
    nbLignes: Number(r.nb_lignes),
    nbModifiees: Number(r.nb_modifiees),
  }))
}

/** The last point sent to this dyer: its recipients and greeting carry over. */
async function dernierEnvoye(idsousTraitant: number): Promise<Record<string, any> | null> {
  const sql = mpsPg()
  const [r] = await sql`SELECT destinataires, cc, cci, introduction, conclusion, avec_docx FROM point_sst
    WHERE idsous_traitant = ${idsousTraitant} AND statut = 'envoye' ORDER BY jour DESC LIMIT 1`
  return r ?? null
}

/** The message typed in the email dialog, above the point's tables (PE's habit: a
 *  short word, the point attached). Carried over from the last point sent to the dyer. */
export const INTRODUCTION_PAR_DEFAUT = 'Bonjour,\n\nVoici le point du jour.\n\nBonne journée'
export const CONCLUSION_PAR_DEFAUT = ''

/** Prepares (creates) or refreshes (merges) the point of `jour` for a dyer.
 *  An already sent point is left alone. Returns the point id and what changed. */
export async function preparerPoint(idsousTraitant: number, jour: string, par: string, version: number): Promise<{ id: number; cree: boolean; ajoutees: number; mises_a_jour: number; enlevees: number; envoye: boolean }> {
  const { lignes } = await lireFaits(idsousTraitant, jour)
  const calcul = reprendreRetraits(construirePoint(jour, lignes), await lignesDuPointPrecedent(idsousTraitant, jour))
  const sql = mpsPg()
  return sql.begin(async (t) => {
    const tx = t as unknown as typeof sql
    const [existant] = await tx`SELECT idpoint_sst, statut FROM point_sst WHERE idsous_traitant = ${idsousTraitant} AND jour = ${jour}::date FOR UPDATE`
    if (existant?.statut === 'envoye') return { id: Number(existant.idpoint_sst), cree: false, ajoutees: 0, mises_a_jour: 0, enlevees: 0, envoye: true }
    let id: number
    let cree = false
    if (existant) {
      id = Number(existant.idpoint_sst)
      await tx`UPDATE point_sst SET actualise_le = now(), version = ${version} WHERE idpoint_sst = ${id}`
    } else {
      const prec = await dernierEnvoye(idsousTraitant)
      const [n] = await tx`INSERT INTO point_sst (idsous_traitant, jour, genere_par, version, introduction, conclusion, destinataires, cc, cci, sujet, avec_docx)
        VALUES (${idsousTraitant}, ${jour}::date, ${par}, ${version}, ${prec?.introduction ?? INTRODUCTION_PAR_DEFAUT}, ${prec?.conclusion ?? CONCLUSION_PAR_DEFAUT},
                ${tx.json(prec?.destinataires ?? [])}, ${tx.json(prec?.cc ?? [])}, ${tx.json(prec?.cci ?? [])}, ${sujetParDefaut(jour)}, ${prec?.avec_docx ?? false})
        RETURNING idpoint_sst`
      id = Number(n.idpoint_sst)
      cree = true
    }
    const actuelles = (await tx<Record<string, any>[]>`
      SELECT *, to_char(date_prevue, 'YYYY-MM-DD') AS date_prevue FROM point_sst_ligne WHERE idpoint_sst = ${id}`).map(versLigne)
    const plan = fusionner(actuelles, calcul)
    for (const l of plan.inserer) {
      await tx`INSERT INTO point_sst_ligne (idpoint_sst, section, ordre, origine, cle, idcommande_sous_traitant, idligne_commande_sous_traitant,
          commande, reference, coloris, date_prevue, commentaire, pourquoi, auto, retiree)
        VALUES (${id}, ${l.section}, 0, 'auto', ${l.cle}, ${l.idcommande}, ${l.idligne}, ${l.commande}, ${l.reference}, ${l.coloris},
          ${l.datePrevue}::date, ${l.commentaire}, ${pourquoiDe(l)}, ${tx.json(autoDe(l))}, ${!!l.reprise})`
    }
    for (const { id: lid, l } of plan.mettreAJour) {
      await tx`UPDATE point_sst_ligne SET section = ${l.section}, idcommande_sous_traitant = ${l.idcommande}, idligne_commande_sous_traitant = ${l.idligne},
          commande = ${l.commande}, reference = ${l.reference}, coloris = ${l.coloris}, date_prevue = ${l.datePrevue}::date, commentaire = ${l.commentaire},
          pourquoi = ${pourquoiDe(l)}, auto = ${tx.json(autoDe(l))}, retiree = ${!!l.reprise}
        WHERE idpoint_sst_ligne = ${lid}`
    }
    for (const { id: lid, l } of plan.rafraichirAuto) {
      await tx`UPDATE point_sst_ligne SET auto = ${tx.json(autoDe(l))}, pourquoi = ${pourquoiDe(l)} WHERE idpoint_sst_ligne = ${lid}`
    }
    if (plan.supprimer.length > 0) await tx`DELETE FROM point_sst_ligne WHERE idpoint_sst_ligne IN ${tx(plan.supprimer)}`
    await renumeroter(tx, id)
    return { id, cree, ajoutees: plan.inserer.length, mises_a_jour: plan.mettreAJour.length, enlevees: plan.supprimer.length, envoye: false }
  })
}

/** `auto` = what the automate proposed; it also keeps the carried removal (`reprise`) so
 *  the next day can carry it again without the person's original line. */
const autoDe = (l: LignePoint) => ({
  commande: l.commande, reference: l.reference, coloris: l.coloris, datePrevue: l.datePrevue, commentaire: l.commentaire,
  ...(l.reprise ? { reprise: { ...l.reprise } } : {}),
})

/** The auto lines of this dyer's previous point a person worked on: the latest day before
 *  `jour` that was sent, scheduled or has a line someone touched. v4 (point du 09/10): the
 *  08/10 point, prepared but never opened, hid the removal of 8990 made on 07/10. */
async function lignesDuPointPrecedent(idsousTraitant: number, jour: string): Promise<{ jour: string; lignes: PointLigne[] } | null> {
  const sql = mpsPg()
  const [p] = await sql`SELECT p.idpoint_sst, to_char(p.jour, 'YYYY-MM-DD') AS jour FROM point_sst p
    WHERE p.idsous_traitant = ${idsousTraitant} AND p.jour < ${jour}::date
      AND (p.statut <> 'brouillon' OR EXISTS (SELECT 1 FROM point_sst_ligne l WHERE l.idpoint_sst = p.idpoint_sst AND l.modifie_par_nom IS NOT NULL))
    ORDER BY p.jour DESC LIMIT 1`
  if (!p) return null
  const rows = await sql<Record<string, any>[]>`
    SELECT *, to_char(date_prevue, 'YYYY-MM-DD') AS date_prevue FROM point_sst_ligne
    WHERE idpoint_sst = ${p.idpoint_sst} AND origine = 'auto'`
  return { jour: p.jour, lignes: rows.map(versLigne) }
}

/** A line a person removed from the previous point comes back removed while the automate
 *  would propose exactly the same thing (v3, point du 07/10: « on attend la décision du
 *  client » — a reason ETM cannot see, so no rule can learn it). New facts (another lot,
 *  a moved date) bring the line back; « Rétablir » breaks the chain. Pure, tested. */
export function reprendreRetraits(calcul: readonly LignePoint[], precedent: { jour: string; lignes: readonly PointLigne[] } | null): LignePoint[] {
  if (!precedent) return [...calcul]
  const parCle = new Map(precedent.lignes.filter((p) => p.cle && p.retiree && p.auto).map((p) => [p.cle!, p]))
  return calcul.map((l) => {
    const p = parCle.get(l.cle)
    if (!p || p.section !== l.section || CHAMPS_AUTO.some((k) => (p.auto![k] ?? '') !== (l[k] ?? ''))) return l
    // Removed by a person that day, or carried from further back without being touched.
    const avant = (p.auto as { reprise?: RetraitRepris }).reprise
    const reprise: RetraitRepris = p.modifiePar || !avant
      ? { jour: precedent.jour, par: p.modifiePar ?? '', texte: p.retour?.texte ?? '' }
      : avant
    return { ...l, reprise }
  })
}

/** The line's « pourquoi », with the carried removal said in full. */
export function pourquoiDe(l: LignePoint): string {
  if (!l.reprise) return l.pourquoi
  const r = l.reprise
  return `${l.pourquoi} Retirée le ${jjmm(r.jour)}${r.par ? ` par ${r.par}` : ''}${r.texte ? ` : « ${r.texte} »` : ''} — elle reste retirée tant que rien ne change.`
}

/** The merge of « Actualiser » — pure, tested in db.test.ts. */
export function fusionner(actuelles: readonly PointLigne[], calcul: readonly LignePoint[]): {
  inserer: LignePoint[]
  mettreAJour: { id: number; l: LignePoint }[]
  rafraichirAuto: { id: number; l: LignePoint }[]
  supprimer: number[]
} {
  const parCle = new Map(actuelles.filter((a) => a.origine === 'auto' && a.cle).map((a) => [a.cle!, a]))
  const vues = new Set<string>()
  const out = { inserer: [] as LignePoint[], mettreAJour: [] as { id: number; l: LignePoint }[], rafraichirAuto: [] as { id: number; l: LignePoint }[], supprimer: [] as number[] }
  // A person acted on the line (edit, removal, « Rétablir », Tricobot): their version wins.
  // A line removed only because yesterday's removal was carried (no modifiePar) still
  // follows the rules — new facts bring it back.
  const touchee = (a: PointLigne) => a.modifiee || !!a.retour || a.modifiePar !== null
  for (const l of calcul) {
    vues.add(l.cle)
    const a = parCle.get(l.cle)
    if (!a) out.inserer.push(l)
    else if (touchee(a)) out.rafraichirAuto.push({ id: a.id, l })
    else out.mettreAJour.push({ id: a.id, l })
  }
  for (const a of parCle.values()) {
    if (vues.has(a.cle!)) continue
    if (!touchee(a)) out.supprimer.push(a.id)
  }
  return out
}

/** Display order: the rules' order for auto lines, manual lines after them in their section. */
async function renumeroter(tx: ReturnType<typeof mpsPg>, id: number): Promise<void> {
  const rows = (await tx<Record<string, any>[]>`
    SELECT *, to_char(date_prevue, 'YYYY-MM-DD') AS date_prevue FROM point_sst_ligne WHERE idpoint_sst = ${id}`).map(versLigne)
  const auto = trier(rows.filter((r) => r.origine === 'auto').map((r) => ({ ...r, cle: r.cle ?? '', idcommande: r.idcommande })))
  const manuel = rows.filter((r) => r.origine === 'manuel').sort((a, b) => a.ordre - b.ordre || a.id - b.id)
  const ordre = new Map<number, number>()
  for (const s of [1, 2, 3, 4, 5, 6]) {
    let i = 0
    for (const r of auto.filter((x) => x.section === s)) ordre.set(r.id, i++)
    for (const r of manuel.filter((x) => x.section === s)) ordre.set(r.id, 1000 + i++)
  }
  for (const [lid, o] of ordre) await tx`UPDATE point_sst_ligne SET ordre = ${o} WHERE idpoint_sst_ligne = ${lid} AND ordre <> ${o}`
}

async function verrouModifiable(tx: ReturnType<typeof mpsPg>, idpoint: number): Promise<void> {
  const [p] = await tx`SELECT statut FROM point_sst WHERE idpoint_sst = ${idpoint} FOR UPDATE`
  if (!p) throw new PointIntrouvable()
  if (p.statut === 'envoye') throw new PointEnvoye()
}

export interface ChampsLigne {
  section?: Section
  commande?: string
  reference?: string
  coloris?: string
  datePrevue?: string | null
  commentaire?: string
}

/** Edits a line. An auto line becomes « modifiée » when it differs from what the automate proposed. */
export async function modifierLigne(idpoint: number, idligne: number, champs: ChampsLigne, par: string): Promise<void> {
  const sql = mpsPg()
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql
    await verrouModifiable(tx, idpoint)
    const [r] = await tx<Record<string, any>[]>`SELECT *, to_char(date_prevue, 'YYYY-MM-DD') AS date_prevue FROM point_sst_ligne WHERE idpoint_sst_ligne = ${idligne} AND idpoint_sst = ${idpoint}`
    if (!r) throw new PointIntrouvable()
    const l = versLigne(r)
    const next = { ...l, ...Object.fromEntries(Object.entries(champs).filter(([, v]) => v !== undefined)) } as PointLigne
    const modifiee = l.origine === 'auto' && !!l.auto && (next.section !== l.section || CHAMPS_AUTO.some((k) => (next[k] ?? '') !== (l.auto![k] ?? '')))
    await tx`UPDATE point_sst_ligne SET section = ${next.section}, commande = ${next.commande}, reference = ${next.reference}, coloris = ${next.coloris},
        date_prevue = ${next.datePrevue || null}::date, commentaire = ${next.commentaire}, modifiee = ${modifiee}, modifie_le = now(), modifie_par_nom = ${par}
      WHERE idpoint_sst_ligne = ${idligne}`
    if (next.section !== l.section) await renumeroter(tx, idpoint)
  })
}

export async function ajouterLigne(idpoint: number, section: Section, champs: ChampsLigne, par: string): Promise<number> {
  const sql = mpsPg()
  return sql.begin(async (t) => {
    const tx = t as unknown as typeof sql
    await verrouModifiable(tx, idpoint)
    const [m] = await tx`SELECT COALESCE(MAX(ordre), 999) + 1 AS o FROM point_sst_ligne WHERE idpoint_sst = ${idpoint} AND section = ${section}`
    const [n] = await tx`INSERT INTO point_sst_ligne (idpoint_sst, section, ordre, origine, commande, reference, coloris, date_prevue, commentaire, modifie_le, modifie_par_nom)
      VALUES (${idpoint}, ${section}, ${Math.max(1000, Number(m.o))}, 'manuel', ${champs.commande ?? ''}, ${champs.reference ?? ''}, ${champs.coloris ?? ''},
        ${champs.datePrevue || null}::date, ${champs.commentaire ?? ''}, now(), ${par})
      RETURNING idpoint_sst_ligne`
    return Number(n.idpoint_sst_ligne)
  })
}

/** Removes a line: an auto line is kept as « retirée » (feedback, and Actualiser won't bring it back), a manual one is deleted. */
export async function retirerLigne(idpoint: number, idligne: number, par: string): Promise<void> {
  const sql = mpsPg()
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql
    await verrouModifiable(tx, idpoint)
    const [r] = await tx`SELECT origine FROM point_sst_ligne WHERE idpoint_sst_ligne = ${idligne} AND idpoint_sst = ${idpoint}`
    if (!r) throw new PointIntrouvable()
    if (r.origine === 'manuel') await tx`DELETE FROM point_sst_ligne WHERE idpoint_sst_ligne = ${idligne}`
    else await tx`UPDATE point_sst_ligne SET retiree = true, modifie_le = now(), modifie_par_nom = ${par} WHERE idpoint_sst_ligne = ${idligne}`
  })
}

/** Brings back a removed auto line, and (`reinitialiser`) the automate's values of an edited one. */
export async function restaurerLigne(idpoint: number, idligne: number, par: string): Promise<void> {
  const sql = mpsPg()
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql
    await verrouModifiable(tx, idpoint)
    const [r] = await tx<Record<string, any>[]>`SELECT *, to_char(date_prevue, 'YYYY-MM-DD') AS date_prevue FROM point_sst_ligne WHERE idpoint_sst_ligne = ${idligne} AND idpoint_sst = ${idpoint} AND origine = 'auto'`
    if (!r) throw new PointIntrouvable()
    const a = versLigne(r).auto
    if (!a) return
    await tx`UPDATE point_sst_ligne SET retiree = false, modifiee = false, commande = ${a.commande}, reference = ${a.reference}, coloris = ${a.coloris},
        date_prevue = ${a.datePrevue}::date, commentaire = ${a.commentaire}, modifie_le = now(), modifie_par_nom = ${par}
      WHERE idpoint_sst_ligne = ${idligne}`
  })
}

export async function noterRetourLigne(idpoint: number, idligne: number, retour: { id: string; texte: string; par: string } | null): Promise<void> {
  const sql = mpsPg()
  await sql`UPDATE point_sst_ligne SET retour_id = ${retour?.id ?? null}, retour_texte = ${retour?.texte ?? null}, retour_par_nom = ${retour?.par ?? null}
    WHERE idpoint_sst_ligne = ${idligne} AND idpoint_sst = ${idpoint}`
}

export interface PieceJointe { filename: string; content_base64: string; content_type: string }

export interface ChampsEnvoi {
  destinataires: Destinataire[]
  cc: Destinataire[]
  cci: Destinataire[]
  sujet: string
  /** The message typed in the email dialog, above the point's tables. */
  message: string
  avecDocx: boolean
  pieces: PieceJointe[]
}

/** What the email dialog decided, saved on the point before it is sent or scheduled. */
export async function enregistrerEnvoi(idpoint: number, c: ChampsEnvoi): Promise<void> {
  const sql = mpsPg()
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql
    await verrouModifiable(tx, idpoint)
    await tx`UPDATE point_sst SET destinataires = ${tx.json(c.destinataires as never)}, cc = ${tx.json(c.cc as never)}, cci = ${tx.json(c.cci as never)},
        sujet = ${c.sujet}, introduction = ${c.message}, conclusion = '', avec_docx = ${c.avecDocx}, pieces_jointes = ${tx.json(c.pieces as never)}
      WHERE idpoint_sst = ${idpoint}`
  })
}

export async function lirePiecesJointes(idpoint: number): Promise<PieceJointe[]> {
  const sql = mpsPg()
  const [r] = await sql`SELECT pieces_jointes FROM point_sst WHERE idpoint_sst = ${idpoint}`
  return (r?.pieces_jointes ?? []) as PieceJointe[]
}

/** Scheduled send (`quand` = ISO instant) or cancel (null). */
export async function programmer(idpoint: number, quand: string | null, par: { id: number; nom: string }): Promise<void> {
  const sql = mpsPg()
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql
    await verrouModifiable(tx, idpoint)
    if (quand) await tx`UPDATE point_sst SET statut = 'programme', envoi_prevu_le = ${quand}::timestamptz, programme_par = ${par.id}, programme_par_nom = ${par.nom}, erreur_envoi = NULL WHERE idpoint_sst = ${idpoint}`
    else await tx`UPDATE point_sst SET statut = 'brouillon', envoi_prevu_le = NULL, programme_par = NULL, programme_par_nom = NULL WHERE idpoint_sst = ${idpoint}`
  })
}

/** Points whose scheduled time has come. */
export async function pointsAEnvoyer(): Promise<{ id: number; par: number | null; parNom: string | null }[]> {
  const sql = mpsPg()
  const rows = await sql`SELECT idpoint_sst, programme_par, programme_par_nom FROM point_sst WHERE statut = 'programme' AND envoi_prevu_le <= now() ORDER BY envoi_prevu_le`
  return rows.map((r) => ({ id: Number(r.idpoint_sst), par: r.programme_par == null ? null : Number(r.programme_par), parNom: r.programme_par_nom ?? null }))
}

export async function marquerEnvoye(idpoint: number, par: { id: number | null; nom: string | null }, messageId: string): Promise<void> {
  const sql = mpsPg()
  await sql`UPDATE point_sst SET statut = 'envoye', envoye_le = now(), envoye_par = ${par.id}, envoye_par_nom = ${par.nom}, message_id = ${messageId}, erreur_envoi = NULL
    WHERE idpoint_sst = ${idpoint}`
}

export async function marquerErreurEnvoi(idpoint: number, erreur: string): Promise<void> {
  const sql = mpsPg()
  await sql`UPDATE point_sst SET erreur_envoi = ${erreur} WHERE idpoint_sst = ${idpoint}`
}

/** The lines that go out: removed ones excluded. */
export const lignesEnvoyees = (p: Point) => p.lignes.filter((l) => !l.retiree)
