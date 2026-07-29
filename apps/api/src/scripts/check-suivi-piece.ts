/**
 * Guard for the "Suivi pièce" widget (GET /api/stock/ecru/suivi).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-suivi-piece.ts
 *
 * Pins the field mapping to the legacy FI_Suivi_pièce.wdw screen captured for
 * piece 3397/30. Read-only.
 *
 * The dev database is a stale copy of prod, so this deliberately checks only
 * what the snapshot can still prove: the écru identity, and — the part that is
 * actually easy to get wrong — that `IDref_commande_source` is a LIGNE id whose
 * parent commande is what legacy prints (ligne 8437 → commande 8461), plus that
 * the transfer comes from bon_transfert's own id and DATE. The screenshot also
 * shows an affectation and a fini roll that postdate the snapshot; those are
 * reported, not asserted.
 */
import { query, fixEncoding, closeConnection } from '../lib/hfsql-auto.js'

const NUMERO = '3397/30'
const EXPECT = {
  ref_ecru: '228/122',
  poids: 21.5,
  lot: 'trm11556',
  magasin: 'MATEL',
  commande_source: 8461,
  commande_source_sst: 'Tricotage Malterre',
  bon_transfert: 4165,
  bon_date: '20260303',
  bon_destination: 'MATEL',
}

