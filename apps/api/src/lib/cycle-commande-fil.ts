// Fils › Commandes — the life of a yarn order after its yarn is received
// (decision Vincent 2026-10-13, follow-up of LIVA #1292).
//
// `commande_fil.etat` stays what it always was: 1 = every line received (the
// lines are then locked). On top of it the order is only « terminée » when
// nothing is missing any more:
//   - certificat : every received lot of an organic yarn (`ref_fil.bio = 1`)
//                  is covered by a GOTS transaction certificate (ged type 5) —
//                  one linked to that lot through `stock_fil_ged`, or one with
//                  no lot link at all (the screen's long-standing rule: a
//                  document without lots applies to every lot of the order) ;
//   - facture    : at least one supplier invoice (ged type 1) is attached ;
//   - paiement   : every attached invoice is ticked « réglée » (#1292).
// Nobody moves these states by hand: they follow the documents. The one
// escape is « Clôturer quand même » (its own right, journaled with a reason
// in `commande_fil_cloture`), for a supplier that never sends the certificate
// or an invoice paid outside the circuit.
//
// Only orders dated from 2026-01-01 obey the rule; older ones stay terminée
// and their gaps are shown for information (`manques`).

import { mpsPg } from './mps-pg.js'
import { etatsArbitrage } from './arbitrage-fil.js'

import { TYPE_DOC_FACTURE_FIL } from './facture-fil-reglement.js'
export const TYPE_DOC_CERTIFICAT_GOTS = 5
/** First order date (inclusive, ISO) the cycle applies to. */
export const DEBUT_CYCLE_COMMANDE_FIL = '2026-01-01'

// arbitrage: a line received short of what client lines reserved on it, its split not yet checked by
// a person (lib/arbitrage-fil.ts, Vincent 2026-10-30).
export type AttenteCommandeFil = 'arbitrage' | 'certificat' | 'facture' | 'paiement'
export const ORDRE_ATTENTES: AttenteCommandeFil[] = ['arbitrage', 'certificat', 'facture', 'paiement']

export interface LotBio {
  IDstock_fil: number
  lot: string | null
  /** Covered by a GOTS certificate of the order. */
  certifie: boolean
  /** Stock entry (ISO date) — when it was received. */
  date_entree: string | null
}

export interface ClotureForcee {
  /** ISO local date-time (Europe/Paris). */
  le: string
  par: string | null
  motif: string
}

export interface FaitsCommandeFil {
  etat: number
  /** The order date falls on or after DEBUT_CYCLE_COMMANDE_FIL. */
  sousRegle: boolean
  lotsBio: LotBio[]
  nbFactures: number
  nbFacturesARegler: number
  clotureForcee: ClotureForcee | null
  /** First lot received on the order (ISO date), null = none yet. */
  premiereReception: string | null
  /** The order's échéance in days (« à réception » = 0), null = not set. */
  delaiPaiementJours: number | null
  /** Lines received short whose split between client lines no person has checked yet. */
  lignesAArbitrer?: number
}

export interface CycleCommandeFil {
  /** en_cours = yarn still awaited; attente = received, something missing. */
  etape: 'en_cours' | 'attente' | 'terminee'
  /** What keeps the order open (empty unless etape = attente). */
  attentes: AttenteCommandeFil[]
  /** What is missing whatever the stage or the date — the information shown
   *  on an order still awaiting yarn, or on one older than the rule. */
  manques: AttenteCommandeFil[]
  sous_regle: boolean
  lots_bio: LotBio[]
  lots_bio_sans_certificat: number
  nb_factures: number
  factures_a_regler: number
  cloture_forcee: ClotureForcee | null
  premiere_reception: string | null
  delai_paiement_jours: number | null
  lignes_a_arbitrer: number
}

