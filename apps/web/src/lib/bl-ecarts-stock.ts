// What the réception kept against what Tricobot read on a dyer's BL (run
// dialog of Agents IA › BL Ennoblisseur, 2026-10-29). A BL blocked « à
// vérifier » writes no pre-fill: the rolls are typed by hand and no Tricobot
// retour links them to the run, so the dialog compares with the rolls of the
// lot as they stand in stock (GET /:slug/runs/:id → `enStock`).

import { fmtNum } from './format'

export interface RouleauEnStock {
  numero: string
  poids: number | null
  metrage: number | null
  observation_sst: string
}

export interface PieceLue {
  numero_piece: string
  composants?: string[]
  poids: number | null
  metrage: number | null
  observations: string
}

/** Same shape as the réception's corrections in the pieces table: the value now in stock. */
export type EcartPiece = Partial<Record<'poids' | 'metrage' | 'observation', string>>

const texte = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
const differe = (lu: number | null, stock: number | null) =>
  lu != null && stock != null && Math.abs(lu - stock) > 0.05

/** Per BL piece, the fields whose stock value differs from what was read, and
 *  how many pieces are in stock at all. A roll cut after the réception is read
 *  whole again (remainder keeps the numero, cuts are `<numero>-N`), unless the
 *  BL itself lists that `-N` piece (a dyer's split). */
export function ecartsAuStock(pieces: PieceLue[], enStock: RouleauEnStock[]): { ecarts: Map<string, EcartPiece>; nbEcarts: number; recues: number } {
  const surLeBl = new Set(pieces.map((p) => p.numero_piece))
  const parNumero = new Map(enStock.map((r) => [r.numero, r]))
  const ecarts = new Map<string, EcartPiece>()
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
    const e: EcartPiece = {}
    if (differe(p.poids, poids)) e.poids = fmtNum(poids, 2)
    if (differe(p.metrage, metrage)) e.metrage = fmtNum(metrage, 2)
    if (texte(p.observations ?? '') !== texte(r.observation_sst)) e.observation = r.observation_sst || '(vide)'
    const n = Object.keys(e).length
    if (n > 0) { ecarts.set(p.numero_piece, e); nbEcarts += n }
  }
  return { ecarts, nbEcarts, recues }
}
