// Read-only probe for the régleur half of the Atelier PWA (routes/atelier.ts,
// `GET /machines?regleur=1`, lib/atelier-regleur-trm.ts).
//
// The dev base is a March snapshot, so on it every stop frequency is 0: the
// two 24 h windows are empty. This probe replays the SAME two SQL shapes the
// route issues, from a date you choose, so the driver's answer to them can be
// checked without waiting for prod — and, on prod, so the numbers can be
// compared with what the Android régleur app shows on its tiles.
//
//   pnpm exec tsx src/scripts/probe-atelier-regleur-trm.ts [--depuis 2026-03-20]
//
// Prints, for every active OF: the métier, the OF, the window start actually
// used (max(depuis, demarrage_prod)), the raw stop count, the expected-stop
// count, the resulting frequency, the second-choice ratio and the alert flag.

import { query } from '../lib/hfsql-auto.js'
import { parseDtMs } from '../lib/production-trm.js'
import {
  debutFenetreArrets,
  frequenceArret,
  pourcentageDefauts,
  alerteRegleur,
  FENETRE_FREQ_ARRET_MS,
} from '../lib/atelier-regleur-trm.js'

const n = (v: unknown): number => Number(v) || 0
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const dtLit = (ms: number): string => {
  const t = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
}

async function main() {
  const depuisArg = arg('--depuis')
  // "now" is the end of the window: the given day + 24 h, or the real now.
  const now = depuisArg ? Date.parse(`${depuisArg}T00:00:00`) + FENETRE_FREQ_ARRET_MS : Date.now()
  const lit = dtLit(now - FENETRE_FREQ_ARRET_MS)
  console.log(`window: DATE >= '${lit}'  (now = ${new Date(now).toLocaleString('fr-FR')})`)

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

  const arretRows = await query<Record<string, unknown>>(
    `SELECT IDmachine, DATE AS date_ev FROM evenement_machine WHERE etat = 0 AND DATE >= '${lit}'`,
  )
  const evtRows = await query<Record<string, unknown>>(
    `SELECT IDpiece_production, DATE AS date_ev FROM evenement_piece
     WHERE DATE >= '${lit}' AND evenement IN ('Nettoyage', 'Fin du tricotage')`,
  )
  console.log(`evenement_machine etat=0 in window: ${arretRows.length} rows; expected-stop events: ${evtRows.length} rows`)

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

  console.log('\nmétier  OF     depuis               arrêts attendus freq  pct2nd  alerte')
  for (const o of ofs) {
    const ofId = n(o.IDordre_fabrication)
    const debut = debutFenetreArrets(parseDtMs(o.demarrage_prod), now)
    const arrets = (arretsParMachine.get(n(o.IDmachine)) ?? []).filter((t) => debut !== null && t >= debut).length
    const attendus = (evtsParOf.get(ofId) ?? []).filter((t) => debut !== null && t >= debut).length
    const freq = frequenceArret(debut, now, arretsParMachine.get(n(o.IDmachine)) ?? [], evtsParOf.get(ofId) ?? [])
    const rows = await query<Record<string, unknown>>(
      `SELECT TOP 100 poids, second_choix FROM stock_ecru
       WHERE IDref_ecru = ${n(o.IDref_ecru)} AND IDcolori_ecru = ${n(o.IDcolori_ecru)} ORDER BY date_saisie DESC`,
    )
    const pct = pourcentageDefauts(rows.map((r) => ({ poids: Number(r.poids) || 0, second_choix: n(r.second_choix) === 1 })))
    const a = alerteRegleur(pct, freq)
    console.log(
      `${String(n(o.IDmachine)).padEnd(7)} ${String(ofId).padEnd(6)} ${(debut === null ? '(pas démarré)' : new Date(debut).toLocaleString('fr-FR')).padEnd(20)} ${String(arrets).padStart(6)} ${String(attendus).padStart(8)} ${String(freq).padStart(4)}  ${(pct * 100).toFixed(1).padStart(5)} %  ${a.alerte ? 'OUI' : '-'}`,
    )
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
