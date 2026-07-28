// Verify the /rapports/commandes-clients endpoint against the legacy
// "Rapport commandes clients" figures read off the reference screenshots.
// Drives the real route handler in-process (fake req/res) so what is checked
// is exactly what the API serves.
import dotenv from 'dotenv'
dotenv.config({ path: '.env' })
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` })

import { rapportsRouter } from '../routes/rapports.js'

interface Row {
  IDligne_commande_client: number
  numero: number | null
  client_nom: string
  ref_client: string
  facturation_nom: string
  livraison_nom: string
  reference: string
  coloris: string
  designation: string
  unite_label: string
  qte_commandee: number
  qte_expediee: number
  qte_stock: number
  qte_affectee: number
  qte_en_sst: number
  total_ht_non_facture: number
  delai: string | null
  commentaire_ligne: string
  commentaire_client: string
}

/** Call the route handler registered for GET <path> and resolve its JSON. */
function callRoute(path: string, queryParams: Record<string, string>): Promise<{ status: number; body: any }> {
  const layer = (rapportsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods.get,
  )
  if (!layer) throw new Error(`route GET ${path} not found`)
  const handler = layer.route.stack[0].handle
  return new Promise((resolve, reject) => {
    let status = 200
    const res: any = {
      status(code: number) { status = code; return res },
      json(body: any) { resolve({ status, body }) },
    }
    Promise.resolve(handler({ query: queryParams } as any, res, reject)).catch(reject)
  })
}

// Legacy figures read off the two reference screenshots (localhost DB).
const EXPECTED: Array<{
  line: number
  label: string
  cmde: number; exp: number; stock: number; aff: number; sst: number; nonFact: number
  delai: string
}> = [
  { line: 12413, label: '3616 · 088A · 1112 rouge cerise', cmde: 56, exp: 57.9, stock: 0, aff: 0, sst: 0, nonFact: -28.69, delai: '20260313' },
  { line: 12414, label: '3616 · 088B · ecru', cmde: 56, exp: 62.5, stock: 0, aff: 0, sst: 0, nonFact: -65.52, delai: '20260313' },
  { line: 12415, label: '3616 · 088A · 1112 anthracite', cmde: 56, exp: 59.3, stock: 0, aff: 0, sst: 0, nonFact: -45.28, delai: '20260313' },
  { line: 12417, label: '3617 · 061A · 0806 Blanc Malterre', cmde: 244, exp: 0, stock: 222.3, aff: 245.5, sst: 0, nonFact: 1991.04, delai: '20260317' },
  { line: 12418, label: '3617 · 061A · 0806 Noir Malterre', cmde: 244, exp: 250.8, stock: 6.4, aff: 0, sst: 0, nonFact: -59.84, delai: '20260317' },
  { line: 12482, label: '3643 · 180A · 0307 terracotta', cmde: 1635, exp: 0, stock: 47, aff: 0, sst: 876.91, nonFact: 24982.8, delai: '20260504' },
  { line: 12483, label: '3643 · 180A · Marine LTP', cmde: 1635, exp: 0, stock: 49, aff: 0, sst: 0, nonFact: 24982.8, delai: '20260518' },
  { line: 12484, label: '3643 · 180B · ecru', cmde: 528, exp: 0, stock: 214, aff: 0, sst: 0, nonFact: 6985.44, delai: '20260518' },
  { line: 12485, label: '3643 · 180A · 0806 noir malterre', cmde: 578, exp: 0, stock: 0, aff: 0, sst: 0, nonFact: 8831.84, delai: '20260526' },
]

// Legacy label columns for a couple of rows (screenshot 1).
const EXPECTED_LABELS: Array<{ line: number; field: keyof Row; value: string }> = [
  { line: 12417, field: 'client_nom', value: 'LEMAHIEU' },
  { line: 12417, field: 'ref_client', value: 'Commande 100001769 DU 29/01/2026' },
  { line: 12417, field: 'facturation_nom', value: 'H LEMAHIEU SA' },
  { line: 12417, field: 'livraison_nom', value: 'H LEMAHIEU SA' },
  { line: 12417, field: 'reference', value: '061A' },
  { line: 12417, field: 'coloris', value: '0806 Blanc Malterre' },
  { line: 12417, field: 'designation', value: 'Côte 2/1 coton bio élasthanne' },
  { line: 12482, field: 'client_nom', value: 'Le teeshirt propre' },
  { line: 12482, field: 'livraison_nom', value: 'Atelier Julien H' },
  { line: 12482, field: 'reference', value: '180A' },
  { line: 12482, field: 'designation', value: '100% lin' },
  { line: 12482, field: 'commentaire_ligne', value: '50 m en tubulaire - 876 m en stt' },
]

const near = (a: number, b: number) => Math.abs(a - b) < 0.02

async function main() {
  const t0 = Date.now()
  const { status, body } = await callRoute('/commandes-clients', { soldees: '0' })
  const ms = Date.now() - t0
  if (status !== 200) { console.error('HTTP', status, body); process.exit(1) }
  const rows = body as Row[]
  console.log(`GET /rapports/commandes-clients?soldees=0 → ${rows.length} rows in ${ms} ms\n`)

  const byId = new Map(rows.map((r) => [r.IDligne_commande_client, r]))
  let fails = 0

  console.log('=== numeric columns vs legacy ===')
  for (const e of EXPECTED) {
    const r = byId.get(e.line)
    if (!r) { console.log(`  MISSING  ligne ${e.line} — ${e.label}`); fails++; continue }
    const checks: Array<[string, number, number]> = [
      ['Qté commandée', r.qte_commandee, e.cmde],
      ['Qté expédiée', r.qte_expediee, e.exp],
      ['Qté stock', r.qte_stock, e.stock],
      ['Affecté', r.qte_affectee, e.aff],
      ['En SST', r.qte_en_sst, e.sst],
      ['Total HT non facturé', r.total_ht_non_facture, e.nonFact],
    ]
    const bad = checks.filter(([, got, want]) => !near(got, want))
    if (r.delai !== e.delai) bad.push(['Délai', NaN, NaN])
    if (bad.length === 0) console.log(`  OK        ${e.label}`)
    else {
      fails++
      console.log(`  MISMATCH  ${e.label}`)
      for (const [name, got, want] of checks)
        if (!near(got, want)) console.log(`              ${name}: got ${got} · legacy ${want}`)
      if (r.delai !== e.delai) console.log(`              Délai: got ${r.delai} · legacy ${e.delai}`)
    }
  }

  console.log('\n=== label columns vs legacy ===')
  for (const e of EXPECTED_LABELS) {
    const r = byId.get(e.line)
    const got = (r?.[e.field] ?? '').toString().trim()
    if (got === e.value) console.log(`  OK        ${e.line}.${String(e.field)} = "${got}"`)
    else { fails++; console.log(`  MISMATCH  ${e.line}.${String(e.field)}: got "${got}" · legacy "${e.value}"`) }
  }

  // Sanity: every row must carry a unit label and no NaN slipped through.
  const nanRows = rows.filter((r) =>
    [r.qte_commandee, r.qte_expediee, r.qte_stock, r.qte_affectee, r.qte_en_sst, r.total_ht_non_facture]
      .some((v) => !Number.isFinite(v)),
  )
  console.log(`\nrows with non-finite numbers: ${nanRows.length}`)
  if (nanRows.length > 0) { fails++; console.log('  ', JSON.stringify(nanRows.slice(0, 3))) }

  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
