// BL Ennoblisseur in « observation » (the BL skill in essai, Vincent 2026-11-05):
// Tricobot reads the BL and pre-fills nothing; once a person has received the
// lot by hand, what was read is compared with the rolls in stock, and the run
// is judged as a saisie (validée / corrigée) or, when the BL was blocked, as an
// aide whose doubt is estimated (useful when the reading was wrong). Nobody
// sees any of it in ETM; Agents IA reads it in the BL's measures.
//
// The comparison is the one the run dialog shows (web lib/bl-ecarts-stock.ts):
// a roll cut after the réception is read whole again.

import { lireRuns, modifierRun, type AgentRun } from './store.js'
import { rouleauxEnStock, type RouleauEnStock } from './bl-ennoblisseur-db.js'

/** A BL read in observation is compared within this many days, once its rolls are all in stock. */
export const OBSERVATION_BL_JOURS = 30

interface PieceLue { numero_piece: string; composants?: string[]; poids: number | null; metrage: number | null; observations: string }

const texte = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
const differe = (lu: number | null, stock: number | null) => lu != null && stock != null && Math.abs(lu - stock) > 0.05

/** How many fields differ between the BL read and the stock, and how many pieces are in stock. Pure. */
export function ecartsAuStock(pieces: readonly PieceLue[], enStock: readonly RouleauEnStock[]): { nbEcarts: number; recues: number } {
  const surLeBl = new Set(pieces.map((p) => p.numero_piece))
  const parNumero = new Map(enStock.map((r) => [r.numero, r]))
  let nbEcarts = 0
  let recues = 0
  for (const p of pieces) {
    const numero = parNumero.has(p.numero_piece) ? p.numero_piece : (p.composants ?? []).find((c) => parNumero.has(c))
    const r = numero ? parNumero.get(numero) : undefined
    if (!r || !numero) continue
    recues++
    let poids = r.poids
    let metrage = r.metrage
    for (const c of enStock) {
      const m = /^(.+)-\d+$/.exec(c.numero)
      if (!m || m[1] !== numero || surLeBl.has(c.numero)) continue
      if (c.poids != null) poids = (poids ?? 0) + c.poids
      if (c.metrage != null) metrage = (metrage ?? 0) + c.metrage
    }
    if (differe(p.poids, poids)) nbEcarts++
    if (differe(p.metrage, metrage)) nbEcarts++
    if (texte(p.observations ?? '') !== texte(r.observation_sst)) nbEcarts++
  }
  return { nbEcarts, recues }
}

/** A BL run read in observation, still to compare. */
export const aComparer = (r: AgentRun, maintenant = Date.now()) =>
  (r.competence ?? 'bl') === 'bl' && r.mode === 'essai' && r.source !== 'essai_manuel'
  && (r.statut === 'simule' || r.statut === 'a_verifier') && !r.observation
  && maintenant - Date.parse(r.createdAt) < OBSERVATION_BL_JOURS * 86_400_000

let dernier = 0
let enCours = false

/** Compare the BL runs read in observation whose lot is now received. At most
 *  once every 10 minutes (called when Agents IA shows the agent), never throws. */
export async function comparerObservationsBl(slug: string): Promise<number> {
  if (enCours || Date.now() - dernier < 10 * 60_000) return 0
  enCours = true
  dernier = Date.now()
  let n = 0
  try {
    for (const r of (await lireRuns(slug)).filter((x) => aComparer(x))) {
      const res = r.resultat as { extraction?: { pieces?: PieceLue[] } | null; resolution?: { ligneId?: number | null; lot?: string } | null }
      const pieces = res.extraction?.pieces ?? []
      const ligne = res.resolution?.ligneId
      const lot = res.resolution?.lot
      if (!pieces.length || !ligne || !lot) continue
      const { nbEcarts, recues } = ecartsAuStock(pieces, await rouleauxEnStock(ligne, lot))
      // Not received yet (or partly): compared at a later visit.
      if (recues < pieces.length) continue
      const bloque = r.statut === 'a_verifier'
      await modifierRun(slug, r.id, (x) => {
        x.observation = {
          statut: bloque ? 'resolue' : nbEcarts ? 'corrigee' : 'validee',
          ecarts: nbEcarts,
          // Estimated: blocking was useful when the reading was wrong.
          douteJustifie: bloque ? nbEcarts > 0 : null,
          le: new Date().toISOString(),
        }
      })
      n++
    }
  } catch (e) {
    console.error('[agents] BL observation comparison failed:', e)
  } finally {
    enCours = false
  }
  return n
}
