// What a client line still needs at each stage of its matter (decision Vincent 2026-10-28).
//
// The line drawer shows, per stage, the matter reserved to the line (top) and the orders that move it
// on (bottom): Affectation = fini rolls, Ennoblissement = écru pieces, Fil = yarn. Each stage only
// asks for what the stages after it do not already cover, or the same matter is asked twice: a line
// of 1 000 Ml with 400 Ml of fini rolls needs 600 Ml of écru, and once 600 Ml of écru is reserved
// (or still to knit) it needs no yarn at all. One computation, read by every tab and by the yarn
// need (besoinsFilDeLigne: écru still to make = `ecru.reste`).
//
// Everything is in the line's unit (Ml through the fini's rendement, else kg), as the gauge counts
// it (lineReservationAggregates): fini = fini rolls reserved to the line (shipped included), ecru =
// écru pieces reserved to the line not dyed yet (at a dyer or not), tricotage = what is still to knit
// for the line on knitting orders (lib/tricotage-restant.ts) — écru on its way.

export interface Stade {
  /** what this stage must bring: the line's quantity less what the stages after it hold */
  besoin: number
  /** what the line holds at this stage */
  couvert: number
  /** still to cover here, never negative */
  reste: number
}

export interface StadesLigne {
  /** fini lines only: the rolls themselves */
  fini: Stade | null
  /** écru pieces + écru still to knit */
  ecru: Stade & { pieces: number; tricotage: number }
  /** écru still to make from yarn (= ecru.reste): the base of the yarn need */
  aTricoter: number
}

const r2 = (x: number) => Math.round(x * 100) / 100
/** A rest under 0,5 % of the line is rounding, not matter to find (Vincent 2026-10-29: 142 Ml launched as
 *  40,0 kg left 0,02 kg of écru, which became « 1 kg of yarn to reserve »). */
export const RESTE_NEGLIGEABLE = 0.005
const pos = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0)

export function besoinsParStade(p: { kind: 'fini' | 'ecru'; quantite: number; fini: number; ecru: number; tricotage: number }): StadesLigne {
  const q = pos(p.quantite)
  const fini = p.kind === 'fini' ? pos(p.fini) : 0
  const pieces = pos(p.ecru)
  const tricotage = pos(p.tricotage)
  const seuil = q * RESTE_NEGLIGEABLE
  const net = (x: number) => (x > seuil ? r2(x) : 0)
  const stadeFini: Stade | null = p.kind === 'fini'
    ? { besoin: r2(q), couvert: r2(fini), reste: net(Math.max(0, q - fini)) }
    : null
  const besoinEcru = stadeFini ? stadeFini.reste : q
  const couvertEcru = pieces + tricotage
  const resteEcru = net(Math.max(0, besoinEcru - couvertEcru))
  return {
    fini: stadeFini,
    ecru: { besoin: r2(besoinEcru), couvert: r2(couvertEcru), reste: resteEcru, pieces: r2(pieces), tricotage: r2(tricotage) },
    aTricoter: resteEcru,
  }
}
