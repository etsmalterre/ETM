// « Points à signaler » in the BL email (LIVA #1266, decision Vincent 2026-10-07).
//
// When a shipment carries something unusual, the client must read it in the
// mail that brings the BL, not only on the PDF or later on the invoice. The
// paragraph repeats ONLY what is already client-facing:
//   - the roll observations, when the expedition shows them on the BL
//     (`affiche_observations` — ticking it IS the decision to tell the client;
//     otherwise they stay internal troubleshooting notes);
//   - the free-text BL observation (printed on the BL whenever it is set);
//   - the « Ml non facturés » + motif, which the invoice prints anyway.
// Visitage defects, the dyer's remarks (`observation_sst`) and 2e choix never
// go in: they are kept for us, not for the client.
//
// Pure — the route loads the rows, this builds the lines and the paragraph.

export interface RouleauASignaler {
  numero: string | null
  observations: string | null
  metrage?: number | null
  /** Fini rolls only — écru rolls have no « Ml non facturés ». */
  ml_non_factures?: number | null
  ml_non_factures_motif?: string | null
}

export interface EntreePointsASignaler {
  afficheObservations: boolean
  observationBl: string | null
  rouleaux: RouleauASignaler[]
}

/** Heading of the paragraph — the dialog looks for it to know whether the
 *  user deleted the paragraph before sending. */
export const POINTS_A_SIGNALER_TITRE = 'Points à signaler sur cette livraison'

const fmt = (n: number) => (Math.round(n * 100) / 100).toString().replace('.', ',')
const clean = (s: string | null | undefined) => (s ?? '').toString().replace(/\s+/g, ' ').trim()

/** « 8 Ml non facturés (motif) » for one roll, or null — the same words on
 *  the BL's Observations cell and in the mail. */
export function mentionRouleauNonFacture(r: Pick<RouleauASignaler, 'metrage' | 'ml_non_factures' | 'ml_non_factures_motif'>): string | null {
  const metrage = Number(r.metrage) || 0
  const nf = Math.max(Number(r.ml_non_factures) || 0, 0)
  const nfBorne = metrage > 0 ? Math.min(nf, metrage) : nf
  if (nfBorne <= 0) return null
  const motif = clean(r.ml_non_factures_motif)
  return `${fmt(nfBorne)} Ml non facturés${motif ? ` (${motif})` : ''}`
}

export function pointsASignaler(e: EntreePointsASignaler): string[] {
  const out: string[] = []
  const obsBl = clean(e.observationBl)
  if (obsBl) out.push(obsBl)
  const rouleaux = [...e.rouleaux].sort((a, b) =>
    clean(a.numero).localeCompare(clean(b.numero), 'fr', { numeric: true }))
  for (const r of rouleaux) {
    const parts: string[] = []
    const obs = e.afficheObservations ? clean(r.observations) : ''
    if (obs) parts.push(obs)
    const nf = mentionRouleauNonFacture(r)
    if (nf) parts.push(nf)
    if (parts.length === 0) continue
    const piece = clean(r.numero)
    out.push(`${piece ? `Pièce ${piece} : ` : ''}${parts.join(' — ')}`)
  }
  return out
}

/** The paragraph inserted in the default body, or '' when there is nothing. */
export function paragraphePointsASignaler(points: string[]): string {
  if (points.length === 0) return ''
  return `**${POINTS_A_SIGNALER_TITRE} :**\n` + points.map((p) => `- ${p}`).join('\n') + '\n\n'
}
