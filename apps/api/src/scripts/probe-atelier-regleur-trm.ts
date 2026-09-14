// Read-only probe for the régleur half of the Atelier PWA (routes/atelier.ts,
// `GET /machines?regleur=1`, lib/atelier-regleur-trm.ts).
//
// Prints, for every active OF, what the phone tile carries — the TRS tablet's
// mean of unexplained stops per piece over the last finished pieces
// (lib/arrets-par-piece-trm.ts), the second-choice ratio and the alert — and,
// beside it, the number the LEGACY Android app shows on its bell, reproduced
// with its bug (24 h of stops divided by the minutes from the window start to
// today's midnight — see the header of lib/atelier-regleur-trm.ts). Run it on
// prod next to a phone still on the Android app: the last column must match
// the bell, the `/pièce` column the wall tablet.
//
//   node --env-file=.env --import tsx src/scripts/probe-atelier-regleur-trm.ts
//
// The dev base is a March snapshot: its evenement_machine is nearly empty, so
// every stop figure is 0 there — the shapes of the reads are all it checks.

import { query } from '../lib/hfsql-auto.js'
import { parseDtMs } from '../lib/production-trm.js'
import { pourcentageDefauts, alerteRegleur } from '../lib/atelier-regleur-trm.js'
import { arretsParPieceDesOfs } from '../lib/arrets-par-piece-trm.js'

const n = (v: unknown): number => Number(v) || 0
const H = 3600_000
const dtLit = (ms: number): string => {
  const t = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
}

/** The legacy FrequenceArret, bug included: counts since max(now − 24 h,
 *  demarrage_prod), divided by the minutes from that instant to today's
 *  00:00 (`DateHeureDifférence(dhDateRef, DateSys)`), rounded, clamped at 0. */
function legacyBell(now: number, demarrageMs: number | null, arrets: number[], attendus: number[]): number {
  let debut = now - 24 * H
  if (demarrageMs !== null && demarrageMs > debut) debut = demarrageMs
  const minuit = new Date(now)
  minuit.setHours(0, 0, 0, 0)
  const minutes = Math.floor((minuit.getTime() - debut) / 60_000)
  if (minutes === 0) return 0
  const net = arrets.filter((t) => t >= debut).length - attendus.filter((t) => t >= debut).length
  const freq = Math.round((net * 60) / minutes)
  return freq <= 0 ? 0 : freq
}

async function main() {
  const now = Date.now()
  const lit = dtLit(now - 24 * H)
  console.log(`now = ${new Date(now).toLocaleString('fr-FR')} — legacy window DATE >= '${lit}'`)

  const ofs = await query<Record<string, unknown>>(
    `SELECT IDordre_fabrication, IDmachine, IDref_ecru, IDcolori_ecru, demarrage_prod
     FROM ordre_fabrication WHERE est_actif = 1`,
  )
  const ofIds = ofs.map((o) => n(o.IDordre_fabrication)).filter((x) => x > 0)
  const pieces = ofIds.length
    ? await query<Record<string, unknown>>(
        `SELECT IDpiece_production, IDordre_fabrication FROM piece_production WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
      )
    : []
  const ofParPiece = new Map(pieces.map((p) => [n(p.IDpiece_production), n(p.IDordre_fabrication)]))

  const [arretRows, evtRows, parPiece] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT IDmachine, DATE AS date_ev FROM evenement_machine WHERE etat = 0 AND DATE >= '${lit}'`,
    ),
    query<Record<string, unknown>>(
      `SELECT IDpiece_production, DATE AS date_ev FROM evenement_piece
       WHERE DATE >= '${lit}' AND evenement IN ('Nettoyage', 'Fin du tricotage')`,
    ),
    arretsParPieceDesOfs(ofs.map((o) => ({ ofId: n(o.IDordre_fabrication), machineId: n(o.IDmachine) }))),
  ])
  console.log(`evenement_machine etat=0 in 24 h: ${arretRows.length} rows; expected-stop events: ${evtRows.length} rows`)

  const arretsParMachine = new Map<number, number[]>()
  for (const r of arretRows) {
    const t = parseDtMs(r.date_ev)
    if (t === null) continue
    const k = n(r.IDmachine)
    arretsParMachine.set(k, [...(arretsParMachine.get(k) ?? []), t])
  }
  const evtsParOf = new Map<number, number[]>()
  for (const r of evtRows) {
    const ofId = ofParPiece.get(n(r.IDpiece_production))
    const t = parseDtMs(r.date_ev)
    if (ofId === undefined || t === null) continue
    evtsParOf.set(ofId, [...(evtsParOf.get(ofId) ?? []), t])
  }

  console.log('\nmétier  OF     pièces  /pièce  pct2nd  alerte   cloche legacy (bug minuit)')
  for (const o of ofs) {
    const ofId = n(o.IDordre_fabrication)
    const arrets = parPiece.get(ofId) ?? { moyenne: null, pieces: 0 }
    const rows = await query<Record<string, unknown>>(
      `SELECT TOP 100 poids, second_choix FROM stock_ecru
       WHERE IDref_ecru = ${n(o.IDref_ecru)} AND IDcolori_ecru = ${n(o.IDcolori_ecru)} ORDER BY date_saisie DESC`,
    )
    const pct = pourcentageDefauts(rows.map((r) => ({ poids: Number(r.poids) || 0, second_choix: n(r.second_choix) === 1 })))
    const a = alerteRegleur(pct, arrets)
    const cloche = legacyBell(now, parseDtMs(o.demarrage_prod), arretsParMachine.get(n(o.IDmachine)) ?? [], evtsParOf.get(ofId) ?? [])
    const moyenne = arrets.moyenne === null ? '—' : arrets.moyenne.toFixed(1)
    console.log(
      `${String(n(o.IDmachine)).padEnd(7)} ${String(ofId).padEnd(6)} ${String(arrets.pieces).padStart(6)}  ${moyenne.padStart(6)}  ${(pct * 100).toFixed(1).padStart(5)} %  ${(a.alerte ? 'OUI' : '-').padEnd(6)}   ${cloche}`,
    )
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
