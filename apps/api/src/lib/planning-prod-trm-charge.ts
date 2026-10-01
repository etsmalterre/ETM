// Production › Planning (TRM, LIVA #1250) — reads everything the engine
// (lib/planning-prod-trm.ts) needs and returns the plan the screen draws.
// Native PostgreSQL (lib/mps-pg.ts), read-only except healHandedOverOfs().
//
// Population:
//   - métiers: machine.archive = 0;
//   - commande lines: TRM (IDsociete = 2), commande not soldée, Kg lines only
//     (TYPE 4 = rectiligne, never knitted on a métier — LIVA #1185);
//   - OFs: every open OF (est_termine = 0), with or without a line.
// A line's part still to plan = its quantity − what its OFs cover (an open
// OF covers its quantity, a finished one what it knitted).

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { healHandedOverOfs } from './of-queue-trm.js'
import { machineLabel, TRM_SOCIETE } from './production-trm.js'
import {
  construireCalendrier, mesurerRendements, minutesTheoriques, planifier, resteAPlanifier, semaineDuReglage,
  toursPar10kg, horaireValide, JOUR, REGIME_DEFAUT, REGIMES,
  type Aptitude, type EchantillonOf, type Intervalle, type LignePlan, type OfPlan, type Reglage,
  type RegimeId, type Rendement, type Segment, type SemaineHoraires,
} from './planning-prod-trm.js'

/** History window for the rendement measure. */
const HISTORIQUE_JOURS = 365
/** The rendement measure reads a year of pieces: kept this long in memory. */
const CACHE_RENDEMENT_MS = 60 * 60 * 1000

// ── Small helpers ────────────────────────────────────────

/** 'YYYY-MM-DDTHH:MM:SS' (to_char, local wall time) → epoch ms, local. */
function localMs(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(s)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime()
}

/** epoch ms → 'YYYY-MM-DD HH:MM:SS' local wall time, the shape of the
 *  timestamp-without-time-zone columns (a JS Date parameter would be sent in
 *  UTC and shifted by the session's TimeZone). */
