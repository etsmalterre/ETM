/**
 * Read-only probe for the TRM finance & CA mount (lib/finance-common.ts with
 * FINANCE_SCOPE_TRM, served at /api/rapports-trm).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/probe-finance-trm.ts
 *
 * Re-run it against prod after an /etm_deploy to sanity-check the assumptions
 * the TRM tableau de bord widgets (Charges, Chiffre d'affaires, Analyse
 * financière, Évolution du CA) rest on:
 *
 *   1. société 2 actually has compta uploads — without them Charges and
 *      Analyse financière have no data source at all.
 *   2. The compte-level sums reproduce upload_compta's frais_fixe /
 *      frais_variable buckets. This is what lets the Charges widget sum
 *      `lignes` (the compte-by-compte read a Rapports › Finance screen would
 *      show) instead of reading the pre-computed totals. Exact on the 2025 and
 *      2026 anchors; the 2024 anchor drifts because `compte_compta`
 *      .frais_variable is the CURRENT classification, not the one in force
 *      that year — the legacy screen behaves the same way (ETM drifts too).
 *   3. dropExerciseClose still fires on TRM's January rows: the first upload of
 *      a year can be the accountant's close of the PREVIOUS exercise
 *      (2026-01-05 carries 341 078 € against the next upload's 25 044 €).
 *   4. The `facture` × `ligne_facture` CA agrees with upload_compta.produits —
 *      two independent sources for the same number, which is the strongest
 *      check available that the CA formula is right for société 2.
 *
 * HFSQL discipline: `DATE` and `TYPE` are reserved words and come back
 * uppercased unless aliased; flat set-based reads only.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'

const SOCIETE_TRM = 2
const CLASS_7 = 700000
/** facture.TYPE for an avoir (credit note) — subtracted from revenue. */
const FACTURE_TYPE_AVOIR = 2

const n = (v: unknown): number => (v == null ? 0 : Number(v) || 0)
const eur = (v: number): string =>
  v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
const ok = (pass: boolean): string => (pass ? 'OK  ' : 'FAIL')

interface UploadRow {
  d: string
  produits: number
  charges: number
  frais_fixe: number
  frais_variable: number
}

