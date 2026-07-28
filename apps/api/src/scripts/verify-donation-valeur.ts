// Verifies buildDonationValeurData against the legacy WinDev report output
// DON3693.pdf (commande numero 3693 = IDcommande_client 6903), piece by piece
// and line by line. Run after touching apps/api/src/lib/donation-valeur.ts:
//
//   npx tsx src/scripts/verify-donation-valeur.ts
//
// The one expected divergence is piece 2381/10: legacy adds 6,17 €/kg of
// "Coloration Simple Teinture" to a wash reference through a ref_fini_colori /
// colori_ecru id collision (see LEGACY_TEINTURE_COLLISION). Expectations below
// are written for the corrected behaviour; flipping that flag should make the
// LEGACY column match instead.
import 'dotenv/config'
import { buildDonationValeurData, roundEuro } from '../lib/donation-valeur.js'

const CMD = 6903

/** Legacy per-line figures, in print order: [label, detail, detail2, poids, prixKg, total]. */
type Exp = [string, string, string, number | null, number | null, number | null]

interface ExpPiece {
  numero: string
  refLabel: string
  poids: number
  prixKg: number | null
  total: number | null
  /** Legacy €/kg and valeur when they differ from ours (teinture collision). */
  legacyPrixKg?: number
  legacyTotal?: number
  lines: Exp[]
}

const EXPECTED: ExpPiece[] = [
  {
    numero: '988/10', refLabel: '003 - ecru', poids: 20.5, prixKg: null, total: null,
    lines: [
      ['167/48/1 PES FR - noir', 'Lot 8807', 'Commande fil N° 418', 15.58, 3.25, 50.64],
      ['83/36/1 PES - ecru', 'Lot 9318', 'Commande fil N° 109', 4.92, 1.85, 9.10],
      ['167/48/1 PES FR - ecru', '?', '?', null, null, null],
      ['Tricotage de la référence', 'Le', '', 20.50, 2.07, 42.44],
    ],
  },
  {
    numero: '988/11', refLabel: '003 - ecru', poids: 5, prixKg: null, total: null,
    lines: [
      ['167/48/1 PES FR - noir', 'Lot 8807', 'Commande fil N° 418', 3.80, 3.25, 12.35],
      ['83/36/1 PES - ecru', 'Lot 9318', 'Commande fil N° 109', 1.20, 1.85, 2.22],
      ['167/48/1 PES FR - ecru', '?', '?', null, null, null],
      ['Tricotage de la référence', 'Le', '', 5.00, 2.07, 10.35],
    ],
  },
  {
    numero: '2114/194', refLabel: '004B - Blanc pour imprimer', poids: 20.8187, prixKg: 14.56, total: 303.12,
    lines: [
      ['167/36/1 PES - ecru', 'Lot 9810', 'Commande fil N° 289', 18.99, 2.30, 43.68],
      ['44 ELASTHANNE - ecru', 'Lot 9811', 'Commande fil N° 290', 2.11, 11.50, 24.27],
      ['Tricotage de la référence', 'Le', '', 21.10, 2.30, 48.53],
      ['Blanchissement Simple Teinture', 'Le', '', 21.10, 5.35, 112.89],
      ['Rame', 'Le', '', 21.10, 0.00, 0.00],
      ['Ignifuge Polyester', 'Le', '', 21.10, 3.01, 63.51],
      ['Préfixation', 'Le', '', 21.10, 0.68, 14.35],
    ],
  },
  {
    numero: '2381/10', refLabel: '007A - ecru', poids: 15.3,
    // Corrected: no dye term on a wash reference. Legacy printed 17.38 / 265.85.
    // 171.45 = the exact Σ of the lines (legacy's 265.85 is that + the 6.17
    // €/kg collision term × 15.3 kg).
    prixKg: 11.21, total: 171.45, legacyPrixKg: 17.38, legacyTotal: 265.85,
    lines: [
      ['334/72/1 Pes mimat - ecru', 'Lot 9879', 'Commande fil N° 289', 9.49, 3.00, 28.46],
      ['83/36/1 PES - ecru', 'Lot 10023', 'Commande fil N° 387', 4.59, 1.90, 8.72],
      ['44 ELASTHANNE - ecru', 'Lot 10018', 'Commande fil N° 384', 1.22, 6.95, 8.51],
      ['Tricotage de la référence', 'Le', '', 15.30, 4.60, 70.38],
      ['Vaporisage', 'Le', '', 15.30, 0.00, 0.00],
      ['Calandrage Seul', 'Le', '', 15.30, 3.62, 55.39],
    ],
  },
]

/** Legacy document total (568.97) minus the collision-inflated piece, plus its
 *  corrected valeur. */
const EXPECTED_TOTAL = 474.57 // 303.117… + 171.4518… rounded once, like legacy
const LEGACY_TOTAL = 568.97

let failures = 0
function check(what: string, got: unknown, want: unknown) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}: got ${JSON.stringify(got)}${ok ? '' : ` want ${JSON.stringify(want)}`}`)
}
const r2 = (v: number | null) => (v === null ? null : roundEuro(v))
const r4 = (v: number | null) => (v === null ? null : Math.round(v * 10000) / 10000)

async function main() {
  const data = await buildDonationValeurData(CMD)
  if (!data) { console.error('no data'); process.exit(1) }
  console.log(`Donation N° ${data.numero} — ${data.clientNom} — ${data.pieces.length} pièces\n`)

  check('numero', data.numero, '3693')

  for (const exp of EXPECTED) {
    const p = data.pieces.find((x) => x.numero === exp.numero)
    console.log(`\n── Pièce ${exp.numero} (${exp.refLabel}) ──`)
    if (!p) { console.log(' FAIL  piece missing'); failures++; continue }
    check('refLabel starts with', p.refLabel.startsWith(exp.refLabel), true)
    check('poids', r4(p.poids), r4(exp.poids))
    check('€/kg', r2(p.prixKg), exp.prixKg)
    check('valeur', r2(p.total), exp.total)
    if (exp.legacyPrixKg !== undefined) {
      console.log(`  note  legacy printed ${exp.legacyPrixKg} €/kg → ${exp.legacyTotal} € (teinture collision)`)
    }
    check('nb lignes', p.lines.length, exp.lines.length)
    exp.lines.forEach((e, i) => {
      const l = p.lines[i]
      if (!l) { console.log(` FAIL  ligne ${i} missing`); failures++; return }
      check(`L${i} label`, l.label, e[0])
      check(`L${i} detail`, l.kind === 'operation' ? l.detail.slice(0, 2) : l.detail, e[1])
      check(`L${i} detail2`, l.detail2, e[2])
      check(`L${i} poids`, r2(l.poids), e[3])
      check(`L${i} €/kg`, r2(l.prixKg), e[4])
      check(`L${i} total`, r2(l.total), e[5])
    })
  }

  console.log('\n── Total ──')
  check('total valeur', data.totalValeur, EXPECTED_TOTAL)
  console.log(`  note  legacy document total was ${LEGACY_TOTAL} € (same minus the collision)`)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
