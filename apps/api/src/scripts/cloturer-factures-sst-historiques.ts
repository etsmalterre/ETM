// One-off (2026-10-05, Vincent): closes the dyer invoices picked up by the
// 365-day backfill (backfill-factures-sst.ts) up to a date as « Validée malgré
// les écarts » — they were paid long ago, nobody reviews them now.
//
//   node --env-file=.env --import tsx src/scripts/cloturer-factures-sst-historiques.ts [--jusqua=2026-07-31]          # lists
//   node --env-file=.env --import tsx src/scripts/cloturer-factures-sst-historiques.ts [--jusqua=2026-07-31] --write  # closes
//
// Same close as PUT /factures-sst/:id/traitement « validee » (final verdict
// on every undecided line, invoice closed, history row) EXCEPT the Tricobot
// score: no line gets avis « réussite », because nobody checked them — the
// agent's precision stays measured on invoices a person actually reviewed.
// Only invoices still open (traite_le IS NULL); idempotent.
import '../load-env.js'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'
import { parDefaut } from '../lib/agents/factures-sst/avis.js'
import { noter } from '../lib/agents/factures-sst/historique.js'
import type { Nature, Verdict } from '../lib/agents/factures-sst/controle.js'

const write = process.argv.includes('--write')
const jusqua = process.argv.find((a) => a.startsWith('--jusqua='))?.split('=')[1] ?? '2026-07-31'
if (!/^\d{4}-\d{2}-\d{2}$/.test(jusqua)) throw new Error(`--jusqua invalide : ${jusqua}`)
const PAR = { id: 1, nom: 'Vincent Malterre' }
const COMMENTAIRE = `Facture antérieure au ${jusqua.split('-').reverse().join('/')}, reprise de l’historique : réglée, non revue.`

const sql = mpsPg()
const factures = await sql<{ id: number; numero: string; date_facture: Date; controles: Array<{ gravite: string }> | null }[]>`
  SELECT idfacture_sst AS id, numero, date_facture, controles FROM facture_sst
  WHERE traite_le IS NULL AND date_facture <= ${jusqua}::date ORDER BY date_facture, idfacture_sst`
console.log(`${factures.length} open invoice(s) dated up to ${jusqua}`)
for (const f of factures) {
  const lignes = await sql<{ id: number; verdict: Verdict; nature: Nature | null; verdict_final: string | null }[]>`
    SELECT idligne_facture_sst AS id, verdict, nature, verdict_final FROM ligne_facture_sst WHERE idfacture_sst = ${f.id}`
  let ecarts = (f.controles ?? []).some((c) => c.gravite === 'bloquant') ? 1 : 0
  const defauts: Array<{ id: number; verdictFinal: string }> = []
  for (const l of lignes) {
    if (l.verdict_final) { if (l.verdict_final === 'ecart') ecarts++; continue }
    const d = parDefaut(l.verdict, l.nature)
    if (d === 'sans_objet') continue
    defauts.push({ id: Number(l.id), verdictFinal: d.verdictFinal })
    if (d.verdictFinal === 'ecart') ecarts++
  }
  console.log(`  ${f.numero.padEnd(12)} ${f.date_facture.toISOString().slice(0, 10)}  ${ecarts} écart(s)`)
  if (!write) continue
  const resume = `Validée${ecarts > 0 ? ` malgré ${ecarts} écart${ecarts > 1 ? 's' : ''}` : ''} — ${COMMENTAIRE}`
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql
    for (const d of defauts) {
      await tx`UPDATE ligne_facture_sst SET verdict_final = ${d.verdictFinal} WHERE idligne_facture_sst = ${d.id} AND verdict_final IS NULL`
    }
    await tx`UPDATE facture_sst SET traitement = 'validee', traite_le = now(), traite_par = ${PAR.id}, traite_par_nom = ${PAR.nom},
                    traite_commentaire = ${COMMENTAIRE}
             WHERE idfacture_sst = ${f.id} AND traite_le IS NULL`
    await noter(tx, { idFacture: f.id, type: 'validee', par: PAR, resume })
  })
}
console.log(write ? 'Done.' : 'Dry run — re-run with --write to close them.')
await closeMpsPg()
process.exit(0)
