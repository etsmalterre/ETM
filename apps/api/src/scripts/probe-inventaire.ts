import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })
const { query, closeConnection } = await import('../lib/hfsql-auto.js')
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const e = (v: number) => Math.round(v).toLocaleString('fr-FR').padStart(10)

async function main() {
  const types = await query<Record<string, unknown>>(`SELECT * FROM type_stock`)
  console.log('type_stock :')
  for (const t of types) console.log('  ' + Object.entries(t).map(([k, v]) => `${k}=${v}`).join('  '))

  const rows = await query<Record<string, unknown>>(`SELECT * FROM inventaire_compta`)
  const byDate = new Map<string, Map<number, { pa: number; vd: number; q: number }>>()
  for (const r of rows) {
    const d = String(r.DATE ?? '').replace(/\D/g, '')
    if (!byDate.has(d)) byDate.set(d, new Map())
    byDate.get(d)!.set(n(r.IDtype_stock), { pa: n(r.prix_achat), vd: n(r.valeur_deprecie), q: n(r.quantite) })
  }
  console.log('\nSynthèse par arrêté (prix_achat = brut, valeur_deprecie = net) :')
  console.log('date        brut        net    provision   |   t1 net    t2 net    t3 net    t4 net')
  for (const [d, m] of [...byDate.entries()].sort()) {
    const pa = [...m.values()].reduce((t, v) => t + v.pa, 0)
    const vd = [...m.values()].reduce((t, v) => t + v.vd, 0)
    console.log(`${d}  ${e(pa)} ${e(vd)} ${e(pa - vd)}   | ${[1, 2, 3, 4].map((i) => e(m.get(i)?.vd ?? 0)).join(' ')}`)
  }
  const dates = [...byDate.keys()].sort()
  console.log(`\n⚠ dernier arrêté : ${dates[dates.length - 1]}   (aujourd'hui : 20260825)`)

  // tie-out to the 2024 bilan
  const d24 = byDate.get('20241228')
  if (d24) {
    const pa = [...d24.values()].reduce((t, v) => t + v.pa, 0)
    const vd = [...d24.values()].reduce((t, v) => t + v.vd, 0)
    console.log('\nRapprochement avec le bilan au 31/12/2024 :')
    console.log(`  inventaire_compta  brut ${e(pa)}  net ${e(vd)}  provision ${e(pa - vd)}`)
    console.log(`  bilan 2024         brut ${e(693776)}  net ${e(435539)}  provision ${e(258237)}`)
    console.log(`  écart              brut ${e(693776 - pa)}  net ${e(435539 - vd)}  provision ${e(258237 - (pa - vd))}`)
  }
}
main().catch((e) => { console.error(String(e).slice(0, 600)); process.exitCode = 1 }).finally(() => closeConnection())
