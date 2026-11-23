// The earliest date a client line can be ready (doctrine des délais §5 ter, Vincent 2026-10-29): computed
// live from where its matter sits, never typed. Each portion of the line's quantity goes through the steps
// still ahead of it, each partner in its own working days (lib/jours-ouvres.ts, its closures included):
//   fini rolls validated           → ready now
//   fini rolls not validated yet   → the rest of the quality control, counted from their reception
//   écru pieces reserved           → dyer, then quality control (none on a reference shipped dès la réception)
//   écru still to knit (orders)    → knitter, then dyer, then quality control
//   yarn reserved                  → from the supplier's date (or today if in stock), knitter, dyer, control;
//                                    a supplier past its date ends today at best, and the step carries the
//                                    delay on its engagement (lib/report-delai-fil.ts, Vincent 2026-11-16)
//   nothing reserved               → a yarn estimate, knitter, then dyer, then quality control
// A line whose matter covers SEUIL_EXPEDIE (90 %) of it is served by that matter: the uncovered rest is
// ignored, as shipping counts the line done at the same threshold (AGAPE 3892: 1,1 Ml short of 214 Ml
// put a whole yarn + knitting chain on the line, six weeks later).
// The line's earliest date = the latest portion + the Malterre reserve (doctrine §4, 1.5 working weeks),
// added only when a partner step is left. An écru line has no dyer step. The knitter's band reads the kg
// still to knit on the whole line (one knitting order). Pure, pinned by delai-au-plus-tot.test.ts.
// Matter already at a partner on a launched order (écru at a dyer, knitting launched) ends on that order's
// délai, or today when it is past (« if it delivers today »). An order « En cours » has no reserve: its lines
// read in margin / delay against their engagement (Vincent 2026-11-02).
// A reference switched « Expédier dès la réception » (#1351, lib/fini-expediable.ts) has no quality control
// step ahead: its rolls ship the day the dyer delivers them (Vincent 2026-11-16, order 3905 read 5 days late
// on a control that does not hold it). Its rolls that still cannot ship (En reprise, Attente décision) keep
// the control step: something does hold them.

import { ajouterJoursOuvres, dernierDepart, dernierOuvre, joursOuvresEntre, type Periode } from './jours-ouvres.js'
import { CONTROLE_QUALITE_JOURS, RESERVE_MALTERRE_JOURS, fermetures, standards, tricotageJours, type StandardsSst } from './delais-standards.js'
import { MATEL_IDSOUS_TRAITANT } from './pricing-sst.js'
import { SEUIL_EXPEDIE } from './statut-ligne-client.js'

/** v1: no measured yarn délai yet (lib/fil-appro.ts later): 4 working weeks. */
export const FIL_ESTIME_JOURS = 20

export interface EtapeDelai {
  /** what happens: « Fil », « Tricotage », « Ennoblissement », « Contrôle qualité », « Réserve Malterre » */
  libelle: string
  /** YYYYMMDD, step start and end */
  du: string
  au: string
  jours: number
  /** a figure that is not a partner's standard (the yarn estimate) */
  estime?: boolean
  /** the partner holding the matter on a launched order (« MATEL »), null = a standard step */
  partenaire?: string | null
  /** YYYYMMDD the délai that partner gave on its order; past = the step ends today (best case) */
  delai?: string | null
  /** the délai is past: the partner must be chased (the step is « if it delivers today ») */
  depasse?: boolean
  /** YYYYMMDD the partner's FIRST délai on that order, its engagement (LIVA #1364) */
  engagement?: string | null
  /** working days the current délai is behind that engagement (« retard MATEL 3 j »), in the partner's
   *  calendar; absent / 0 = on time */
  retard?: number
  /** the urgency asked of that partner and still awaited (lib/urgence-sst.ts), on a step without a délai
   *  as on one that has its délai (« can you go faster? ») */
  urgence?: UrgenceEtape
  /** a step still to launch, shortened to the date we plan to ask of the partner with the order
   *  (« Prévoir une urgence », lib/lancement-ligne.ts): nobody was asked yet */
  urgencePrevue?: boolean
}

/** The wait before a launch date still to come (doctrine des délais §5): the first step of a timeline
 *  computed from that date. */
export const ETAPE_ATTENTE = 'Attente du lancement'

/** The step a launch date holds, as the timeline names it. */
export type EtapePressee = 'Tricotage' | 'Ennoblissement'