export function cycleCommandeFil(f: FaitsCommandeFil): CycleCommandeFil {
  const sansCertificat = f.lotsBio.filter((l) => !l.certifie).length
  const manques: AttenteCommandeFil[] = []
  if ((f.lignesAArbitrer ?? 0) > 0) manques.push('arbitrage')
  if (sansCertificat > 0) manques.push('certificat')
  if (f.nbFactures === 0) manques.push('facture')
  if (f.nbFacturesARegler > 0) manques.push('paiement')

  let etape: CycleCommandeFil['etape']
  let attentes: AttenteCommandeFil[] = []
  if (f.etat !== 1) etape = 'en_cours'
  // The split of a short reception is checked by a person whatever the order's date (never by a forced close).
  else if (!f.sousRegle || f.clotureForcee) {
    attentes = manques.filter((a) => a === 'arbitrage')
    etape = attentes.length > 0 ? 'attente' : 'terminee'
  }
  else {
    attentes = manques
    etape = attentes.length > 0 ? 'attente' : 'terminee'
  }

  return {
    etape,
    attentes,
    manques,
    sous_regle: f.sousRegle,
    lots_bio: f.lotsBio,
    lots_bio_sans_certificat: sansCertificat,
    nb_factures: f.nbFactures,
    factures_a_regler: f.nbFacturesARegler,
    // A forced close only means something while the yarn is received.
    cloture_forcee: f.etat === 1 ? f.clotureForcee : null,
    premiere_reception: f.premiereReception,
    delai_paiement_jours: f.delaiPaiementJours,
    lignes_a_arbitrer: f.lignesAArbitrer ?? 0,
  }
}

/** A lot is covered when one certificate of the order names it, or when one
 *  certificate of the order names no lot at all (applies to every lot). */
export function lotCertifie(
  idStockFil: number,
  certificats: Array<{ lots: number[] }>,
): boolean {
  return certificats.some((c) => c.lots.length === 0 || c.lots.includes(idStockFil))
}

// ── What there is to do, and when (the list's liseré + red / amber counters) ──
//
// rouge = to do now, ambre = can be done now, not yet imperative (doctrine of
// Clients › Commandes, mps_designer §41). Thresholds measured on prod
// 2023-01 → 2026-10 (13/10/2026, the PDFs' own CreationDate against the stock
// entry of the order's lots — `ged` keeps no date):
//   - certificat GOTS: 76 certificates, issued p50 34 d / p80 72 d / p90 119 d
//     after the first lot came in → ambre from 35 d, rouge from 75 d ;
//   - facture: 244 invoices, dated p50 6 d BEFORE the first lot, p90 the day
//     it came in — it travels with the yarn → ambre as soon as the yarn is in,
//     rouge from 15 d ;
//   - paiement: no history (the « Réglée » tick exists since 13/10/2026) and
//     130/172 orders since 2025 are « à réception » → due date = first lot +
//     the order's échéance; ambre from the due date, rouge 15 d later.
//     PROVISIONAL — re-measure once a few months of ticks exist.
//   - yarn awaited: the screen's long-standing delivery rule — rouge = earliest
//     open line late or without a date, ambre = within 3 days.
export const SEUILS_URGENCE_FIL = {
  certificatAmbreJours: 35,
  certificatRougeJours: 75,
  factureRougeJours: 15,
  paiementRougeJours: 15,
  livraisonAmbreJours: 3,
} as const

export type NiveauUrgenceFil = 'rouge' | 'ambre'
export interface UrgenceCommandeFil {
  niveau: NiveauUrgenceFil
  raison: string
}

const jourIso = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000
const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/**
 * @param earliestDelivery earliest `date_livraison` (YYYYMMDD) of the open lines
 * @param today ISO date (Europe/Paris)
 */
