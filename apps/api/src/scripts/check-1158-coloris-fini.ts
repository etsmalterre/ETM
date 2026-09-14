// LIVA #1158 / #1157 guard — run against the dev base (`tsx --env-file=.env.development`).
//   1. A wash-only fini (avec_teinture = 0) must offer its écru's colori_ecru
//      rows as coloris, a dyed one its ref_fini_colori rows.
//   2. The bon de commande sous-traitant of an ennoblisseur order on a
//      wash-only fini must carry the coloris AND a composition even when
//      `ref_ecru.composition` is empty (derived from composition_ecru).
// Fixture: commande 7631 — MATEL, one line on 329D (ref_fini 1746, écru 329 =
// IDref_ecru 442, composition text empty), IDColoris 1551 « ecru/ecru ».
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { buildCommandePdfData, buildEcruLabel } from '../routes/commandes-sous-traitant.js'
import { formatCompositionLabel } from '../lib/composition-label.js'

let failures = 0
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'OK ' : 'KO '} ${msg}`); if (!ok) failures++ }

async function main() {
  // 1a. wash-only fini → colori_ecru of its écru
  const fini = await query<any>(`SELECT IDref_fini, avec_teinture, IDref_ecru FROM ref_fini WHERE IDref_fini = 1746`)
  check(fini.length === 1 && Number(fini[0].avec_teinture) === 0, '329D (1746) is wash-only in the fixture base')
  const ecruColoris = await query<any>(`SELECT IDcolori_ecru FROM colori_ecru WHERE IDref_ecru = ${Number(fini[0]?.IDref_ecru) || 0}`)
  const finiColoris = await query<any>(`SELECT IDref_fini_colori FROM ref_fini_colori WHERE IDref_fini = 1746`)
  check(ecruColoris.length > 0 && finiColoris.length === 0, `329D has ${ecruColoris.length} colori_ecru and ${finiColoris.length} ref_fini_colori — the old lookup returned []`)

  // 2. PDF data of commande 7631
  const data = await buildCommandePdfData(7631)
  check(!!data && data.lignes.length === 1, 'commande 7631 builds with one line')
  const l = data!.lignes[0]
  check(l.colori_reference === 'ecru/ecru', `line coloris resolves through colori_ecru: ${JSON.stringify(l.colori_reference)}`)
  check(!!l.ecru_label && /329/.test(l.ecru_label), `ecru_label names the écru: ${JSON.stringify(l.ecru_label)}`)
  check(!!l.ecru_label && /66 % 1\/60 COTON PEIGNE BIO Z · 34 % 1\/28 COTON PEIGNE BIO Z/.test(l.ecru_label), 'ecru_label carries the composition derived from composition_ecru')

  // 3. typed text wins over the derived label
  check(buildEcruLabel({ reference: 'X', designation: null, composition: '69 coton 31 PES' }, '66 % A · 34 % B') === 'X — écru — 69 coton 31 PES', 'typed composition text takes precedence')
  check(buildEcruLabel({ reference: 'X', designation: 'jersey', composition: '  ' }, '66 % A · 34 % B') === 'X — écru : jersey — 66 % A · 34 % B', 'blank text falls back to the derived label')
  check(formatCompositionLabel([], 0, () => undefined) === null, 'no rows → no composition part')

  await closeConnection()
  console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
