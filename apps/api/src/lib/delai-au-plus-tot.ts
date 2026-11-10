// The earliest date a client line can be ready (doctrine des délais §5 ter, Vincent 2026-10-29): computed
// live from where its matter sits, never typed. Each portion of the line's quantity goes through the steps
// still ahead of it, each partner in its own working days (lib/jours-ouvres.ts, its closures included):
//   fini rolls validated           → ready now
//   fini rolls not validated yet   → the rest of the quality control, counted from their reception
//   écru pieces reserved           → dyer, then quality control
//   écru still to knit (orders)    → knitter, then dyer, then quality control
//   yarn reserved                  → from the supplier's date (or today if in stock), knitter, dyer, control
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

import { ajouterJoursOuvres, joursOuvresEntre, type Periode } from './jours-ouvres.js'
import { CONTROLE_QUALITE_JOURS, MARGE_TRICOTEUR_MAX_JOURS, RESERVE_MALTERRE_JOURS, fermetures, standards, tricotageJours, type StandardsSst } from './delais-standards.js'
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
}

export interface DelaiAuPlusTot {
  /** YYYYMMDD */
  date: string
  /** the steps of the portion that decides the date */
  etapes: EtapeDelai[]
  /** part of the quantity has no matter reserved: reserving would shorten the délai */
  sansMatiere: boolean
  /** the doctrine's spending of the margin, when a later date is retained */
  plan?: PlanDoctrine | null
  /** what to ask the knitter if the knitting were launched today: its standard + its share of the margin,
   *  from today in its calendar (the launch dialog's proposal); null without a knitting step */
  tricotageDemande?: { jours: number; date: string } | null
}

/** How the doctrine would spend the margin of a date retained (§4): shown, never written (Vincent
 *  2026-10-29: « la doctrine propose, l'opérateur décide »). */
export interface PlanDoctrine {
  /** working days between the earliest date and the date retained (Malterre's calendar) */
  marge: number
  /** the knitter's délai to ask: standard + its share, null without a knitting step */
  tricotage: { standard: number; marge: number; jours: number; fin: string } | null
  /** what is left after the knitter: the écru waits in stock with us (working days) */
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
  tricotageLance?: { partenaire: string | null; delai: string | null; engagement?: string | null } | null
  /** the order is validated (« En cours »): no Malterre reserve, the line reads in margin / delay against
   *  its engagement (Vincent 2026-11-02: the reserve is a préparation concept) */
  enCours?: boolean
}