function localTs(ms: number): string {
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function num(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

function texte(v: unknown): string {
  return (v ?? '').toString().trim()
}

/** A table this code reads may not exist yet (migration not applied). */
function tableAbsente(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01'
}

// ── Réglage ──────────────────────────────────────────────

export async function lireReglage(): Promise<Reglage & { modifie_le: string | null }> {
  try {
    const rows = await mpsPg()<{ regime: string; horaires: unknown; modifie_le: string | null }[]>`
      SELECT regime, horaires, to_char(modifie_le, 'YYYY-MM-DD"T"HH24:MI:SS') AS modifie_le
      FROM planning_prod_reglage WHERE id = 1`
    const r = rows[0]
    if (!r) return { regime: REGIME_DEFAUT, horaires: null, modifie_le: null }
    const regime = (['3x8', '2x8', '2x7', 'custom'].includes(r.regime) ? r.regime : REGIME_DEFAUT) as RegimeId
    const horaires = Array.isArray(r.horaires) && r.horaires.length === 7
      ? (r.horaires as unknown[]).map((h) => (horaireValide(h) ? h : null))
      : null
    return { regime, horaires, modifie_le: r.modifie_le }
  } catch (err) {
    if (tableAbsente(err)) return { regime: REGIME_DEFAUT, horaires: null, modifie_le: null }
    throw err
  }
}

export async function ecrireReglage(r: Reglage, idutilisateur: number): Promise<void> {
  const horaires = r.regime === 'custom' ? r.horaires : null
  await mpsPg()`
    INSERT INTO planning_prod_reglage (id, regime, horaires, modifie_le, modifie_par)
    VALUES (1, ${r.regime}, ${horaires === null ? null : mpsPg().json(horaires as never)}, now(), ${idutilisateur})
    ON CONFLICT (id) DO UPDATE SET regime = EXCLUDED.regime, horaires = EXCLUDED.horaires,
      modifie_le = now(), modifie_par = EXCLUDED.modifie_par`
}

// ── Pins ─────────────────────────────────────────────────

async function lireEpingles(): Promise<Map<number, { idmachine: number; rang: number }>> {
  const out = new Map<number, { idmachine: number; rang: number }>()
  try {
    const rows = await mpsPg()<{ idligne_commande_client: number; idmachine: number; rang: number }[]>`
      SELECT idligne_commande_client, idmachine, rang FROM planning_prod_ligne`
    for (const r of rows) out.set(num(r.idligne_commande_client), { idmachine: num(r.idmachine), rang: num(r.rang) })
  } catch (err) {
    if (!tableAbsente(err)) throw err
  }
  return out
}

/** Place `ligneIds` on a métier in that order (rang 1..n) — the whole list
 *  of hand-placed lines of the métier after a drop. */
export async function epinglerLignes(idmachine: number, ligneIds: number[], idutilisateur: number): Promise<void> {
  await mpsPg().begin(async (tx) => {
    const t = tx as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    let rang = 1
    for (const id of ligneIds) {
      await t`
        INSERT INTO planning_prod_ligne (idligne_commande_client, idmachine, rang, modifie_le, modifie_par)
        VALUES (${id}, ${idmachine}, ${rang}, now(), ${idutilisateur})
        ON CONFLICT (idligne_commande_client) DO UPDATE SET idmachine = EXCLUDED.idmachine,
          rang = EXCLUDED.rang, modifie_le = now(), modifie_par = EXCLUDED.modifie_par`
      rang++
    }
  })
}

export async function desepinglerLigne(ligneId: number): Promise<void> {
  await mpsPg()`DELETE FROM planning_prod_ligne WHERE idligne_commande_client = ${ligneId}`
}

// ── Compatibility ────────────────────────────────────────

/** Usable ref_ecru_machine rows of the given refs on live métiers:
 *  ref → métier → tours per 10 kg. */
async function lireToursParRef(refIds: number[]): Promise<Map<number, Map<number, number>>> {
  const out = new Map<number, Map<number, number>>()
  if (refIds.length === 0) return out
  const rows = await mpsPg()<{ idref_ecru: number; idmachine: number; trs: number; chutes: number }[]>`
    SELECT r.idref_ecru, r.idmachine, r.trs_10kg_chute AS trs, r.nb_chutes AS chutes
    FROM ref_ecru_machine r JOIN machine m ON m.idmachine = r.idmachine
    WHERE r.idref_ecru IN ${mpsPg()(refIds)} AND m.archive = 0`
  for (const r of rows) {
    const t = toursPar10kg(num(r.trs), num(r.chutes))
    if (t === null) continue
    const m = out.get(num(r.idref_ecru)) ?? new Map<number, number>()
    // Two rows for one pair: keep the first usable one, like the legacy
    // HLitRecherche.
    if (!m.has(num(r.idmachine))) m.set(num(r.idmachine), t)
    out.set(num(r.idref_ecru), m)
  }
  return out
}

/** Can this métier knit this line? (A drop target check.) */
export async function machineCompatible(ligneId: number, idmachine: number): Promise<boolean> {
  const rows = await mpsPg()<{ idreference: number }[]>`
    SELECT l.idreference FROM ligne_commande_client l
    JOIN commande_client c ON c.idcommande_client = l.idcommande_client
    WHERE l.idligne_commande_client = ${ligneId} AND c.idsociete = ${TRM_SOCIETE}`
  const ref = num(rows[0]?.idreference)
  if (ref <= 0) return false
  return (await lireToursParRef([ref])).get(ref)?.has(idmachine) ?? false
}

// ── Calendar sources ─────────────────────────────────────

/** planning_bonnetier shifts of non-régleur bonnetiers between two instants
 *  (a régleur's day does not run the parc). */
async function lirePostes(de: number, a: number): Promise<Intervalle[]> {
  const rows = await mpsPg()<{ debut: string; fin: string }[]>`
    SELECT to_char(p.date_debut, 'YYYY-MM-DD"T"HH24:MI:SS') AS debut,
           to_char(p.date_fin, 'YYYY-MM-DD"T"HH24:MI:SS') AS fin
    FROM planning_bonnetier p JOIN bonnetier b ON b.idbonnetier = p.idbonnetier
    WHERE b.regleur = 0 AND p.date_fin > ${localTs(de)}::timestamp AND p.date_debut < ${localTs(a)}::timestamp`
  const out: Intervalle[] = []
  for (const r of rows) {
    const debut = localMs(r.debut)
    const fin = localMs(r.fin)
    if (debut !== null && fin !== null && fin > debut) out.push({ debut, fin })
  }
  return out
}

// ── Rendement (cached) ───────────────────────────────────

let cacheRendement: { le: number; valeur: { parMachine: Map<number, Rendement>; parc: Rendement } } | null = null

async function rendements(maintenant: number): Promise<{ parMachine: Map<number, Rendement>; parc: Rendement }> {
  if (cacheRendement && maintenant - cacheRendement.le < CACHE_RENDEMENT_MS) return cacheRendement.valeur
  const depuis = maintenant - HISTORIQUE_JOURS * JOUR
  const rows = await mpsPg()<{
    idmachine: number; kg: number; d0: string; d1: string
    trs: number | null; chutes: number | null; v: number | null
  }[]>`
    SELECT o.idmachine, x.kg,
           to_char(x.d0, 'YYYY-MM-DD"T"HH24:MI:SS') AS d0, to_char(x.d1, 'YYYY-MM-DD"T"HH24:MI:SS') AS d1,
           rem.trs_10kg_chute AS trs, rem.nb_chutes AS chutes,
           COALESCE(NULLIF(o.vitesse, 0), NULLIF(m.vitesse, 0), NULLIF(r.vitesse_cible, 0)) AS v
    FROM ordre_fabrication o
    JOIN machine m ON m.idmachine = o.idmachine
    JOIN ref_ecru r ON r.idref_ecru = o.idref_ecru
    LEFT JOIN LATERAL (
      SELECT rem.trs_10kg_chute, rem.nb_chutes FROM ref_ecru_machine rem
      WHERE rem.idref_ecru = o.idref_ecru AND rem.idmachine = o.idmachine
        AND rem.trs_10kg_chute > 0 AND rem.nb_chutes > 0
      ORDER BY rem.idref_ecru_machine LIMIT 1
    ) rem ON true
    JOIN LATERAL (
      SELECT SUM(p.poids) AS kg, MIN(p.date_debut) AS d0, MAX(p.date_fin) AS d1
      FROM piece_production p
      WHERE p.idordre_fabrication = o.idordre_fabrication AND p.date_fin IS NOT NULL
    ) x ON true
    WHERE o.est_termine = 1 AND x.d1 IS NOT NULL AND x.d1 > ${localTs(depuis)}::timestamp`
  const echantillons: EchantillonOf[] = []
  let premier = maintenant
  for (const r of rows) {
    const debut = localMs(r.d0)
    const fin = localMs(r.d1)
    const kg = num(r.kg)
    const theoriques = minutesTheoriques(kg, toursPar10kg(num(r.trs), num(r.chutes)), num(r.v))
    if (debut === null || fin === null || theoriques === null || kg < 20) continue
    echantillons.push({ idmachine: num(r.idmachine), kg, theoriques, debut, fin })
    premier = Math.min(premier, debut)
  }
  const ouvert = await lirePostes(premier, maintenant)
  const valeur = mesurerRendements(echantillons, mergeSorted(ouvert))
  cacheRendement = { le: maintenant, valeur }
  return valeur
}

function mergeSorted(list: Intervalle[]): Intervalle[] {
  const s = [...list].sort((a, b) => a.debut - b.debut)
  const out: Intervalle[] = []
  for (const i of s) {
    const last = out[out.length - 1]
    if (last && i.debut <= last.fin) last.fin = Math.max(last.fin, i.fin)
    else out.push({ ...i })
  }
  return out
}

// ── The plan ─────────────────────────────────────────────

export interface PlanMachine {
  id: number
  label: string
  rendement: number
  rendement_source: Rendement['source']
  rendement_echantillons: number
}

export interface PlanLigne {
  ligne_id: number
  commande_id: number
  numero: number
  client: string
  miroir: boolean
  reference: string
  coloris: string
  quantite: number
  /** Kg no OF covers yet (planned as a « ligne » segment when > 0). */
  reste_a_lancer: number
  date_livraison: string | null
  /** End of the line's last segment (OF or reste), ms; null when nothing is
   *  left to knit or the line cannot be planned. */
  fin_prevue: number | null
  en_retard: boolean
  /** Métiers set up for its ref — the drop targets. */
  machines_compatibles: number[]
  non_planifiable: boolean
}

export interface PlanOf {
  id: number
  ligne_id: number
  quantite: number
  reste_kg: number
  actif: boolean
  reference: string
  coloris: string
  /** Métiers set up for its ref — the drop targets of a waiting OF. */
  machines_compatibles: number[]
}

export interface Plan {
  maintenant: number
  reel_jusqua: number
  calendrier_fin: number
  reglage: Reglage & { modifie_le: string | null; semaine: SemaineHoraires }
  /** Worked windows of the displayed span (`affichage_jours`). */
  ouvert: Intervalle[]
  machines: PlanMachine[]
  segments: Segment[]
  lignes: PlanLigne[]
  ofs: PlanOf[]
}

/** Worked windows sent to the screen — beyond, the timeline is never shown. */
const AFFICHAGE_JOURS = 120

export async function chargerPlan(maintenant: number = Date.now()): Promise<Plan> {
  // The legacy Android handover leaves a stale « en attente » OF behind;
  // every OF reader repairs it first (LIVA #1128).
  await healHandedOverOfs()
  const sql = mpsPg()

  const [reglage, epingles, machinesRows, lignesRows, ofsRows, postes, rend] = await Promise.all([
    lireReglage(),
    lireEpingles(),
    sql<{ idmachine: number; nom: string | null; emplacement: string | null; vitesse: number | null }[]>`
      SELECT idmachine, nom, emplacement, vitesse FROM machine WHERE archive = 0`,
    sql<{
      idligne_commande_client: number; idcommande_client: number; quantite: number; date_livraison: string | null
      idreference: number; idcolori: number; numero: number; idclient: number; idcommande_etm: number
    }[]>`
      SELECT l.idligne_commande_client, l.idcommande_client, l.quantite,
             to_char(l.date_livraison, 'YYYY-MM-DD') AS date_livraison,
             l.idreference, l.idcolori, c.numero, c.idclient, c.idcommande_etm
      FROM ligne_commande_client l
      JOIN commande_client c ON c.idcommande_client = l.idcommande_client
      WHERE c.idsociete = ${TRM_SOCIETE} AND c.est_soldee = 0 AND COALESCE(l.type, 0) <> 4`,
    sql<{
      idordre_fabrication: number; idmachine: number; est_actif: number; est_termine: number; priorite: number
      quantite: number; idligne_commande_client: number; idref_ecru: number; idcolori_ecru: number; vitesse: number | null
    }[]>`
      SELECT idordre_fabrication, idmachine, est_actif, est_termine, priorite, quantite,
             idligne_commande_client, idref_ecru, idcolori_ecru, vitesse
      FROM ordre_fabrication
      WHERE est_termine = 0 OR idligne_commande_client IN (
        SELECT l.idligne_commande_client FROM ligne_commande_client l
        JOIN commande_client c ON c.idcommande_client = l.idcommande_client
        WHERE c.idsociete = ${TRM_SOCIETE} AND c.est_soldee = 0)`,
    lirePostes(maintenant - JOUR, maintenant + 23 * JOUR),
    rendements(maintenant),
  ])

  const ofIds = ofsRows.map((o) => num(o.idordre_fabrication))
  const refIds = Array.from(new Set([
    ...lignesRows.map((l) => num(l.idreference)),
    ...ofsRows.map((o) => num(o.idref_ecru)),
  ].filter((x) => x > 0)))
  const colorisIds = Array.from(new Set([
    ...lignesRows.map((l) => num(l.idcolori)),
    ...ofsRows.map((o) => num(o.idcolori_ecru)),
  ].filter((x) => x > 0)))
  const clientIds = Array.from(new Set(lignesRows.map((l) => num(l.idclient)).filter((x) => x > 0)))

  const [tricote, tours, refs, coloris, clients] = await Promise.all([
    ofIds.length === 0 ? [] : sql<{ idordre_fabrication: number; kg: number }[]>`
      SELECT idordre_fabrication, SUM(poids) AS kg FROM piece_production
      WHERE idordre_fabrication IN ${sql(ofIds)} AND date_fin IS NOT NULL
      GROUP BY idordre_fabrication`,
    lireToursParRef(refIds),
    refIds.length === 0 ? [] : sql<{ idref_ecru: number; reference: string | null; vitesse_cible: number | null }[]>`
      SELECT idref_ecru, reference, vitesse_cible FROM ref_ecru WHERE idref_ecru IN ${sql(refIds)}`,
    colorisIds.length === 0 ? [] : sql<{ idcolori_ecru: number; reference: string | null }[]>`
      SELECT idcolori_ecru, reference FROM colori_ecru WHERE idcolori_ecru IN ${sql(colorisIds)}`,
    clientIds.length === 0 ? [] : sql<{ idclient: number; nom: string | null }[]>`
      SELECT idclient, nom FROM client WHERE idclient IN ${sql(clientIds)}`,
  ])

  const tricoteParOf = new Map(tricote.map((t) => [num(t.idordre_fabrication), num(t.kg)]))
  const refById = new Map(refs.map((r) => [num(r.idref_ecru), { reference: texte(r.reference), vitesse: num(r.vitesse_cible) }]))
  const colorisById = new Map(coloris.map((c) => [num(c.idcolori_ecru), texte(c.reference)]))
  const clientById = new Map(clients.map((c) => [num(c.idclient), texte(c.nom)]))

  const machines = machinesRows
    .map((m) => {
      const r = rend.parMachine.get(num(m.idmachine)) ?? rend.parc
      return {
        id: num(m.idmachine),
        label: machineLabel({ nom: texte(m.nom), emplacement: texte(m.emplacement) }),
        vitesse: num(m.vitesse),
        rendement: r,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true }))
  const machineById = new Map(machines.map((m) => [m.id, m]))

  const aptitude = (refId: number, idmachine: number, vitesseOf = 0): Aptitude | null => {
    const t = tours.get(refId)?.get(idmachine)
    if (t === undefined) return null
    const vitesse = vitesseOf > 0 ? vitesseOf : (machineById.get(idmachine)?.vitesse || refById.get(refId)?.vitesse || 0)
    return vitesse > 0 ? { tours10kg: t, vitesse } : null
  }

  // OFs: the open ones are queued; every one covers part of its line.
  const ofPlans: OfPlan[] = []
  const ofsOut: PlanOf[] = []
  const couvert = new Map<number, number>()
  for (const o of ofsRows) {
    const id = num(o.idordre_fabrication)
    const ligneId = num(o.idligne_commande_client)
    const quantite = num(o.quantite)
    const fait = tricoteParOf.get(id) ?? 0
    const termine = num(o.est_termine) === 1
    if (ligneId > 0) couvert.set(ligneId, (couvert.get(ligneId) ?? 0) + (termine ? fait : Math.max(quantite, fait)))
    if (termine) continue
    const resteKg = Math.max(0, quantite - fait)
    ofPlans.push({
      id, idmachine: num(o.idmachine), actif: num(o.est_actif) === 1, priorite: num(o.priorite),
      resteKg, ligneId, aptitude: aptitude(num(o.idref_ecru), num(o.idmachine), num(o.vitesse)),
    })
    ofsOut.push({
      id, ligne_id: ligneId, quantite: Math.round(quantite * 100) / 100, reste_kg: Math.round(resteKg * 100) / 100,
      actif: num(o.est_actif) === 1,
      reference: refById.get(num(o.idref_ecru))?.reference ?? '',
      coloris: colorisById.get(num(o.idcolori_ecru)) ?? '',
      machines_compatibles: Array.from(tours.get(num(o.idref_ecru))?.keys() ?? []),
    })
  }

  // Lines: the uncovered part.
  const lignePlans: LignePlan[] = []
  for (const l of lignesRows) {
    const ligneId = num(l.idligne_commande_client)
    const reste = resteAPlanifier(num(l.quantite), couvert.get(ligneId) ?? 0)
    if (reste <= 0) continue
    const refId = num(l.idreference)
    const aptitudes = new Map<number, Aptitude>()
    for (const idmachine of tours.get(refId)?.keys() ?? []) {
      const a = aptitude(refId, idmachine)
      if (a) aptitudes.set(idmachine, a)
    }
    lignePlans.push({
      ligneId, resteKg: reste,
      delai: l.date_livraison ? (localMs(l.date_livraison) ?? 0) + JOUR - 1 : null,
      aptitudes, epingle: epingles.get(ligneId) ?? null,
    })
  }

  const semaine = semaineDuReglage(reglage)
  const calendrier = construireCalendrier({ maintenant, postes, semaine })
  const { segments, nonPlanifiables } = planifier({
    calendrier,
    machines: machines.map((m) => ({ id: m.id, rendement: m.rendement.valeur })),
    ofs: ofPlans,
    lignes: lignePlans,
  })

  const finParLigne = new Map<number, number>()
  for (const s of segments) {
    if (s.ligneId > 0) finParLigne.set(s.ligneId, Math.max(finParLigne.get(s.ligneId) ?? 0, s.fin))
  }
  const nonPlanif = new Set(nonPlanifiables)
  const resteParLigne = new Map(lignePlans.map((l) => [l.ligneId, l.resteKg]))
  const lignes: PlanLigne[] = lignesRows.map((l) => {
    const ligneId = num(l.idligne_commande_client)
    const refId = num(l.idreference)
    const fin = finParLigne.get(ligneId) ?? null
    const delai = l.date_livraison ? (localMs(l.date_livraison) ?? 0) + JOUR - 1 : null
    return {
      ligne_id: ligneId,
      commande_id: num(l.idcommande_client),
      numero: num(l.numero),
      client: clientById.get(num(l.idclient)) ?? '',
      miroir: num(l.idcommande_etm) > 0,
      reference: refById.get(refId)?.reference ?? '',
      coloris: colorisById.get(num(l.idcolori)) ?? '',
      quantite: Math.round(num(l.quantite) * 100) / 100,
      reste_a_lancer: Math.round((resteParLigne.get(ligneId) ?? 0) * 100) / 100,
      date_livraison: l.date_livraison,
      fin_prevue: fin,
      en_retard: fin !== null && delai !== null && fin > delai,
      machines_compatibles: Array.from(tours.get(refId)?.keys() ?? []),
      non_planifiable: nonPlanif.has(ligneId),
    }
  })

  const finAffichage = maintenant + AFFICHAGE_JOURS * JOUR
  return {
    maintenant,
    reel_jusqua: calendrier.reelJusqua,
    calendrier_fin: calendrier.jusqua,
    reglage: { ...reglage, semaine },
    ouvert: calendrier.ouvert.filter((i) => i.debut < finAffichage),
    machines: machines.map((m) => ({
      id: m.id, label: m.label, rendement: Math.round(m.rendement.valeur * 100) / 100,
      rendement_source: m.rendement.source, rendement_echantillons: m.rendement.echantillons,
    })),
    segments: segments.map((s) => ({ ...s, kg: Math.round(s.kg * 100) / 100 })),
    lignes,
    ofs: ofsOut,
  }
}

/** Libellés of the presets, for the settings dialog. */
export const REGIMES_LIBELLES = Object.fromEntries(
  Object.entries(REGIMES).map(([k, v]) => [k, { libelle: v.libelle, semaine: v.semaine }]),
)