/** An urgency asked of the partner of a step: its answer is awaited until `reponseAttendue`, then it is
 *  ours to chase. Dates YYYYMMDD; `dateSouhaitee` the date we wish. */
export interface UrgenceEtape { demandeeLe: string; reponseAttendue: string; aRelancer: boolean; dateSouhaitee?: string | null }

export interface DelaiAuPlusTot {
  /** YYYYMMDD */
  date: string
  /** the steps of the portion that decides the date */
  etapes: EtapeDelai[]
  /** part of the quantity has no matter reserved: reserving would shorten the délai */
  sansMatiere: boolean
  /** the doctrine's spending of the margin, when a later date is retained */
  plan?: PlanDoctrine | null
}

/** How the doctrine would spend the margin of a date retained (§4): shown, never written (Vincent
 *  2026-10-29: « la doctrine propose, l'opérateur décide »). No partner is handed margin (the knitter
 *  no longer is, Vincent 2026-11-16: a knitting order goes out without a date, the knitter gives its
 *  délai): the whole margin is écru waiting in stock with us, i.e. the dyeing's launch date. */
export interface PlanDoctrine {
  /** working days between the earliest date and the date retained (Malterre's calendar) */
  marge: number
  /** the margin, all of it: the écru waits in stock with us (working days) */
  attenteEcru: number
  /** the dyeing's launch date (§5), null on an écru line */
  ennoblirLe: string | null
}

export interface PartenaireDelai { standards: StandardsSst; fermetures: Periode[] }

export interface EntreeDelai {
  /** 'fini' needs a dyer, 'ecru' does not */
  kind: 'fini' | 'ecru'
  /** everything in the line's unit */
  quantite: number
  /** fini rolls reserved (shipped included); 0 on an écru line */
  fini: number
  /** of which not validated yet (En contrôle, Reprise, Attente décision): still in quality control */
  finiEnControle?: number
  /** YYYYMMDD the latest of those rolls came in, null = unknown (the control counted from today) */
  finiRecuLe?: string | null
  /** écru pieces reserved, not dyed yet */
  ecru: number
  /** écru still to knit on knitting orders */
  tricotage: number
  /** écru the reserved yarn can make */
  fil: number
  /** YYYYMMDD the reserved yarn arrives (supplier order), null = in stock */
  filAttenduLe: string | null
  /** the supplier order that yarn waits on (the latest one): its current date and its engagement
   *  (lib/report-delai-fil.ts). Given, the « Fil » step reads like a partner's: it ends on that date, or
   *  today when it is past, and carries the supplier's delay. Absent = filAttenduLe alone. */
  filCommande?: { partenaire: string | null; delai: string | null; engagement?: string | null } | null
  /** kg of écru per unit of the line (1 on a Kg line, 1 / rendement on Ml), null = unknown */
  kgParUnite: number | null
  aujourdhui: string
  tricoteur: PartenaireDelai
  ennoblisseur: PartenaireDelai
  /** Malterre's own closures (none recorded yet) */
  fermeturesMalterre?: Periode[]
  /** YYYYMMDD the date retained, for the doctrine's plan */
  dateRetenue?: string | null
  /** of `ecru`, the pieces already at a dyer on a launched order: its délai, not a standard from today */
  ecruChezEnnoblisseur?: MatiereChezPartenaire[]
  /** the knitting order(s) already launched for `tricotage`: their latest délai */
  tricotageLance?: { partenaire: string | null; delai: string | null; engagement?: string | null; urgence?: UrgenceEtape | null } | null
  /** the order is validated (« En cours »): no Malterre reserve, the line reads in margin / delay against
   *  its engagement (Vincent 2026-11-02: the reserve is a préparation concept) */
  enCours?: boolean
  /** the reference ships « dès la réception » (#1351): no quality control after the dyer */
  sansControle?: boolean
  /** `aujourdhui` is a launch date still to come (the line is computed as if it started that day): the
   *  real today (YYYYMMDD), so the timeline opens on the wait */
  attenteDepuis?: string | null
  /** an urgency planned with the launch: the step still to launch ends on the date we will ask
   *  (dateSouhaiteeUrgence) instead of the partner's standard */
  urgencePrevue?: { etape: EtapePressee; souhaitee: string } | null
}