/** Matter at a partner on a launched order, in the line's unit. */
export interface MatiereChezPartenaire { quantite: number; partenaire: string | null; delai: string | null; engagement?: string | null }

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
  const chezPartenaire = (libelle: string, m: { partenaire: string | null; delai: string | null; engagement?: string | null }, standard: number, ferm: Periode[]): EtapeDelai => {
    const delai = m.delai && /^\d{8}$/.test(m.delai) ? m.delai : null
    if (!delai) {
      const au = ajouterJoursOuvres(e.aujourdhui, standard, ferm)
      return { libelle, du: e.aujourdhui, au, jours: standard, estime: true, partenaire: m.partenaire, delai: null }
    }
    const au = delai > e.aujourdhui ? delai : e.aujourdhui
    // How late the partner already is on its own engagement (its reports, LIVA #1364).
    const engagement = m.engagement && /^\d{8}$/.test(m.engagement) ? m.engagement : null
    const retard = engagement && delai > engagement ? joursOuvresEntre(engagement, delai, ferm) : 0
    return {
      libelle, du: e.aujourdhui, au, jours: joursOuvresEntre(e.aujourdhui, au, ferm), partenaire: m.partenaire, delai, depasse: delai < e.aujourdhui,
      ...(engagement ? { engagement } : {}), ...(retard > 0 ? { retard } : {}),
    }
  }
  const suite = (depart: string, avecTricot: boolean, tricotLance?: EtapeDelai): EtapeDelai[] => {
    const out: EtapeDelai[] = []
    let t = depart
    if (tricotLance) { out.push(tricotLance); t = tricotLance.au }
    else if (avecTricot) {
      const au = ajouterJoursOuvres(t, joursTricot, e.tricoteur.fermetures)
      out.push({ libelle: 'Tricotage', du: t, au, jours: joursTricot }); t = au
    }
    if (e.kind === 'fini') {
      const au = ajouterJoursOuvres(t, joursEnno, e.ennoblisseur.fermetures)
      out.push({ libelle: 'Ennoblissement', du: t, au, jours: joursEnno })
      out.push(controle(au))
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
    portions.push(e.kind === 'fini' ? [enno, controle(enno.au)] : [enno])
  }
  if (ecruLibre > 0) portions.push(suite(e.aujourdhui, false))
  if (tricotage > 0) {
    const lance = e.tricotageLance ? chezPartenaire('Tricotage', e.tricotageLance, joursTricot, e.tricoteur.fermetures) : undefined
    portions.push(suite(e.aujourdhui, true, lance))
  }
  if (fil > 0) {
    const arrivee = e.filAttenduLe && e.filAttenduLe > e.aujourdhui ? e.filAttenduLe : null
    portions.push([
      ...(arrivee ? [{ libelle: 'Fil', du: e.aujourdhui, au: arrivee, jours: joursOuvresEntre(e.aujourdhui, arrivee) }] : []),
      ...suite(arrivee ?? e.aujourdhui, true),
    ])
  }
  if (rien > 0) {
    const au = ajouterJoursOuvres(e.aujourdhui, FIL_ESTIME_JOURS)
    portions.push([{ libelle: 'Fil', du: e.aujourdhui, au, jours: FIL_ESTIME_JOURS, estime: true }, ...suite(au, true)])
  }

  const fin = (p: EtapeDelai[]) => p[p.length - 1]?.au ?? e.aujourdhui
  const decisive = portions.reduce<EtapeDelai[] | null>((m, p) => (m == null || fin(p) > fin(m) ? p : m), null)
  if (!decisive || decisive.length === 0) return { date: e.aujourdhui, etapes: [], sansMatiere: false }
  if (e.enCours) {
    // En cours: the date the matter can really be ready, no reserve; read against the engagement.
    // The launch dialog still asks the knitter its standard (no margin to spend here).
    const t = decisive.find((x) => x.libelle === 'Tricotage' && !x.partenaire)
    return {
      date: fin(decisive), etapes: decisive, sansMatiere: rien > 0, plan: null,
      tricotageDemande: t ? { jours: t.jours, date: ajouterJoursOuvres(e.aujourdhui, t.jours, e.tricoteur.fermetures) } : null,
    }
  }
  const debutReserve = fin(decisive)
  const plan = planDoctrine(e, decisive, ajouterJoursOuvres(debutReserve, RESERVE_MALTERRE_JOURS, e.fermeturesMalterre ?? []))
  const jTricot = plan?.tricotage?.jours ?? decisive.find((x) => x.libelle === 'Tricotage')?.jours ?? null
  const tricotageDemande = jTricot != null
    ? { jours: jTricot, date: ajouterJoursOuvres(e.aujourdhui, jTricot, e.tricoteur.fermetures) }
    : null
  const date = ajouterJoursOuvres(debutReserve, RESERVE_MALTERRE_JOURS, malterre)
  return {
    date,
    etapes: [...decisive, { libelle: 'Réserve Malterre', du: debutReserve, au: date, jours: RESERVE_MALTERRE_JOURS }],
    sansMatiere: rien > 0,
    plan,
    tricotageDemande,
  }
}

/** Doctrine §4 on the deciding portion: the knitter gets the margin first, up to 4 working weeks on top
 *  of its standard; the rest is the écru waiting with us, i.e. the dyeing's launch date. The dyer always
 *  gets its standard alone. Null without a date retained beyond the earliest one. */
function planDoctrine(e: EntreeDelai, etapes: EtapeDelai[], auPlusTot: string): PlanDoctrine | null {
  const d = e.dateRetenue
  if (!d || !/^\d{8}$/.test(d) || d <= auPlusTot) return null
  const marge = joursOuvresEntre(auPlusTot, d, e.fermeturesMalterre ?? [])
  if (marge <= 0) return null
  const trico = etapes.find((x) => x.libelle === 'Tricotage')
  const enno = etapes.find((x) => x.libelle === 'Ennoblissement')
  const part = trico ? Math.min(marge, MARGE_TRICOTEUR_MAX_JOURS) : 0
  const tricotage = trico
    ? { standard: trico.jours, marge: part, jours: trico.jours + part, fin: ajouterJoursOuvres(trico.du, trico.jours + part, e.tricoteur.fermetures) }
    : null
  const attenteEcru = marge - part
  const ennoblirLe = enno
    ? ajouterJoursOuvres(tricotage?.fin ?? enno.du, attenteEcru, e.fermeturesMalterre ?? [])
    : null
  return { marge, tricotage, attenteEcru, ennoblirLe }
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