export function urgenceCommandeFil(
  c: CycleCommandeFil,
  earliestDelivery: string | null,
  today: string,
): UrgenceCommandeFil | null {
  const t = jourIso(today)
  const S = SEUILS_URGENCE_FIL

  if (c.etape === 'terminee') return null
  // A short reception to check: amber, the default split is sound, checking it gets us ahead.
  const arbitrage: UrgenceCommandeFil | null = c.lignes_a_arbitrer > 0
    ? { niveau: 'ambre', raison: 'Répartition du fil reçu à vérifier' } : null
  if (c.etape === 'en_cours') {
    if (!earliestDelivery || !/^\d{8}$/.test(earliestDelivery)) return { niveau: 'rouge', raison: 'Sans date de livraison' }
    const iso = `${earliestDelivery.slice(0, 4)}-${earliestDelivery.slice(4, 6)}-${earliestDelivery.slice(6, 8)}`
    const d = jourIso(iso) - t
    if (d <= 0) return { niveau: 'rouge', raison: `Livraison en retard · ${ddmm(iso)}` }
    if (d <= S.livraisonAmbreJours) return { niveau: 'ambre', raison: `Livraison le ${ddmm(iso)}` }
    return arbitrage
  }

  // attente: each missing document on its own clock, the most urgent wins.
  const found: UrgenceCommandeFil[] = []
  const recu = c.premiere_reception
  for (const a of c.attentes) {
    if (a === 'arbitrage') { if (arbitrage) found.push(arbitrage); continue }
    if (a === 'certificat') {
      const dates = c.lots_bio.filter((l) => !l.certifie && l.date_entree).map((l) => jourIso(l.date_entree!))
      if (dates.length === 0) { found.push({ niveau: 'ambre', raison: 'Certificat GOTS manquant' }); continue }
      const j = t - Math.min(...dates)
      if (j >= S.certificatRougeJours) found.push({ niveau: 'rouge', raison: `Certificat GOTS · reçu il y a ${j} j` })
      else if (j >= S.certificatAmbreJours) found.push({ niveau: 'ambre', raison: `Certificat GOTS · reçu il y a ${j} j` })
    } else if (a === 'facture') {
      const j = recu ? t - jourIso(recu) : 0
      found.push({
        niveau: j >= S.factureRougeJours ? 'rouge' : 'ambre',
        raison: recu ? `Facture à joindre · reçu il y a ${j} j` : 'Facture à joindre',
      })
    } else {
      if (!recu) continue
      const echeance = jourIso(recu) + (c.delai_paiement_jours ?? 0)
      const retard = t - echeance
      if (retard >= S.paiementRougeJours) found.push({ niveau: 'rouge', raison: `À régler · échue depuis ${retard} j` })
      else if (retard >= 0) found.push({ niveau: 'ambre', raison: retard === 0 ? 'À régler · échue aujourd’hui' : `À régler · échue depuis ${retard} j` })
    }
  }
  return found.find((u) => u.niveau === 'rouge') ?? found[0] ?? null
}

/** Today in Europe/Paris, ISO. */
export function aujourdhuiParis(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(new Date())
}

/** The cycle of each given order, read in one pass (5 queries whatever the
 *  number of orders). Unknown ids are absent from the map. */
