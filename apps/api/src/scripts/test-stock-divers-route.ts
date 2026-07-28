// Smoke test for the stock-divers route helpers against the live HFSQL copy:
// exercises the same queries the list / detail / lookup endpoints run, without
// booting Express. Read-only.
import { query } from '../lib/hfsql-auto.js'
import {
  batchRepair,
  money,
  normalizeVariationType,
  pickKey,
  qty,
  uniteLabel,
} from '../routes/references-divers.js'

async function main() {
  const refRaw = await query<Record<string, unknown>>(`SELECT * FROM ref_divers`)
  const refs = new Map<number, any>()
  const shaped = refRaw.map((r) => ({
    IDref_divers: Number(r.IDref_divers) || 0,
    designation: (r.designation ?? null) as string | null,
    unite: Number(r.unite) || 0,
    prix_unitaire: money(r.prix_unitaire) ?? 0,
    archive: Number(pickKey(r, /^archiv/i)) ? 1 : 0,
    sTypeVariation1: normalizeVariationType(r.sTypeVariation1),
    sTypeVariation2: normalizeVariationType(r.sTypeVariation2),
  }))
  const fixedRefs = (await batchRepair(shaped as never, 'ref_divers', 'IDref_divers', ['designation'])) as any[]
  for (const r of fixedRefs) refs.set(r.IDref_divers, r)
  console.log(`ref_divers: ${refs.size} (archivées: ${fixedRefs.filter((r) => r.archive).length})`)

  const varRaw = await query<Record<string, unknown>>(
    `SELECT IDref_divers_variation, designation FROM ref_divers_variation`,
  )
  const varFixed = await batchRepair(varRaw, 'ref_divers_variation', 'IDref_divers_variation', ['designation'])
  const labels = new Map<number, string>()
  for (const v of varFixed) labels.set(Number(v.IDref_divers_variation) || 0, String(v.designation ?? '').trim())
  console.log(`ref_divers_variation: ${labels.size}`)

  const tarifs = new Map<number, Map<string, number>>()
  const tRows = await query<Record<string, unknown>>(
    `SELECT IDref_divers, prix, IDVariation1, IDVariation2 FROM tarif_divers`,
  )
  for (const t of tRows) {
    const rid = Number(t.IDref_divers) || 0
    if (!tarifs.has(rid)) tarifs.set(rid, new Map())
    tarifs.get(rid)!.set(`${Number(t.IDVariation1) || 0}|${Number(t.IDVariation2) || 0}`, money(t.prix) ?? 0)
  }
  console.log(`tarif_divers: ${tRows.length} rows over ${tarifs.size} refs`)

  const stock = await query<Record<string, unknown>>(
    `SELECT IDstock_divers, IDref_divers, quantite, unite, IDVariation1, IDVariation2
     FROM stock_divers ORDER BY IDstock_divers DESC`,
  )
  console.log(`stock_divers: ${stock.length} rows\n`)

  let unresolvedRef = 0
  let unresolvedVar = 0
  let priced = 0
  let totalValeur = 0
  const out: string[] = []
  for (const raw of stock) {
    const row = {
      IDstock_divers: Number(raw.IDstock_divers) || 0,
      IDref_divers: Number(raw.IDref_divers) || 0,
      quantite: qty(raw.quantite),
      unite: Number(raw.unite) || 0,
      v1: Number(raw.IDVariation1) || 0,
      v2: Number(raw.IDVariation2) || 0,
    }
    const ref = refs.get(row.IDref_divers)
    if (!ref) unresolvedRef++
    for (const v of [row.v1, row.v2]) if (v > 0 && !labels.has(v)) unresolvedVar++
    const hasAxes = !!ref && (ref.sTypeVariation1 !== 'Aucun' || ref.sTypeVariation2 !== 'Aucun')
    const bucket = tarifs.get(row.IDref_divers)
    const prix = !ref
      ? null
      : !hasAxes
        ? ref.prix_unitaire || null
        : (bucket?.get(`${row.v1}|${row.v2}`) ?? bucket?.get('0|0') ?? null)
    if (prix != null) { priced++; totalValeur += row.quantite * prix }
    if (out.length < 15) {
      out.push(
        `#${row.IDstock_divers} ${ref?.designation ?? '??'} | ${labels.get(row.v1) ?? '—'} | ${labels.get(row.v2) ?? '—'} | ${row.quantite} ${uniteLabel(row.unite || ref?.unite)} | prix ${prix ?? '—'}`,
      )
    }
  }
  console.log(out.join('\n'))
  console.log(`\nunresolved refs: ${unresolvedRef} · unresolved variation ids: ${unresolvedVar}`)
  console.log(`priced rows: ${priced}/${stock.length} · valorisation totale: ${totalValeur.toFixed(2)} €`)
  console.log(`rows at zero: ${stock.filter((r) => qty(r.quantite) === 0).length}`)
  console.log(
    `rows on archived refs: ${stock.filter((r) => refs.get(Number(r.IDref_divers))?.archive === 1).length}`,
  )

  // Duplicate-combination check — the create guard exists to stop these.
  const seen = new Map<string, number>()
  let dups = 0
  for (const r of stock) {
    const k = `${Number(r.IDref_divers)}|${Number(r.IDVariation1) || 0}|${Number(r.IDVariation2) || 0}`
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  for (const [k, n] of seen) if (n > 1) { dups++; if (dups <= 5) console.log(`  duplicate combination: ${k} ×${n}`) }
  console.log(`duplicate combinations already in data: ${dups}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
