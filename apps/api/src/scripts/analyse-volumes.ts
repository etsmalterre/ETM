/**
 * Ad-hoc, read-only: volume flows over the SAME window of each year
 * (1 jan → 28 jul), so the accounting deltas can be read per kilo.
 *
 *   NODE_ENV=production node --import tsx src/scripts/analyse-volumes.ts
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })
const { query, closeConnection } = await import('../lib/hfsql-auto.js')

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const d8 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(0, 8)
const kg = (v: number) => Math.round(v).toLocaleString('fr-FR').padStart(10) + ' kg'
const eur = (v: number) => Math.round(v).toLocaleString('fr-FR') + ' €'
const WIN = [['20250101', '20250728'], ['20260101', '20260728']] as const
const inWin = (d: string, w: readonly [string, string]) => !!d && d >= w[0] && d <= w[1]

async function main() {
  const exps = await query<Record<string, unknown>>(`SELECT IDexpedition, DATE AS dexp FROM expedition`)
  const expDate = new Map<number, string>()
  for (const e of exps) expDate.set(n(e.IDexpedition), d8(e.dexp))
  const lignes = await query<Record<string, unknown>>(`SELECT IDligne_expedition, IDexpedition FROM ligne_expedition`)
  const leDate = new Map<number, string>()
  for (const l of lignes) { const d = expDate.get(n(l.IDexpedition)); if (d) leDate.set(n(l.IDligne_expedition), d) }

  const ecru = await query<Record<string, unknown>>(
    `SELECT IDstock_ecru, poids, date_saisie, IDligne_expedition_ETM FROM stock_ecru WHERE IDsociete = 1`,
  )
  const fini = await query<Record<string, unknown>>(
    `SELECT IDstock_fini, poids, date_saisie, IDligne_expedition FROM stock_fini`,
  )
  const fil = await query<Record<string, unknown>>(`SELECT stock_initial, date_entree FROM stock_fil`)

  console.log('FLUX PHYSIQUES SUR LA MÊME FENÊTRE (1 jan → 28 jui)\n')
  const res: Record<string, number>[] = []
  for (const w of WIN) {
    const prodEcru = ecru.filter((r) => inWin(d8(r.date_saisie), w)).reduce((t, r) => t + n(r.poids), 0)
    const prodFini = fini.filter((r) => inWin(d8(r.date_saisie), w)).reduce((t, r) => t + n(r.poids), 0)
    let exped = 0
    for (const r of fini) { const d = leDate.get(n(r.IDligne_expedition)); if (d && inWin(d, w)) exped += n(r.poids) }
    for (const r of ecru) { const d = leDate.get(n(r.IDligne_expedition_ETM)); if (d && inWin(d, w)) exped += n(r.poids) }
    const filIn = fil.filter((r) => inWin(d8(r.date_entree), w)).reduce((t, r) => t + n(r.stock_initial), 0)
    console.log(`  ${w[0]} → ${w[1]}`)
    console.log(`    fil entré en stock      ${kg(filIn)}`)
    console.log(`    écru tombé de métier    ${kg(prodEcru)}`)
    console.log(`    rouleaux finis produits ${kg(prodFini)}`)
    console.log(`    expédié (écru + fini)   ${kg(exped)}`)
    res.push({ filIn, prodEcru, prodFini, exped })
  }
  const [a, b] = res
  const pc = (x: number, y: number) => (y ? ((x - y) / y * 100).toFixed(1) : '—') + ' %'
  console.log('\n  Évolution 2026 vs 2025')
  console.log(`    fil entré       ${pc(b.filIn, a.filIn).padStart(9)}   (${Math.round(b.filIn - a.filIn).toLocaleString('fr-FR')} kg)`)
  console.log(`    écru produit    ${pc(b.prodEcru, a.prodEcru).padStart(9)}   (${Math.round(b.prodEcru - a.prodEcru).toLocaleString('fr-FR')} kg)`)
  console.log(`    finis produits  ${pc(b.prodFini, a.prodFini).padStart(9)}   (${Math.round(b.prodFini - a.prodFini).toLocaleString('fr-FR')} kg)`)
  console.log(`    expédié         ${pc(b.exped, a.exped).padStart(9)}   (${Math.round(b.exped - a.exped).toLocaleString('fr-FR')} kg)`)

  // ── per-kilo economics, using the compte de résultat figures
  const CA = [1788553, 1908171], CV = [1298986, 1528133]
  console.log('\n' + '═'.repeat(66) + '\nÉCONOMIE AU KILO (produits & charges variables / kg expédié)\n')
  for (let i = 0; i < 2; i++) {
    const e = res[i].exped
    console.log(`  ${WIN[i][1]}   CA/kg expédié ${(CA[i] / e).toFixed(2)} €   charges var./kg ${(CV[i] / e).toFixed(2)} €   marge/kg ${((CA[i] - CV[i]) / e).toFixed(2)} €`)
  }
  const cvKg = CV[1] / res[1].exped
  console.log(`\n  Coût variable au kilo 2026 : ${cvKg.toFixed(2)} €/kg`)
  console.log(`  Sur-stock constaté au 28/07 : +11 884 kg  →  valorisé ${eur(11884 * cvKg)}`)
  console.log(`  (à comparer à l'écart de marge brute de -109 529 €)`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