/** Matter at a partner on a launched order, in the line's unit. `urgence`: asked of that partner on
 *  its order line and still awaiting its answer (lib/urgence-sst.ts). */
export interface MatiereChezPartenaire { quantite: number; partenaire: string | null; delai: string | null; engagement?: string | null; urgence?: UrgenceEtape | null }

const pos = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0)

export function delaiAuPlusTot(e: EntreeDelai): DelaiAuPlusTot | null {
  let reste = pos(e.quantite)
  if (reste <= 0) return null
  // Cascade, most advanced matter first, as the gauge reads it (lib/besoin-stades.ts).
  const prendre = (x: number) => { const p = Math.min(reste, pos(x)); reste -= p; return p }
  let enControle = 0
  if (e.kind === 'fini') {
    const nc = Math.min(pos(e.finiEnControle ?? 0), pos(e.fini))
    prendre(pos(e.fini) - nc)
    // Validated rolls covering SEUIL_EXPEDIE of the line ship it: what is still in control does not hold it.
    if (reste <= pos(e.quantite) * (1 - SEUIL_EXPEDIE) + 1e-9) prendre(nc)
    else enControle = prendre(nc)
  }
  const ecru = prendre(e.ecru)
  // Of that écru, what already sits at a dyer on a launched order (each with its délai).
  let ecruLibre = ecru
  const chezEnno: MatiereChezPartenaire[] = []
  for (const m of e.ecruChezEnnoblisseur ?? []) {
    const q = Math.min(ecruLibre, pos(m.quantite))
    if (q <= 0) continue
    ecruLibre -= q
    chezEnno.push({ ...m, quantite: q })
  }
  const tricotage = prendre(e.tricotage)
  const fil = prendre(e.fil)
  const rien = reste <= pos(e.quantite) * (1 - SEUIL_EXPEDIE) + 1e-9 ? 0 : reste

  // Knitter's band: the kg still to knit on the line; unknown conversion = the longest band (prudent).
  const aTricoterKg = e.kgParUnite != null && e.kgParUnite > 0 ? (tricotage + fil + rien) * e.kgParUnite : Infinity
  const joursTricot = tricotageJours(e.tricoteur.standards, aTricoterKg)
  const joursEnno = e.ennoblisseur.standards.ennoblissement_jours

  const malterre = e.fermeturesMalterre ?? []
  const controle = (du: string): EtapeDelai => {
    // A lot past its standard and still open ends today at best: we cannot be ready before validating it.
    const fin = ajouterJoursOuvres(du, CONTROLE_QUALITE_JOURS, malterre)
    return { libelle: 'Contrôle qualité', du, au: fin > e.aujourdhui ? fin : e.aujourdhui, jours: CONTROLE_QUALITE_JOURS }
  }
  /** A step at a partner on a launched order: ends on its délai, or today when the délai is past (« if it
   *  delivers today », Vincent 2026-11-02) — the user then gets a new délai and the date follows. Without
   *  a délai: the partner's standard from today, as an estimate. */
  const chezPartenaire = (libelle: string, m: { partenaire: string | null; delai: string | null; engagement?: string | null; urgence?: UrgenceEtape | null }, standard: number, ferm: Periode[]): EtapeDelai => {
    const delai = m.delai && /^\d{8}$/.test(m.delai) ? m.delai : null
    // While an urgency is asked the step stays what it was (the standard as an estimate, or the délai
    // given): nobody promised better yet.
    const urgence = m.urgence ? { urgence: m.urgence } : {}
    if (!delai) {
      const au = ajouterJoursOuvres(e.aujourdhui, standard, ferm)
      return { libelle, du: e.aujourdhui, au, jours: standard, estime: true, partenaire: m.partenaire, delai: null, ...urgence }
    }
    const au = delai > e.aujourdhui ? delai : e.aujourdhui
    // How late the partner already is on its own engagement (its reports, LIVA #1364).
    const engagement = m.engagement && /^\d{8}$/.test(m.engagement) ? m.engagement : null
    const retard = engagement && delai > engagement ? joursOuvresEntre(engagement, delai, ferm) : 0
    return {
      libelle, du: e.aujourdhui, au, jours: joursOuvresEntre(e.aujourdhui, au, ferm), partenaire: m.partenaire, delai, depasse: delai < e.aujourdhui,
      ...(engagement ? { engagement } : {}), ...(retard > 0 ? { retard } : {}), ...urgence,
    }
  }
  /** A step still to launch: the partner's standard, or the date we plan to ask when an urgency is
   *  planned with the launch and asks for less than the standard. */
  const aLancer = (libelle: EtapePressee, du: string, standard: number, ferm: Periode[]): EtapeDelai => {
    const au = ajouterJoursOuvres(du, standard, ferm)
    const u = e.urgencePrevue
    if (u && u.etape === libelle && u.souhaitee > du && u.souhaitee < au) {
      return { libelle, du, au: u.souhaitee, jours: joursOuvresEntre(du, u.souhaitee, ferm), urgencePrevue: true }
    }
    return { libelle, du, au, jours: standard }
  }
  const suite = (depart: string, avecTricot: boolean, tricotLance?: EtapeDelai): EtapeDelai[] => {
    const out: EtapeDelai[] = []
    let t = depart
    if (tricotLance) { out.push(tricotLance); t = tricotLance.au }
    else if (avecTricot) {
      const tricot = aLancer('Tricotage', t, joursTricot, e.tricoteur.fermetures)
      out.push(tricot); t = tricot.au
    }
    if (e.kind === 'fini') {
      const enno = aLancer('Ennoblissement', t, joursEnno, e.ennoblisseur.fermetures)
      out.push(enno)
      if (!e.sansControle) out.push(controle(enno.au))
    }
    return out
  }

  const portions: EtapeDelai[][] = []
  if (enControle > 0) {
    const recu = e.finiRecuLe && /^\d{8}$/.test(e.finiRecuLe) && e.finiRecuLe < e.aujourdhui ? e.finiRecuLe : e.aujourdhui
    portions.push([controle(recu)])
  }
  for (const m of chezEnno) {
    const enno = chezPartenaire('Ennoblissement', m, joursEnno, e.ennoblisseur.fermetures)
    portions.push(e.kind === 'fini' && !e.sansControle ? [enno, controle(enno.au)] : [enno])
  }
  if (ecruLibre > 0) portions.push(suite(e.aujourdhui, false))
  if (tricotage > 0) {
    const lance = e.tricotageLance ? chezPartenaire('Tricotage', e.tricotageLance, joursTricot, e.tricoteur.fermetures) : undefined
    portions.push(suite(e.aujourdhui, true, lance))
  }
  if (fil > 0) {
    if (e.filCommande) {
      // Yarn on a supplier order: its date, « if it delivers today » once past, and its delay on its engagement.
      const etape = chezPartenaire('Fil', e.filCommande, FIL_ESTIME_JOURS, [])
      portions.push([etape, ...suite(etape.au, true)])
    } else {
      const arrivee = e.filAttenduLe && e.filAttenduLe > e.aujourdhui ? e.filAttenduLe : null
      portions.push([
        ...(arrivee ? [{ libelle: 'Fil', du: e.aujourdhui, au: arrivee, jours: joursOuvresEntre(e.aujourdhui, arrivee) }] : []),
        ...suite(arrivee ?? e.aujourdhui, true),
      ])
    }
  }
  if (rien > 0) {
    const au = ajouterJoursOuvres(e.aujourdhui, FIL_ESTIME_JOURS)
    portions.push([{ libelle: 'Fil', du: e.aujourdhui, au, jours: FIL_ESTIME_JOURS, estime: true }, ...suite(au, true)])
  }

  const fin = (p: EtapeDelai[]) => p[p.length - 1]?.au ?? e.aujourdhui
  const portion = portions.reduce<EtapeDelai[] | null>((m, p) => (m == null || fin(p) > fin(m) ? p : m), null)
  if (!portion || portion.length === 0) return { date: e.aujourdhui, etapes: [], sansMatiere: false }
  // Computed from a launch date still to come: the timeline opens on the wait until that day.
  const attente: EtapeDelai[] = e.attenteDepuis && /^\d{8}$/.test(e.attenteDepuis) && e.attenteDepuis < e.aujourdhui
    ? [{ libelle: ETAPE_ATTENTE, du: e.attenteDepuis, au: e.aujourdhui, jours: joursOuvresEntre(e.attenteDepuis, e.aujourdhui, malterre) }]
    : []
  const decisive = [...attente, ...portion]
  if (e.enCours) {
    // En cours: the date the matter can really be ready, no reserve; read against the engagement.
    return { date: fin(decisive), etapes: decisive, sansMatiere: rien > 0, plan: null }
  }
  const debutReserve = fin(decisive)
  const plan = planDoctrine(e, decisive, ajouterJoursOuvres(debutReserve, RESERVE_MALTERRE_JOURS, e.fermeturesMalterre ?? []))
  const date = ajouterJoursOuvres(debutReserve, RESERVE_MALTERRE_JOURS, malterre)
  return {
    date,
    etapes: [...decisive, { libelle: 'Réserve Malterre', du: debutReserve, au: date, jours: RESERVE_MALTERRE_JOURS }],
    sansMatiere: rien > 0,
    plan,
  }
}

