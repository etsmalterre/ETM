// Malterre's coloris control of a dyed lot (LIVA #1332, decision Vincent 2026-11-02).
//
// At the controls, Laetitia cuts a round of the tirelle, compares it with the
// « rond 0 » of the same reference + coloris kept in a binder, then files the
// lot's round beside it. ETM keeps the verdict: « conforme » or « écart »
// (suivilot.coloris_tirelle, migration 0052) — the why goes in the lot's
// observations, like every other out-of-tolerance measure: the lot then passes
// with a word to the dyer, or goes back in reprise.
//
//   • Asked on a DYED fini only (ref_fini.avec_teinture 1 / 2, whites included —
//     they are dyed white); never on a wash-only fini.
//   • Rond 0 = the FIRST lot of that reference + coloris (suivilot by date, then
//     id). That lot has nothing to compare with: its round becomes the
//     reference, so the control is not asked of it.
//   • Part of the Contrôle Malterre (lib/controles-lot.ts): while asked and not
//     given, « Valider le lot » waits — a reference switched « sans contrôle
//     Malterre » never asks it.

import { mpsPg } from './mps-pg.js'

export type VerdictColoris = 'conforme' | 'ecart'

export function lireVerdictColoris(v: unknown): VerdictColoris | null {
  return v === 'conforme' || v === 'ecart' ? v : null
}

/** The coloris is compared on a dyed fini only. */
export function colorisDemande(avecTeinture: number): boolean {
  return Number(avecTeinture) > 0
}

export interface RondZero {
  idsuivilot: number
  lot: string
  date: string | null
}

const cle = (ref: number, coloris: number) => `${ref}:${coloris}`

/** The first lot of each (ref fini, ref_fini_colori) pair. */
export async function rondsZero(paires: Array<{ ref: number; coloris: number }>): Promise<Map<string, RondZero>> {
  const out = new Map<string, RondZero>()
  const ok = paires.filter((p) => p.ref > 0 && p.coloris > 0)
  if (ok.length === 0) return out
  const refs = [...new Set(ok.map((p) => p.ref))]
  const colis = [...new Set(ok.map((p) => p.coloris))]
  const rows = await mpsPg()<{ ref: string; coloris: string; idsuivilot: string; lot: string | null; date: string | null }[]>`
    SELECT DISTINCT ON (idref_fini, idref_fini_colori)
           idref_fini AS ref, idref_fini_colori AS coloris, idsuivilot, trim(lot::text) AS lot,
           to_char(date, 'YYYY-MM-DD') AS date
    FROM suivilot
    WHERE idref_fini = ANY(${refs}) AND idref_fini_colori = ANY(${colis})
    ORDER BY idref_fini, idref_fini_colori, date NULLS LAST, idsuivilot`
  for (const r of rows) out.set(cle(Number(r.ref), Number(r.coloris)), { idsuivilot: Number(r.idsuivilot), lot: r.lot ?? '', date: r.date })
  return out
}

export function rondZeroDe(m: Map<string, RondZero>, ref: number, coloris: number): RondZero | null {
  return m.get(cle(ref, coloris)) ?? null
}

/** Whether this lot owes the coloris control: dyed fini, and not its rond 0. */
export function colorisAControler(avecTeinture: number, idsuivilot: number, rond0: RondZero | null): boolean {
  if (!colorisDemande(avecTeinture)) return false
  return rond0?.idsuivilot !== idsuivilot
}

export interface LotColoris {
  idsuivilot: number
  lot: string
  date: string | null
  verdict: VerdictColoris | null
}

/** The last lots of a reference + coloris, newest first, with their verdict —
 *  the binder, as ETM sees it. */
export async function historiqueColoris(ref: number, coloris: number, limite = 8): Promise<LotColoris[]> {
  if (!(ref > 0 && coloris > 0)) return []
  const rows = await mpsPg()<{ idsuivilot: string; lot: string | null; date: string | null; verdict: string | null }[]>`
    SELECT idsuivilot, trim(lot::text) AS lot, to_char(date, 'YYYY-MM-DD') AS date, coloris_tirelle AS verdict
    FROM suivilot WHERE idref_fini = ${ref} AND idref_fini_colori = ${coloris}
    ORDER BY date DESC NULLS LAST, idsuivilot DESC
    LIMIT ${limite}`
  return rows.map((r) => ({ idsuivilot: Number(r.idsuivilot), lot: r.lot ?? '', date: r.date, verdict: lireVerdictColoris(r.verdict) }))
}
