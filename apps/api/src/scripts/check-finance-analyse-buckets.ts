/**
 * Guard: the Analyse financière widget and the Rapports › Finance screen must
 * quote the SAME charges fixes / charges variables, and both must stay inside
 * the EXPLOITATION perimeter that EBE is defined on.
 *
 *   API_BASE=http://localhost:8080/api pnpm --filter @mps/api exec tsx \
 *     src/scripts/check-finance-analyse-buckets.ts
 *
 * WHY THIS EXISTS (bug reported 2026-08-25)
 *
 * The widget used to plot `upload_compta.frais_fixe` / `.frais_variable`, two
 * columns the accountant's WinDev upload routine FREEZES at write time — they
 * encode the classification in force that week. The report screen instead sums
 * `releve_compta` bucketed by `compte_compta.frais_variable`, the CURRENT
 * classification. So moving a compte from fixe to variable restated the report
 * instantly and never reached the chart. `/finance/analyse` now recomputes the
 * split the report's way, and this script pins the two together.
 *
 * WHAT IS ASSERTED
 *
 *   For every société and every year both endpoints offer, the report's `lignes`
 *   summed by `variable` must equal, to the centime, the charges of the analyse
 *   series' LAST point of that year. Both are taken at the same anchor (the last
 *   upload of the calendar year), so exact equality is the correct expectation.
 *
 *   Since 2026-08-26 it also pins the PERIMETER (see `isChargeExploitation` /
 *   `isProduitExploitation` in lib/finance-common.ts): no report line outside
 *   PCG classes 60-64, and the analyse's CA exactly equal to classes 70-74 of
 *   the balance. Splitting the plan on "class 6 = charge / class 7 = produit"
 *   dragged the financial and exceptional accounts into an aggregate that is
 *   defined as stopping before them, inflating ETM's 2025 EBE by 6 100 € and
 *   its 2024 EBE by 40 040 €. Cross-checked against the accountant's own
 *   compte de résultat on the closed 2024 exercice: 269 613 € computed vs
 *   269 982 € filed.
 *
 * The stored `upload_compta` buckets are then compared as DIAGNOSTIC output, not
 * as an assertion: they are legitimately stale wherever a compte was reclassified
 * since (30 of TRM's 58 uploads on the dev copy), and that staleness is precisely
 * the thing this change stopped honouring.
 */
import crypto from 'node:crypto'
import dotenv from 'dotenv'

// Only `index.ts` loads dotenv, so a script run on its own gets whatever
// `hfsql.ts` falls back to — `localhost:4900`, which is right on a dev box and
// wrong everywhere else. Load it here, same order as the server, BEFORE the
// HFSQL module is imported (its connection string is read at first use, but the
// env has to be populated by then). Verified on the API server 2026-08-25.
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

const { query, closeConnection } = await import('../lib/hfsql-auto.js')

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const eur = (v: number) => v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** Centime tolerance — the amounts travel as REAL columns. */
const EPS = 0.005

let failures = 0
const fail = (msg: string) => { console.log(`  ✗ ${msg}`); failures++ }

async function api(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, { headers: { Cookie: COOKIE } })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

/** Somme des produits d'EXPLOITATION (PCG 70 à 74) d'une société à une date
 *  d'arrêté, lue directement en base — la référence indépendante du CA que
 *  l'analyse doit servir. Un produit est au crédit, d'où le signe inversé. */
async function produitsExploitation(societe: number, date: string): Promise<number> {
  const numero = new Map<number, number>()
  for (const c of await query<Record<string, unknown>>(
    `SELECT IDcompte_compta, numero FROM compte_compta WHERE id_societe = ${societe}`,
  )) {
    numero.set(n(c.IDcompte_compta), n(c.numero))
  }
  let total = 0
  for (const r of await query<Record<string, unknown>>(
    `SELECT IDcompte_compta, debit, credit FROM releve_compta WHERE DATE = '${date}'`,
  )) {
    const num = numero.get(n(r.IDcompte_compta))
    if (num === undefined || num < 700000 || num >= 750000) continue
    total -= n(r.debit) - n(r.credit)
  }
  return total
}

/** The two mounts of the finance router factory. */
const MOUNTS = [
  { base: '/rapports', societe: 1, label: 'ETS Malterre' },
  { base: '/rapports-trm', societe: 2, label: 'Tricotage Malterre' },
]