/** Doctrine §4 on the deciding portion: every partner gets its standard alone (the knitter too since
 *  2026-11-16: its order names no date, it gives its délai), so the whole margin is the écru waiting
 *  with us after the knitting, i.e. the dyeing's launch date. Null without a date retained beyond the
 *  earliest one. */
function planDoctrine(e: EntreeDelai, etapes: EtapeDelai[], auPlusTot: string): PlanDoctrine | null {
  const d = e.dateRetenue
  if (!d || !/^\d{8}$/.test(d) || d <= auPlusTot) return null
  const marge = joursOuvresEntre(auPlusTot, d, e.fermeturesMalterre ?? [])
  if (marge <= 0) return null
  const enno = etapes.find((x) => x.libelle === 'Ennoblissement')
  const ennoblirLe = enno ? ajouterJoursOuvres(enno.du, marge, e.fermeturesMalterre ?? []) : null
  return { marge, attenteEcru: marge, ennoblirLe }
}

/** « Prévoir une urgence » (Vincent 2026-11-23): the date to ask of the partner whose step a launch
 *  date holds, so that the line is ready on the client's date `delaiClient` — that date walked back
 *  through what comes after the step (our quality control, and the dyer's standard when the knitter
 *  is the one pressed), each in its own working days, then brought to a day the partner works: 5
 *  working days of control before Friday 18/12 = the dyer back by Sunday 13/12, so Friday 11/12 is
 *  the date to ask. Computed, never typed. Null when the step does not exist on the line (no dyer on
 *  an écru line). Pure. */
