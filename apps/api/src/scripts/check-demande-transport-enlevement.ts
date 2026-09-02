/**
 * Guard for ticket #1111 — the demande de transport's "Enlèvement chez" block
 * must name the magasin the rolls actually sit in, not unconditionally the
 * company (goods dyed at MATEL ship straight from MATEL).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-demande-transport-enlevement.ts
 *
 * Pins, on the dev copy:
 *  - expedition 11899 (cmd 3710, EMPREINTE): both rolls at MATEL → pickup at
 *    MATEL, Roanne;
 *  - expedition 11887 (cmd 3734, POTENCIER): rolls at magasin 0 → pickup at
 *    Ets Malterre (the pre-#1111 behaviour, still right when goods are home);
 *  - any expedition whose rolls span several magasins → refused with
 *    `magasins_multiples` (one sheet has one pickup block). Found dynamically
 *    since no specific id is worth pinning.
 * Read-only.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { buildDemandeTransportPdfData } from '../routes/expeditions.js'

const EXP_MATEL = 11899
const EXP_HOME = 11887

async function main() {
  let problems = 0
  const check = (label: string, ok: boolean, got?: unknown) => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (got ${JSON.stringify(got)})`}`)
    if (!ok) problems++
  }

  console.log(`expedition ${EXP_MATEL} — rolls at MATEL`)
  const matel = await buildDemandeTransportPdfData([EXP_MATEL], undefined)
  if ('err' in matel) {
    check('builds', false, matel.err)
  } else {
    const e = matel.data.enlevement
    check('enlèvement nom names MATEL', /MATEL/i.test(e.nom ?? ''), e.nom)
    check('enlèvement ville is Roanne', /ROANNE/i.test(e.ville ?? ''), e.ville)
  }

  console.log(`expedition ${EXP_HOME} — rolls at Ets Malterre (magasin 0)`)
  const home = await buildDemandeTransportPdfData([EXP_HOME], undefined)
  if ('err' in home) {
    check('builds', false, home.err)
  } else {
    const e = home.data.enlevement
    check('enlèvement nom is the company', /MALTERRE/i.test(e.nom ?? ''), e.nom)
    check('enlèvement ville is Moreuil', /MOREUIL/i.test(e.ville ?? ''), e.ville)
  }

  // Find one mixed-magasin expedition (24 exist in the dev copy) and make
  // sure the builder refuses it instead of guessing a pickup point.
  console.log('mixed-magasin expedition — must refuse')
  const lines = await query<any>(`SELECT IDligne_expedition, IDexpedition FROM ligne_expedition`)
  const leToExp = new Map<number, number>(lines.map((l: any) => [Number(l.IDligne_expedition), Number(l.IDexpedition)]))
  const heads = await query<any>(`SELECT IDexpedition FROM expedition WHERE IDsociete = 1`)
  const etm = new Set(heads.map((h: any) => Number(h.IDexpedition)))
  const [fini, ecru] = await Promise.all([
    query<any>(`SELECT IDstock_fini, IDligne_expedition, IDmagasin FROM stock_fini WHERE IDligne_expedition > 0`),
    query<any>(`SELECT IDstock_ecru, IDligne_expedition_ETM, IDmagasin FROM stock_ecru WHERE IDligne_expedition_ETM > 0`),
  ])
  const magsByExp = new Map<number, Set<number>>()
  const add = (le: number, mag: number) => {
    const exp = leToExp.get(le)
    if (!exp || !etm.has(exp)) return
    if (!magsByExp.has(exp)) magsByExp.set(exp, new Set())
    magsByExp.get(exp)!.add(mag)
  }
  for (const r of fini) add(Number(r.IDligne_expedition), Number(r.IDmagasin) || 0)
  for (const r of ecru) add(Number(r.IDligne_expedition_ETM), Number(r.IDmagasin) || 0)
  const mixedExp = [...magsByExp.entries()].find(([, m]) => m.size > 1)?.[0]
  if (mixedExp === undefined) {
    console.log('  (no mixed expedition in this copy — skipped)')
  } else {
    const mixed = await buildDemandeTransportPdfData([mixedExp], undefined)
    check(
      `exp ${mixedExp} refused with magasins_multiples`,
      'err' in mixed && mixed.err.error === 'magasins_multiples',
      'err' in mixed ? mixed.err : mixed.data.enlevement,
    )
  }

  console.log(problems === 0 ? '\nOK' : `\n${problems} problem(s)`)
  if (problems > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => closeConnection())