async function main(): Promise<void> {
  let failures = 0

  // ── 1. uploads ───────────────────────────────────────────────────────────
  const rawUploads = await query<Record<string, unknown>>(
    `SELECT DATE AS d, produits, charges, frais_fixe, frais_variable
       FROM upload_compta WHERE id_societe = ${SOCIETE_TRM}`,
  )
  const uploads: UploadRow[] = rawUploads
    .map((r) => ({
      d: String(r.d ?? ''),
      produits: n(r.produits),
      charges: n(r.charges),
      frais_fixe: n(r.frais_fixe),
      frais_variable: n(r.frais_variable),
    }))
    .filter((r) => /^\d{8}$/.test(r.d))
    .sort((a, b) => a.d.localeCompare(b.d))

  console.log('=== 1. upload_compta, société 2 ===')
  if (uploads.length === 0) {
    console.log('  FAIL  no upload at all — Charges and Analyse financière have no data')
    failures++
  } else {
    console.log(`  OK    ${uploads.length} uploads, ${uploads[0].d} → ${uploads[uploads.length - 1].d}`)
  }

  // Last upload of each calendar year = that year's anchor.
  const anchors = new Map<string, UploadRow>()
  for (const u of uploads) anchors.set(u.d.slice(0, 4), u)

  // ── 2. compte-level sums vs the pre-computed buckets ─────────────────────
  const comptes = await query<Record<string, unknown>>(
    `SELECT IDcompte_compta, numero, frais_variable
       FROM compte_compta WHERE id_societe = ${SOCIETE_TRM}`,
  )
  const charges = new Map<number, number>()
  for (const c of comptes) {
    const numero = n(c.numero)
    if (numero <= 0 || numero >= CLASS_7) continue
    charges.set(n(c.IDcompte_compta), n(c.frais_variable) === 1 ? 1 : 0)
  }
  console.log(`\n=== 2. compte_compta: ${comptes.length} comptes, ${charges.size} de classe 6 ===`)

  for (const [year, a] of [...anchors.entries()].sort()) {
    const releve = await query<Record<string, unknown>>(
      `SELECT IDcompte_compta, debit, credit FROM releve_compta WHERE DATE = '${a.d}'`,
    )
    let fixe = 0
    let variable = 0
    for (const r of releve) {
      const bucket = charges.get(n(r.IDcompte_compta))
      if (bucket === undefined) continue
      const montant = n(r.debit) - n(r.credit)
      if (bucket === 1) variable += montant
      else fixe += montant
    }
    // Centime tolerance: the buckets are stored as reals.
    const near = (x: number, y: number): boolean => Math.abs(x - y) < 0.01
    const pass = near(fixe, a.frais_fixe) && near(variable, a.frais_variable)
    // 2024 and earlier are expected to drift — see the header.
    const expected = Number(year) >= 2025
    if (expected && !pass) failures++
    console.log(
      `  ${expected ? ok(pass) : pass ? 'OK  ' : 'drift'}  ${year} @ ${a.d}` +
        `  fixe ${eur(fixe)} vs ${eur(a.frais_fixe)}` +
        `  · variable ${eur(variable)} vs ${eur(a.frais_variable)}`,
    )
  }

  // ── 3. exercise-close row ────────────────────────────────────────────────
  console.log('\n=== 3. dropExerciseClose (first upload of each year) ===')
  for (const year of [...anchors.keys()].sort()) {
    const ofYear = uploads.filter((u) => u.d.startsWith(year))
    const [first, second] = ofYear
    if (!first || !second) continue
    const dropped = first.d.slice(4, 8) <= '0115' && first.produits > second.produits * 2
    console.log(
      `  ${year}: ${first.d} produits ${eur(first.produits)} → ${second.d} ${eur(second.produits)}` +
        `  ${dropped ? '[dropped as exercise close]' : '[kept]'}`,
    )
  }

  // ── 4. facture CA vs upload_compta.produits ──────────────────────────────
  console.log('\n=== 4. CA (facture × ligne_facture) vs upload_compta.produits ===')
  const lines = await query<Record<string, unknown>>(
    `SELECT f.DATE AS d, f.TYPE AS t, lf.quantite AS q, lf.prix AS p
       FROM facture f
       JOIN ligne_facture lf ON lf.IDfacture = f.IDfacture
      WHERE f.IDsociete = ${SOCIETE_TRM}`,
  )
  // Integer centimes, rounded per line — the same accumulation the API uses.
  const cents = new Map<string, number>()
  for (const r of lines) {
    const year = String(r.d ?? '').slice(0, 4)
    if (!/^\d{4}$/.test(year)) continue
    let amount = Math.round(n(r.q) * n(r.p) * 100)
    if (Number(r.t) === FACTURE_TYPE_AVOIR) amount = -amount
    cents.set(year, (cents.get(year) ?? 0) + amount)
  }
  for (const [year, c] of [...cents.entries()].sort()) {
    const ca = c / 100
    const a = anchors.get(year)
    if (!a) { console.log(`  ${year}: CA ${eur(ca)}  (aucun relevé comptable)`); continue }
    // The two sources are stopped at different dates (the last invoice vs the
    // last upload), so a few hundred € apart is normal; a 5 % gap is not.
    const gap = a.produits === 0 ? 0 : Math.abs(ca - a.produits) / a.produits
    const pass = gap < 0.05
    if (!pass) failures++
    console.log(
      `  ${ok(pass)}  ${year}: CA ${eur(ca)} vs produits ${eur(a.produits)} au ${a.d}` +
        `  (écart ${(gap * 100).toFixed(1)} %)`,
    )
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  await closeConnection()
  if (failures > 0) process.exit(1)
}

main().catch(async (err) => {
  console.error(err)
  await closeConnection()
  process.exit(1)
})