async function checkMount(mount: (typeof MOUNTS)[number]) {
  console.log(`\n=== ${mount.label} — ${mount.base}/finance`)

  const head = await api(`${mount.base}/finance/analyse`)
  if (head.status !== 200) { fail(`GET ${mount.base}/finance/analyse → ${head.status}`); return }
  const annees: number[] = head.json.annees ?? []
  if (annees.length === 0) { console.log('  (aucun upload — rien à vérifier)'); return }

  for (const annee of annees) {
    const [rapport, analyse] = await Promise.all([
      api(`${mount.base}/finance?annee=${annee}`),
      api(`${mount.base}/finance/analyse?annee=${annee}`),
    ])
    if (rapport.status !== 200) { fail(`${annee}: GET ${mount.base}/finance → ${rapport.status}`); continue }
    if (analyse.status !== 200) { fail(`${annee}: GET ${mount.base}/finance/analyse → ${analyse.status}`); continue }

    // The report's own totals bar: sum the lignes by bucket, exactly as the
    // screen and the Charges widget do (never `totaux.frais_*`).
    let repFixe = 0
    let repVar = 0
    for (const l of rapport.json.lignes ?? []) {
      if (n(l.variable) === 1) repVar += n(l.montant)
      else repFixe += n(l.montant)
    }

    const points = analyse.json.points ?? []
    const last = points[points.length - 1]
    if (!last) { fail(`${annee}: la série analyse est vide alors que le rapport a ${(rapport.json.lignes ?? []).length} lignes`); continue }

    // Same anchor on both sides, or the comparison is meaningless.
    if (last.date !== rapport.json.date_arrete) {
      fail(`${annee}: ancrages différents — rapport ${rapport.json.date_arrete}, analyse ${last.date}`)
      continue
    }

    const df = n(last.charges_fixes) - repFixe
    const dv = n(last.charges_variables) - repVar
    if (Math.abs(df) > EPS || Math.abs(dv) > EPS) {
      fail(`${annee} @ ${last.date}: fixes rapport ${eur(repFixe)} vs widget ${eur(n(last.charges_fixes))} (${eur(df)}) | ` +
           `variables rapport ${eur(repVar)} vs widget ${eur(n(last.charges_variables))} (${eur(dv)})`)
      continue
    }
    // ── Périmètre de l'exploitation (ajouté 2026-08-26) ────────────────────
    // L'EBE s'arrête avant le financier, l'exceptionnel et les dotations. Le
    // découpage « classe 6 = charge / classe 7 = produit » était trop large et
    // gonflait l'EBE 2025 d'ETM de 6 100 € (escomptes obtenus 8 011 €,
    // escomptes accordés 1 562 €, dons 350 €) — 40 040 € sur 2024. Deux
    // assertions : aucune ligne hors exploitation dans le rapport, et le CA de
    // l'analyse strictement égal aux comptes 70-74 de la balance.
    const horsPerimetre = (rapport.json.lignes ?? []).filter(
      (l: any) => n(l.numero) < 600000 || n(l.numero) >= 650000,
    )
    if (horsPerimetre.length > 0) {
      fail(`${annee}: ${horsPerimetre.length} ligne(s) hors exploitation dans le rapport — ` +
           horsPerimetre.map((l: any) => `${n(l.numero)} ${l.libelle} (${eur(n(l.montant))})`).join(', '))
      continue
    }

    const attendu = await produitsExploitation(mount.societe, last.date)
    const dp = n(last.ca) - attendu
    if (Math.abs(dp) > EPS) {
      fail(`${annee} @ ${last.date}: CA analyse ${eur(n(last.ca))} vs produits d'exploitation (70-74) ${eur(attendu)} (${eur(dp)})`)
      continue
    }

    console.log(`  ✓ ${annee} @ ${last.date}  CA ${eur(attendu).padStart(14)}  fixes ${eur(repFixe).padStart(14)}  variables ${eur(repVar).padStart(14)}`)
  }
}

/** Informational: how far `upload_compta`'s frozen buckets have drifted from the
 *  current classification. Never fails — it measures the staleness, and every
 *  stale row is a reclassification the report already reflects. */
async function reportStaleness(societe: number, label: string) {
  const uploads = (
    await query<Record<string, unknown>>(
      `SELECT DATE, frais_fixe, frais_variable FROM upload_compta WHERE id_societe = ${societe}`,
    )
  )
    .map((r) => ({ date: String(r.DATE ?? '').replace(/\D/g, ''), fixe: n(r.frais_fixe), variable: n(r.frais_variable) }))
    .filter((r) => /^\d{8}$/.test(r.date))

  const bucket = new Map<number, 0 | 1>()
  for (const c of await query<Record<string, unknown>>(
    `SELECT IDcompte_compta, numero, frais_variable FROM compte_compta WHERE id_societe = ${societe}`,
  )) {
    const num = n(c.numero)
    if (num > 0 && num < 700000) bucket.set(n(c.IDcompte_compta), n(c.frais_variable) === 1 ? 1 : 0)
  }

  let stale = 0
  let worst = 0
  for (const u of uploads) {
    const rows = await query<Record<string, unknown>>(
      `SELECT IDcompte_compta, debit, credit FROM releve_compta WHERE DATE = '${u.date}'`,
    )
    if (rows.length === 0) continue
    let f = 0
    for (const r of rows) {
      const b = bucket.get(n(r.IDcompte_compta))
      if (b === 0) f += n(r.debit) - n(r.credit)
    }
    const d = Math.abs(f - u.fixe)
    if (d > 0.05) { stale++; worst = Math.max(worst, d) }
  }
  console.log(`  ${label}: ${stale}/${uploads.length} uploads dont le split figé est périmé` +
              (stale ? ` (écart max ${eur(worst)} € sur les charges fixes)` : ''))
}

async function main() {
  for (const m of MOUNTS) await checkMount(m)
  console.log('\n=== Vétusté des buckets figés dans upload_compta (informatif)')
  await reportStaleness(1, 'ETS Malterre')
  await reportStaleness(2, 'Tricotage Malterre')
  console.log(failures === 0
    ? '\n✓ OK — le widget Analyse financière et le rapport Finance donnent les mêmes charges'
    : `\n✗ ${failures} échec(s)`)
  if (failures) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