export async function cyclesCommandesFil(ids: number[]): Promise<Map<number, CycleCommandeFil>> {
  const out = new Map<number, CycleCommandeFil>()
  if (ids.length === 0) return out
  const sql = mpsPg()

  const [entetes, lots, certificats, factures, clotures, lignes] = await Promise.all([
    sql<{ id: number; etat: number; sous_regle: boolean; delai: number | null; premiere_reception: string | null }[]>`
      SELECT cf.idcommande_fil::int AS id, coalesce(cf.etat, 0)::int AS etat,
             coalesce(cf.date_commande >= ${DEBUT_CYCLE_COMMANDE_FIL}::date, false) AS sous_regle,
             e.nb_jours::int AS delai,
             (SELECT min(sf.date_entree)::text FROM stock_fil sf
              JOIN ref_fil_commande r ON r.idref_fil_commande = sf.idref_fil_commande
              WHERE r.idcommande_fil = cf.idcommande_fil) AS premiere_reception
      FROM commande_fil cf
      LEFT JOIN echeance e ON e.idecheance = cf.idecheance AND cf.idecheance > 0
      WHERE cf.idcommande_fil = ANY(${ids})`,
    sql<{ id: number; idstock_fil: number; lot: string | null; date_entree: string | null }[]>`
      SELECT rfc.idcommande_fil::int AS id, sf.idstock_fil::int AS idstock_fil, sf.lot::text AS lot,
             sf.date_entree::text AS date_entree
      FROM stock_fil sf
      JOIN ref_fil_commande rfc ON rfc.idref_fil_commande = sf.idref_fil_commande
      JOIN ref_fil rf ON rf.idref_fil = sf.idref_fil
      WHERE rfc.idcommande_fil = ANY(${ids}) AND rf.bio = 1
      ORDER BY sf.lot, sf.idstock_fil`,
    sql<{ id: number; lots: number[] }[]>`
      SELECT g.idreference::int AS id,
             coalesce(array_agg(x.idstock_fil::int) FILTER (WHERE x.idstock_fil IS NOT NULL), '{}') AS lots
      FROM ged g
      LEFT JOIN stock_fil_ged x ON x.idged = g.idged
      WHERE g.idreference = ANY(${ids}) AND g.idtype_doc = ${TYPE_DOC_CERTIFICAT_GOTS}
      GROUP BY g.idged, g.idreference`,
    sql<{ id: number; n: number; a_regler: number }[]>`
      SELECT idreference::int AS id, count(*)::int AS n,
             count(*) FILTER (WHERE regle_le IS NULL)::int AS a_regler
      FROM ged
      WHERE idreference = ANY(${ids}) AND idtype_doc = ${TYPE_DOC_FACTURE_FIL}
      GROUP BY idreference`,
    sql<{ id: number; action: string; le: string; par: string | null; motif: string }[]>`
      SELECT DISTINCT ON (idcommande_fil)
             idcommande_fil::int AS id, action,
             to_char(le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD"T"HH24:MI') AS le, par, motif
      FROM commande_fil_cloture
      WHERE idcommande_fil = ANY(${ids})
      ORDER BY idcommande_fil, le DESC, id DESC`,
    sql<{ id: number; ligne: number }[]>`
      SELECT idcommande_fil::int AS id, idref_fil_commande::int AS ligne FROM ref_fil_commande
      WHERE idcommande_fil = ANY(${ids})`,
  ])
  const arbitrages = await etatsArbitrage(lignes.map((l) => l.ligne))
  const aArbitrer = new Map<number, number>()
  for (const l of lignes) if (arbitrages.get(l.ligne)?.a_arbitrer) aArbitrer.set(l.id, (aArbitrer.get(l.id) ?? 0) + 1)

  const certsParCommande = new Map<number, Array<{ lots: number[] }>>()
  for (const c of certificats) {
    const arr = certsParCommande.get(c.id) ?? []
    arr.push({ lots: c.lots })
    certsParCommande.set(c.id, arr)
  }
  const lotsParCommande = new Map<number, Array<{ idstock_fil: number; lot: string | null; date_entree: string | null }>>()
  for (const l of lots) {
    const arr = lotsParCommande.get(l.id) ?? []
    arr.push(l)
    lotsParCommande.set(l.id, arr)
  }
  const facturesParCommande = new Map(factures.map((f) => [f.id, f]))
  const clotureParCommande = new Map(clotures.map((c) => [c.id, c]))

  for (const e of entetes) {
    const certs = certsParCommande.get(e.id) ?? []
    const f = facturesParCommande.get(e.id)
    const c = clotureParCommande.get(e.id)
    out.set(e.id, cycleCommandeFil({
      etat: e.etat,
      sousRegle: e.sous_regle,
      lotsBio: (lotsParCommande.get(e.id) ?? []).map((l) => ({
        IDstock_fil: l.idstock_fil,
        lot: l.lot?.trim() || null,
        certifie: lotCertifie(l.idstock_fil, certs),
        date_entree: l.date_entree,
      })),
      nbFactures: f?.n ?? 0,
      nbFacturesARegler: f?.a_regler ?? 0,
      clotureForcee: c && c.action === 'cloture' ? { le: c.le, par: c.par, motif: c.motif } : null,
      premiereReception: e.premiere_reception,
      delaiPaiementJours: e.delai,
      lignesAArbitrer: aArbitrer.get(e.id) ?? 0,
    }))
  }
  return out
}

/** Whether the order's latest journal row is a forced close. */
export async function clotureForceeActive(commandeId: number): Promise<boolean> {
  const rows = await mpsPg()<{ action: string }[]>`
    SELECT action FROM commande_fil_cloture
    WHERE idcommande_fil = ${commandeId}
    ORDER BY le DESC, id DESC LIMIT 1`
  return rows[0]?.action === 'cloture'
}

/** Journal a forced close (or its cancellation). */
export async function journaliserCloture(
  commandeId: number,
  action: 'cloture' | 'annulation',
  par: { id: number; nom: string } | null,
  motif: string,
): Promise<void> {
  await mpsPg()`
    INSERT INTO commande_fil_cloture (idcommande_fil, action, le, par_id, par, motif)
    VALUES (${commandeId}, ${action}, now(), ${par?.id ?? null}, ${par?.nom ?? null}, ${motif})`
}