export function dateSouhaiteeUrgence(p: {
  etape: EtapePressee
  kind: 'fini' | 'ecru'
  /** YYYYMMDD */
  delaiClient: string
  sansControle?: boolean
  tricoteur: PartenaireDelai
  ennoblisseur: PartenaireDelai
  fermeturesMalterre?: Periode[]
}): string | null {
  if (!/^\d{8}$/.test(p.delaiClient)) return null
  if (p.kind === 'ecru') return p.etape === 'Tricotage' ? dernierOuvre(p.delaiClient, p.tricoteur.fermetures) : null
  const retourEnno = p.sansControle ? p.delaiClient : dernierDepart(p.delaiClient, CONTROLE_QUALITE_JOURS, p.fermeturesMalterre ?? [])
  if (p.etape === 'Ennoblissement') return dernierOuvre(retourEnno, p.ennoblisseur.fermetures)
  const retourTricot = dernierDepart(retourEnno, p.ennoblisseur.standards.ennoblissement_jours, p.ennoblisseur.fermetures)
  return dernierOuvre(retourTricot, p.tricoteur.fermetures)
}

// ── Partners (I/O) ──────────────────────────────────────────

/** v1 partners: Tricotage Malterre knits, MATEL dyes (the line's own partners later). */
export const TRICOTEUR_DEFAUT = 1
export const ENNOBLISSEUR_DEFAUT = MATEL_IDSOUS_TRAITANT

export async function partenairesParDefaut(): Promise<{ tricoteur: PartenaireDelai; ennoblisseur: PartenaireDelai }> {
  const ids = [TRICOTEUR_DEFAUT, ENNOBLISSEUR_DEFAUT]
  const [s, f] = await Promise.all([standards(ids), fermetures(ids)])
  const de = (id: number): PartenaireDelai => ({ standards: s.get(id)!, fermetures: (f.get(id) ?? []).map(({ du, au }) => ({ du, au })) })
  return { tricoteur: de(TRICOTEUR_DEFAUT), ennoblisseur: de(ENNOBLISSEUR_DEFAUT) }
}

/** Today as YYYYMMDD, local time. */
export function aujourdhuiYmd(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
