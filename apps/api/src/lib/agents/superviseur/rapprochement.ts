// Agent « Superviseur » — « every order received by mail is entered in ETM and
// correct »: the pure matching of an order read from a client mail (Mistral)
// against the client's ETM orders (tested in rapprochement.test.ts).
//
// Match order: the client's order number found in `ref_client` (where the
// office types « Commande A3-58281 DU 23/03/2026 »), else the order entered
// closest after the mail with a total quantity within 15 %. Differences are
// reported only when both sides carry the figure (a PO without prices is not
// « a price mismatch »).

export interface LigneExtraite {
  designation: string
  reference_client: string
  coloris: string
  quantite: number | null
  unite: string
  prix_unitaire: number | null
  delai: string
}

export interface CommandeExtraite {
  type_message: 'nouvelle_commande' | 'modification' | 'autre'
  numero_commande_client: string
  lignes: LigneExtraite[]
}

export interface CommandeEtm {
  id: number
  numero: number
  /** YYYYMMDD */
  dateCommande: string
  refClient: string
  /** 1 ETM, 2 TRM — a TRM match only proves the order is entered: its
   *  quantities are not ETM's business (Sofileta knitting job, 2 626 kg mailed
   *  as a whole programme, 600 kg entered as the first call-off). */
  societe: number
  /** Not soldée — a framework order the client calls off over months. */
  ouverte: boolean
  lignes: Array<{ quantite: number; unite: number; prix: number }>
}

/** Letters and digits only, uppercase — « A3-58281 » and « a3 58281 » match. */
export const normRef = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/** ETM units: 1 = Kg, 3 = Ml, 4 = U (pieces — Unicycle orders « 5 pièces »). */
export type Unite = 1 | 3 | 4
const LIBELLE_UNITE: Record<Unite, string> = { 1: 'kg', 3: 'Ml', 4: 'U' }

/** The client writes « m », « ml », « mètres », « kg », « pièces »… */
export function uniteEtm(u: string): Unite | null {
  const x = u.toLowerCase().replace(/[^a-zè]/g, '')
  if (/^(kg|kgs|kilo|kilos|kilogrammes?)$/.test(x)) return 1
  if (/^(m|ml|mt|mts|metres?|mètres?|meters?|mlineaires?)$/.test(x)) return 3
  if (/^(u|un|unites?|unités?|pc|pcs|pieces?|pièces?|rlx|rouleaux?)$/.test(x)) return 4
  return null
}

export const TOLERANCE_QUANTITE = 0.05
export const TOLERANCE_PRIX = 0.01
export const TOLERANCE_RAPPROCHEMENT = 0.15

function totalExtrait(c: CommandeExtraite): Map<Unite, number> {
  const t = new Map<Unite, number>()
  for (const l of c.lignes) {
    const u = uniteEtm(l.unite)
    if (u && l.quantite && l.quantite > 0) t.set(u, (t.get(u) ?? 0) + l.quantite)
  }
  return t
}

function totalEtm(c: CommandeEtm): Map<Unite, number> {
  const t = new Map<Unite, number>()
  for (const l of c.lignes) if ((l.unite === 1 || l.unite === 3 || l.unite === 4) && l.quantite > 0) t.set(l.unite, (t.get(l.unite) ?? 0) + l.quantite)
  return t
}

const proche = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(a, b)

export type Rapprochement =
  | { statut: 'trouvee'; commande: CommandeEtm; par: 'numero' | 'quantite' | 'ouverte' | 'date'; ecarts: string[] }
  | { statut: 'absente' }

/** A call-off on a still-open order: one of its lines has the same quantity
 *  (±5 %, same unit) or the same unit price (±1 %) as a line of the mail
 *  (Idylle N°3807, June: 4 × 105 Ml at 8,95 € — the September « point
 *  commande » mail quoted 105 m and 8,95 €, and read as a missing order). */
function appelSurCommande(ext: CommandeExtraite, c: CommandeEtm): boolean {
  if (!c.ouverte) return false
  return ext.lignes.some((l) => c.lignes.some((e) =>
    (l.quantite != null && uniteEtm(l.unite) === e.unite && proche(l.quantite, e.quantite, TOLERANCE_QUANTITE)) ||
    (l.prix_unitaire != null && e.prix > 0 && proche(l.prix_unitaire, e.prix, TOLERANCE_PRIX))))
}

