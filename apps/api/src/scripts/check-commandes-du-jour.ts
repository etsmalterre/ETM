/**
 * Guard for the "Commandes du jour" widget
 * (GET /api/commandes-client/du-jour).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-commandes-du-jour.ts
 *
 * Pins the money maths on a known day, because the widget puts a figure on the
 * dashboard that people will quote: 2026-03-23 has 6 ETM orders worth
 * 273 180,32 € HT, one of which is a donation and must stay out of the total.
 * Read-only.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'

const DAY = '20260323'
const EXPECT_COUNT = 6
const EXPECT_TOTAL = 273180.32
const EXPECT_DONATIONS = 1

async function main() {
  let problems = 0
  const check = (label: string, got: unknown, want: unknown) => {
    const ok = String(got) === String(want)
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (expected ${JSON.stringify(want)})`}`)
    if (!ok) problems++
  }

  // Same scope the endpoint uses: ETM ledger only, TRM mirrors excluded.
  const cmds = await query<{ IDcommande_client: number; donation: number }>(
    `SELECT IDcommande_client, donation FROM commande_client
     WHERE date_commande = '${DAY}' AND IDsociete = 1 AND IDcommande_ETM = 0`,
  )
  console.log(`commandes du ${DAY}`)
  check('nb commandes', cmds.length, EXPECT_COUNT)
  check('nb dons', cmds.filter((c) => Number(c.donation) === 1).length, EXPECT_DONATIONS)

  const ids = cmds.map((c) => Number(c.IDcommande_client))
  const lignes = ids.length > 0
    ? await query<{ IDcommande_client: number; quantite: number | null; prix: number | null }>(
      `SELECT IDcommande_client, quantite, prix FROM ligne_commande_client
       WHERE IDcommande_client IN (${ids.join(',')})`)
    : []

  const donationIds = new Set(cmds.filter((c) => Number(c.donation) === 1).map((c) => Number(c.IDcommande_client)))
  const total = lignes
    .filter((l) => !donationIds.has(Number(l.IDcommande_client)))
    .reduce((s, l) => s + (Number(l.quantite) || 0) * (Number(l.prix) || 0), 0)
  check('total HT (hors dons)', total.toFixed(2), EXPECT_TOTAL.toFixed(2))

  // The rule that makes the donation exclusion meaningful rather than cosmetic:
  // if a donation ever carries priced lines, the total must still ignore them.
  const donationValue = lignes
    .filter((l) => donationIds.has(Number(l.IDcommande_client)))
    .reduce((s, l) => s + (Number(l.quantite) || 0) * (Number(l.prix) || 0), 0)
  console.log(`  ⓘ valeur des lignes de dons ce jour-là : ${donationValue.toFixed(2)} € (exclue du CA)`)

  await closeConnection()
  console.log(problems === 0 ? '\n✓ all checks passed' : `\n✗ ${problems} problem(s)`)
  process.exit(problems === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
