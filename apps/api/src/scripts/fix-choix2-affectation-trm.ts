/**
 * Data repair for LIVA #1129 — déclassé rolls the visitage poste reserved for a
 * commande line.
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/fix-choix2-affectation-trm.ts          # dry run
 *   pnpm --filter @mps/api exec tsx src/scripts/fix-choix2-affectation-trm.ts --write  # persist
 *
 * From its first day in prod (2026-08-26) until the fix shipped, `POST
 * /visitage-trm/valider` stamped `IDLigne_Commande_TRM = the OF's line` on
 * every roll it created, déclassés included. The legacy never did that for a
 * 2nd choice roll: it leaves visitage at 0, sits in Tombé Métier › Stock as
 * « Disponible », and only gets a line — by hand — when someone ships it. A
 * stamped déclassé shows on the commande's Affectation tab at full weight and
 * goes out with the next « Expédier » as if it were 1er choix (3554/1001).
 *
 * What this script does: sets `IDLigne_Commande_TRM = 0` on the déclassés the
 * poste stamped and that are STILL IN STOCK, so they go back to the free pool.
 *
 * What it deliberately leaves alone:
 *   - a stamped déclassé that has already shipped (`IDligne_expedition_TRM > 0`):
 *     zeroing its line would orphan it on its avis and its invoice. Those are a
 *     human decision (was the roll really sent? at which weight?), handled
 *     through ETM and the invoice, not through the stock table. They are
 *     listed, never touched.
 *   - a déclassé whose line is NOT its OF's line: that is a manual affectation
 *     from the legacy commande screen, i.e. someone's intent. Skipped.
 *
 * Read without an `IDsociete` filter on purpose: « Expédier » hands a roll
 * shipped to Ets Malterre over to société 1, and a partition filter is how the
 * first probe of this ticket missed 3554/1001. The partition guard is the OF.
 * `IDLigne_Commande_TRM` is ASCII → plain named UPDATE.
 *
 * Idempotent: re-running finds nothing. Run it on the host right after the
 * `/etm_deploy` that ships the route fix — any déclassé validated between the
 * fix's commit and its deploy is caught here.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { round2 } from '../lib/production-trm.js'

/** First day the poste wrote to prod (yyyymmdd). Mirrors probe-visitage-trm.ts. */
const POSTE_LIVE = '20260826'

type Row = {
  IDstock_ecru: number
  numero: string
  poids: number
  IDsociete: number
  IDLigne_Commande_TRM: number
  IDligne_expedition_TRM: number
  date_saisie: string
  of_ligne: number
}

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0)
const d8 = (v: unknown) => String(v ?? '').replace(/[^0-9]/g, '').slice(0, 8)

async function main() {
  const write = process.argv.includes('--write')
  console.log(`déclassés réservés par le poste de visitage depuis le ${POSTE_LIVE}`)
  console.log(write ? 'mode: ÉCRITURE\n' : 'mode: simulation (--write pour appliquer)\n')

  const rows = await query<Row>(
    `SELECT se.IDstock_ecru, se.numero, se.poids, se.IDsociete, se.IDLigne_Commande_TRM,
            se.IDligne_expedition_TRM, se.date_saisie, orf.IDligne_commande_client AS of_ligne
     FROM stock_ecru se
     INNER JOIN ordre_fabrication orf ON orf.IDordre_fabrication = se.IDordre_fabrication
     WHERE se.IDordre_fabrication > 0 AND se.second_choix = 1 AND se.IDLigne_Commande_TRM > 0
     ORDER BY se.IDstock_ecru`,
  )
  const since = rows.filter((r) => d8(r.date_saisie) >= POSTE_LIVE)
  console.log(`${since.length} déclassé(s) affecté(s) à une ligne depuis le ${POSTE_LIVE}`)

  const toFix: Row[] = []
  for (const r of since) {
    const tag = `${r.numero} (#${n(r.IDstock_ecru)}, ${round2(n(r.poids))} Kg, saisie ${d8(r.date_saisie)}, ligne ${n(r.IDLigne_Commande_TRM)})`
    if (n(r.IDligne_expedition_TRM) > 0) {
      console.log(`  · ${tag} — déjà expédié (avis via ligne_expedition ${n(r.IDligne_expedition_TRM)}), laissé tel quel`)
      continue
    }
    if (n(r.IDLigne_Commande_TRM) !== n(r.of_ligne)) {
      console.log(`  · ${tag} — affecté à une autre ligne que celle de l'OF (${n(r.of_ligne)}) : affectation manuelle, laissé tel quel`)
      continue
    }
    console.log(`  + ${tag} — en stock, réservé par le poste → libérer`)
    toFix.push(r)
  }

  console.log(`\n${toFix.length} rouleau(x) à libérer`)
  if (!write || toFix.length === 0) {
    if (!write && toFix.length > 0) console.log('Rien écrit — relancer avec --write.')
    return
  }

  for (const r of toFix) {
    await query(`UPDATE stock_ecru SET IDLigne_Commande_TRM = 0 WHERE IDstock_ecru = ${n(r.IDstock_ecru)}`)
    console.log(`  ✓ ${r.numero} libéré`)
  }
  // Read back: the row must be free, and nothing else must have moved.
  const back = await query<{ IDstock_ecru: number; IDLigne_Commande_TRM: number }>(
    `SELECT IDstock_ecru, IDLigne_Commande_TRM FROM stock_ecru
     WHERE IDstock_ecru IN (${toFix.map((r) => n(r.IDstock_ecru)).join(',')})`,
  )
  const still = back.filter((r) => n(r.IDLigne_Commande_TRM) !== 0)
  if (still.length > 0) {
    console.error(`⚠️ ${still.length} rouleau(x) portent encore une ligne après l'écriture : ${still.map((r) => r.IDstock_ecru).join(', ')}`)
    process.exitCode = 1
  } else {
    console.log(`\n${toFix.length} rouleau(x) libéré(s), relecture conforme.`)
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => closeConnection())