/** Match, most certain first (benchmark 60 days, 2026-09-23):
 *   1. the client's order number in `ref_client`, or equal to OUR number (a
 *      reply to « Confirmation de commande N°3871 » quotes ours) — `commandes`
 *      also holds the orders found by that number for ANY client, ETM or TRM
 *      (a knitting job for Sofileta is a TRM order under another client row);
 *   2. an order entered from `dateMin` (mail − 7 d: taken by phone, confirmed
 *      by mail later) with the same total per unit (±15 %);
 *   3. a still-open order of the client (any date) the mail calls off — same
 *      quantity or same price on one line (appelSurCommande), no écart;
 *   4. any order of the client entered from `dateEntree` (mail − 2 d): it is
 *      there, the quantities just differ — reported as an écart, not as a
 *      missing order (Atelier Bulle: 200 kg mailed, 2 × 200 kg entered).
 *  « absente » only when none of these holds. */
export function rapprocher(ext: CommandeExtraite, dates: { dateMin: string; dateEntree: string }, commandes: CommandeEtm[]): Rapprochement {
  const po = normRef(ext.numero_commande_client)
  const parDate = [...commandes].sort((a, b) => a.dateCommande.localeCompare(b.dateCommande))
  let trouvee: CommandeEtm | undefined
  let par: 'numero' | 'quantite' | 'ouverte' | 'date' = 'numero'
  if (po.length >= 3) {
    // Several orders may quote the number (a repeat order): the closest to the mail.
    const vise = dates.dateEntree
    trouvee = parDate
      .filter((c) => normRef(c.refClient).includes(po) || String(c.numero) === po)
      .sort((a, b) => Math.abs(Number(a.dateCommande) - Number(vise)) - Math.abs(Number(b.dateCommande) - Number(vise)))[0]
  }
  if (!trouvee) {
    const tx = totalExtrait(ext)
    par = 'quantite'
    trouvee = parDate
      .filter((c) => c.dateCommande >= dates.dateMin)
      .find((c) => {
        const te = totalEtm(c)
        return tx.size > 0 && [...tx].every(([u, q]) => te.has(u) && proche(q, te.get(u)!, TOLERANCE_RAPPROCHEMENT))
      })
  }
  if (!trouvee) {
    par = 'ouverte'
    trouvee = [...parDate].reverse().find((c) => appelSurCommande(ext, c))
    // A call-off is part of a larger order: its totals are not comparable.
    if (trouvee) return { statut: 'trouvee', commande: trouvee, par, ecarts: [] }
  }
  if (!trouvee) {
    par = 'date'
    trouvee = parDate.find((c) => c.dateCommande >= dates.dateEntree)
  }
  if (!trouvee) return { statut: 'absente' }
  return { statut: 'trouvee', commande: trouvee, par, ecarts: ecarts(ext, trouvee) }
}

export function ecarts(ext: CommandeExtraite, c: CommandeEtm): string[] {
  const out: string[] = []
  const tx = totalExtrait(ext)
  const te = totalEtm(c)
  if (c.societe !== 1) return out
  for (const [u, q] of tx) {
    // A unit the ETM order does not use is a different way of counting (rolls
    // on the PO, Ml in ETM), not a missing quantity.
    const e = te.get(u)
    if (e === undefined) continue
    if (!proche(q, e, TOLERANCE_QUANTITE)) out.push(`quantité ${fmtQ(q)} ${LIBELLE_UNITE[u]} commandée, ${fmtQ(e)} ${LIBELLE_UNITE[u]} saisie`)
  }
  const prixEtm = c.lignes.map((l) => l.prix).filter((p) => p > 0)
  if (prixEtm.length) {
    for (const l of ext.lignes) {
      if (!(l.prix_unitaire && l.prix_unitaire > 0)) continue
      if (!prixEtm.some((p) => proche(p, l.prix_unitaire!, TOLERANCE_PRIX))) {
        const ref = (l.reference_client || l.designation).slice(0, 40)
        out.push(`prix ${fmtQ(l.prix_unitaire, 2)} €${ref ? ` (${ref})` : ''} absent de la commande saisie (${[...new Set(prixEtm.map((p) => fmtQ(p, 2)))].join(' / ')} €)`)
      }
    }
  }
  return [...new Set(out)] // a PO repeating a line repeats its price
}

const fmtQ = (v: number, d = 0) => v.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d }).replace(/\s/g, ' ') // fr-FR groups with U+202F / U+00A0
