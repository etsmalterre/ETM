/**
 * Replay guard for Paramètres › Outils › Import de la balance Sage.
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-import-sage.ts
 *
 * READ-ONLY. Re-parses every export the import ever stored in
 * `upload_compta.fichier` (the legacy WinDev window kept them all) and checks,
 * per upload:
 *
 *   1. the totals — `parseBalanceSage` + `totauxBalance` must give back the
 *      stored `charges` and `produits` to the cent. Exempt: ETM uploads before
 *      2026, where the legacy stock step (`PriseEnCompteStockETM`, not ported)
 *      added the inventory variation + depreciation to the charges;
 *   2. the company check — each file, compared with the previous
 *      `EMPREINTE_NB_FICHIERS` exports of both companies, must be accepted by
 *      `verifierSociete` for its own company and refused for the other.
 *
 * The dev copy is stale; point it at prod (SELECT only) by setting
 * HFSQL_CONNECTION_STRING to the value in apps/api/.env.production first —
 * dotenv never overrides a variable already set.
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

const { query, queryRaw, closeConnection } = await import('../lib/hfsql-auto.js')
const {
  EMPREINTE_NB_FICHIERS,
  decodeBalance,
  parseBalanceSage,
  totauxBalance,
  verifierSociete,
} = await import('../lib/import-sage.js')

const num = (v: unknown) => (v == null ? 0 : Number(v) || 0)
const cents = (x: number) => Math.round(x * 100)

interface Upload {
  id: number
  societe: number
  date: string
  charges: number
  produits: number
  empreinte: Set<string>
  totaux: { charges: number; produits: number }
}

let failures = 0

async function main() {
  const headers = await query<Record<string, unknown>>(
    `SELECT IDupload_compta, id_societe, DATE, charges, produits FROM upload_compta ORDER BY IDupload_compta`,
  )
  const comptes = await query<{ numero: number; frais_variable: number; id_societe: number }>(
    `SELECT numero, frais_variable, id_societe FROM compte_compta`,
  )
  const variable = new Set(comptes.filter((c) => num(c.frais_variable) === 1).map((c) => `${c.id_societe}:${c.numero}`))

  const uploads: Upload[] = []
  let sansFichier = 0
  for (const h of headers) {
    const id = num(h.IDupload_compta)
    const societe = num(h.id_societe)
    const rows = await queryRaw(`SELECT fichier FROM upload_compta WHERE IDupload_compta = ${id}`)
    const f = rows[0]?.fichier
    const buf = f instanceof ArrayBuffer ? Buffer.from(f) : Buffer.isBuffer(f) ? f : null
    if (!buf || buf.length === 0) { sansFichier++; continue }
    const balance = parseBalanceSage(decodeBalance(buf))
    const t = totauxBalance(balance.lignes, (n) => variable.has(`${societe}:${n}`))
    uploads.push({
      id,
      societe,
      date: String(h.DATE ?? '').replace(/-/g, '').slice(0, 8),
      charges: num(h.charges),
      produits: num(h.produits),
      empreinte: balance.empreinte,
      totaux: t,
    })
  }
  console.log(`${uploads.length} uploads with a stored export (${sansFichier} without)\n`)

  // 1. Totals
  let totauxOk = 0
  let exemptes = 0
  for (const u of uploads) {
    const legacyStock = u.societe === 1 && u.date < '20260101'
    const ok = cents(u.totaux.charges) === cents(u.charges) && cents(u.totaux.produits) === cents(u.produits)
    if (ok) { totauxOk++; continue }
    if (legacyStock && cents(u.totaux.produits) === cents(u.produits)) { exemptes++; continue }
    failures++
    console.error(`  FAIL totals upload ${u.id} (société ${u.societe}, ${u.date}): ` +
      `charges ${u.totaux.charges} vs ${u.charges}, produits ${u.totaux.produits} vs ${u.produits}`)
  }
  console.log(`  totals: ${totauxOk} exact, ${exemptes} ETM pre-2026 (legacy stock step), ${uploads.length - totauxOk - exemptes} failing`)

  // 2. Company check, against the exports that preceded each one
  let verdictsOk = 0
  let compares = 0
  let ecartMin = Infinity
  for (const u of uploads) {
    const reference = (societe: number) => {
      const set = new Set<string>()
      for (const p of uploads.filter((x) => x.societe === societe && x.id < u.id).slice(-EMPREINTE_NB_FICHIERS)) {
        for (const k of p.empreinte) set.add(k)
      }
      return set
    }
    const propre = reference(u.societe)
    const autre = reference(u.societe === 1 ? 2 : 1)
    if (propre.size === 0 || autre.size === 0) continue
    compares++
    const bon = verifierSociete(u.empreinte, propre, autre)
    const mauvais = verifierSociete(u.empreinte, autre, propre)
    ecartMin = Math.min(ecartMin, bon.ressemblanceCible - bon.ressemblanceAutre)
    if (bon.ok && !mauvais.ok) { verdictsOk++; continue }
    failures++
    console.error(`  FAIL company check upload ${u.id} (société ${u.societe}, ${u.date}): ` +
      `own ${bon.ressemblanceCible.toFixed(3)} vs other ${bon.ressemblanceAutre.toFixed(3)}`)
  }
  console.log(`  company check: ${verdictsOk}/${compares} files accepted for their company AND refused for the other ` +
    `(smallest margin ${(ecartMin * 100).toFixed(1)} points)`)
}

try {
  await main()
} finally {
  await closeConnection()
}
console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