async function main() {
  let problems = 0
  const fail = (msg: string) => { console.log(`  ✗ ${msg}`); problems++ }
  const check = (label: string, got: unknown, want: unknown) => {
    const ok = String(got) === String(want)
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (expected ${JSON.stringify(want)})`}`)
    if (!ok) problems++
  }

  const ecru = await query<any>(
    `SELECT IDstock_ecru, numero, lot, poids, IDref_ecru, IDmagasin,
            IDref_commande_source, IDref_commande_affectation
     FROM stock_ecru WHERE numero = '${NUMERO}'`,
  )
  if (ecru.length !== 1) {
    console.log(`✗ expected exactly 1 écru piece numbered ${NUMERO}, got ${ecru.length}`)
    await closeConnection(); process.exit(1)
  }
  const e = ecru[0]
  console.log(`piece ${NUMERO} → IDstock_ecru ${e.IDstock_ecru}`)

  const re = await query<any>(`SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru = ${Number(e.IDref_ecru)}`)
  const reFixed = (await fixEncoding(re, 'ref_ecru', 'IDref_ecru', ['reference'])) as any[]
  check('ref écru', String(reFixed[0]?.reference ?? '').trim(), EXPECT.ref_ecru)
  check('poids', Number(e.poids), EXPECT.poids)
  check('lot', String(e.lot ?? '').trim(), EXPECT.lot)

  const mag = await query<any>(`SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant = ${Number(e.IDmagasin)}`)
  const magFixed = (await fixEncoding(mag, 'sous_traitant', 'IDsous_traitant', ['nom'])) as any[]
  check('dernier magasin', String(magFixed[0]?.nom ?? '').trim(), EXPECT.magasin)

  // The mapping worth guarding: ligne id → parent commande id.
  const lineId = Number(e.IDref_commande_source)
  const lcs = await query<any>(
    `SELECT IDcommande_sous_traitant FROM ligne_commande_sous_traitant
     WHERE IDligne_commande_sous_traitant = ${lineId}`)
  const cmdId = Number(lcs[0]?.IDcommande_sous_traitant ?? 0)
  console.log(`  (IDref_commande_source ${lineId} is a LIGNE id → commande ${cmdId})`)
  check('commande source', cmdId, EXPECT.commande_source)
  const cmd = await query<any>(
    `SELECT IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${cmdId}`)
  const sst = await query<any>(
    `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant = ${Number(cmd[0]?.IDsous_traitant ?? 0)}`)
  const sstFixed = (await fixEncoding(sst, 'sous_traitant', 'IDsous_traitant', ['nom'])) as any[]
  check('sous-traitant source', String(sstFixed[0]?.nom ?? '').trim(), EXPECT.commande_source_sst)

  // Transfer: bon id + DATE (reserved word — must be aliased).
  const pt = await query<any>(`SELECT IDbon_transfert FROM piece_transfert WHERE IDpiece_ecru = ${Number(e.IDstock_ecru)}`)
  check('nb transferts', pt.length, 1)
  const bonId = Number(pt[0]?.IDbon_transfert ?? 0)
  check('n° transfert', bonId, EXPECT.bon_transfert)
  const bon = await query<any>(
    `SELECT IDbon_transfert, IDmagasin_source, IDmagasin_destination, DATE AS dtransfert
     FROM bon_transfert WHERE IDbon_transfert = ${bonId}`)
  check('date transfert', String(bon[0]?.dtransfert ?? ''), EXPECT.bon_date)
  const dest = await query<any>(
    `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant = ${Number(bon[0]?.IDmagasin_destination ?? 0)}`)
  const destFixed = (await fixEncoding(dest, 'sous_traitant', 'IDsous_traitant', ['nom'])) as any[]
  check('destination transfert', String(destFixed[0]?.nom ?? '').trim(), EXPECT.bon_destination)

  // Informational — the snapshot predates these; the legacy screenshot has them.
  const fini = await query<any>(`SELECT COUNT(*) AS n FROM stock_fini WHERE IDstock_ecru = ${Number(e.IDstock_ecru)}`)
  console.log(`  ⓘ affectation=${Number(e.IDref_commande_affectation)} fini rolls=${fini[0].n} ` +
    '(the legacy screenshot shows commande 8619 + one fini roll; the dev snapshot predates them)')

  // ── Piece 2778/2: a complete chain, guarding the enrichment joins ──
  console.log('\npiece 2778/2 (full chain — yarns, OF, expéditions)')
  const e2 = await query<any>(
    `SELECT IDstock_ecru, IDordre_fabrication, IDligne_expedition_TRM FROM stock_ecru WHERE numero = '2778/2'`)
  if (e2.length !== 1) {
    fail('expected exactly 1 écru piece numbered 2778/2')
  } else {
    const ofId = Number(e2[0].IDordre_fabrication)
    check('ordre de fabrication', ofId, 2778)

    const of_ = await query<any>(
      `SELECT IDordre_fabrication, date_creation, IDmachine FROM ordre_fabrication WHERE IDordre_fabrication = ${ofId}`)
    check('date tricotage', String(of_[0]?.date_creation ?? ''), '20240503')
    const m = await query<any>(`SELECT IDmachine, nom FROM machine WHERE IDmachine = ${Number(of_[0]?.IDmachine ?? 0)}`)
    check('machine', String((await fixEncoding(m, 'machine', 'IDmachine', ['nom']))[0]?.nom ?? '').trim(), '3J')

    // Yarns come from asso_fil_of (the OF actually consumed them), NOT from
    // asso_fil_lignecmdsst — which is empty for in-house knitting.
    const fils = await query<any>(
      `SELECT IDref_fil, IDcolori_fil, IDstock_fil, pourcentage FROM asso_fil_of WHERE IDordre_fabrication = ${ofId}`)
    check('nb fils', fils.length, 2)
    const viaLine = await query<any>(
      `SELECT COUNT(*) AS n FROM asso_fil_lignecmdsst WHERE IDligne_commande_sous_traitant = 6475`)
    console.log(`  ⓘ asso_fil_lignecmdsst for the tricoteur line: ${viaLine[0].n} row(s) — ` +
      'empty is why the yarns are read through asso_fil_of')
    check('somme des pourcentages', fils.reduce((s: number, f: any) => s + Number(f.pourcentage || 0), 0), 100)

    // The fini roll's shipment to the client.
    const f2 = await query<any>(
      `SELECT IDstock_fini, IDligne_expedition FROM stock_fini WHERE IDstock_ecru = ${Number(e2[0].IDstock_ecru)}`)
    const lex = await query<any>(
      `SELECT IDligne_expedition, IDexpedition FROM ligne_expedition WHERE IDligne_expedition = ${Number(f2[0]?.IDligne_expedition ?? 0)}`)
    const expId = Number(lex[0]?.IDexpedition ?? 0)
    check('expédition fini', expId, 9135)
    const exp = await query<any>(
      `SELECT IDexpedition, IDcommande_client, DATE AS dexp FROM expedition WHERE IDexpedition = ${expId}`)
    check('date expédition', String(exp[0]?.dexp ?? ''), '20240620')
    const cc = await query<any>(
      `SELECT IDcommande_client, IDclient, numero FROM commande_client WHERE IDcommande_client = ${Number(exp[0]?.IDcommande_client ?? 0)}`)
    check('n° commande client', Number(cc[0]?.numero ?? 0), 2791)
    const cl = await query<any>(`SELECT IDclient, nom FROM client WHERE IDclient = ${Number(cc[0]?.IDclient ?? 0)}`)
    check('client', String((await fixEncoding(cl, 'client', 'IDclient', ['nom']))[0]?.nom ?? '').trim(), 'SAS LA FABRIQUE')
  }

  await closeConnection()
  console.log(problems === 0 ? '\n✓ all checks passed' : `\n✗ ${problems} problem(s)`)
  process.exit(problems === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
