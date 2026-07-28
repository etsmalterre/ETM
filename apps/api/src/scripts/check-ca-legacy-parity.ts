// Parity check for the "Chiffre d'affaires" widget (/api/rapports/ca-*).
//
// The legacy WinDev "Comparatif CA" screen computes revenue as
//
//   CA = Σ round2(ligne_facture.quantite × ligne_facture.prix)
//
// over `facture` rows with IDsociete = 1, with TYPE = 2 (avoir) NEGATED. The
// per-line rounding matters: summing the raw floats drifts a few centimes a
// year and stops matching the legacy totals.
//
// The expectations below were read off the legacy screen (2026-07-28) against
// the local dev copy of the database. Run after touching caForYear():
//   npx tsx src/scripts/check-ca-legacy-parity.ts
import { query } from '../lib/hfsql-auto.js'

/** Figures read off the legacy Comparatif CA / Rapport CA-Client windows.
 *
 *  Known legacy discrepancy: its March 2026 cell reads 220 144,84, which makes
 *  its own three monthly columns sum to 663 818,59 — a centime short of the
 *  663 818,60 its TOTAL row displays. The exact integer-centime sum is
 *  220 144,85, so we keep that: our months add up to our total, and every
 *  per-client figure still matches the legacy ranking to the centime. */
const EXPECTED = {
  2026: { total: 663818.6, months: { 1: 241360.94, 2: 202312.81, 3: 220144.85 } },
  2025: { total: 2684442.74, months: {} as Record<number, number> },
}
/** Per-client 2026 CA, as displayed by the legacy ranking. */
const EXPECTED_CLIENTS_2026: Record<number, number> = {
  237: 208781.53, // Le teeshirt propre
  111: 194880.35, // Le slip Francais
  1011: 38250.54, // Atelier Joly /Missègle
  22: 25975.32, // SIMONE PERELE
  252: 21781.6, // SAS LA FABRIQUE
}

const euro = (v: number) => Math.round(v * 100) / 100

async function caForYear(year: number) {
  const rows = await query<any>(
    `SELECT f.IDclient AS idc, f.TYPE AS t, f.DATE AS d, lf.quantite AS q, lf.prix AS p
       FROM facture f
       JOIN ligne_facture lf ON lf.IDfacture = f.IDfacture
      WHERE f.IDsociete = 1 AND f.DATE >= '${year}0101' AND f.DATE <= '${year}1231'`,
  )
  // Accumulate in integer centimes — see caForYear() in routes/rapports.ts.
  const byClient = new Map<number, number>()
  const byMonth = new Map<number, number>()
  for (const r of rows) {
    const month = Number(String(r.d ?? '').slice(4, 6))
    let cents = Math.round(Number(r.q ?? 0) * Number(r.p ?? 0) * 100)
    if (Number(r.t) === 2) cents = -cents
    byClient.set(Number(r.idc), (byClient.get(Number(r.idc)) ?? 0) + cents)
    byMonth.set(month, (byMonth.get(month) ?? 0) + cents)
  }
  const total = [...byClient.values()].reduce((a, b) => a + b, 0) / 100
  return {
    byClient: new Map([...byClient].map(([k, v]) => [k, v / 100])),
    byMonth: new Map([...byMonth].map(([k, v]) => [k, v / 100])),
    total,
  }
}

let failures = 0
function expect(label: string, actual: number, wanted: number) {
  const ok = Math.abs(actual - wanted) < 0.005
  if (!ok) failures++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}: ${actual.toFixed(2)} (attendu ${wanted.toFixed(2)})`)
}

async function main() {
  for (const [yearStr, exp] of Object.entries(EXPECTED)) {
    const year = Number(yearStr)
    const { byClient, byMonth, total } = await caForYear(year)
    expect(`CA ${year} total`, total, exp.total)
    for (const [m, wanted] of Object.entries(exp.months)) {
      expect(`CA ${year} mois ${m}`, euro(byMonth.get(Number(m)) ?? 0), wanted)
    }
    if (year === 2026) {
      for (const [idc, wanted] of Object.entries(EXPECTED_CLIENTS_2026)) {
        expect(`CA 2026 client ${idc}`, euro(byClient.get(Number(idc)) ?? 0), wanted)
      }
    }
  }
  console.log(failures === 0 ? '\nParité legacy OK.' : `\n${failures} écart(s) avec le legacy.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
