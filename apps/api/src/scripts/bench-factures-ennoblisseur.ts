// Benchmark of the Factures Ennoblisseur agent on the invoices the dyers already
// mailed to contact@ (LIVA #1255). Nothing is written: no row, no run stored,
// no file kept (traiterPdfs with `simulation`). Each invoice is compared with
// what Pierre-Emmanuel pointed by hand in the legacy: the order lines carrying
// this invoice number in `ligne_commande_sous_traitant.num_facture`.
//
//   node --env-file=.env.development --import tsx src/scripts/bench-factures-ennoblisseur.ts [--jours=200] [--n=10] [--details]
//
// Costs the Mistral OCR (~3 pages) + one small call per invoice (~0,015 $).
import { listerMessages, lireMessage, lirePieceJointe } from '../lib/gmail-reader.js'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'
import { traiterPdfs, FACTURES_SST_BOITE, FACTURES_SST_SLUG, FACTURES_SST_VERSION_INITIALE, type ResultatFacture } from '../lib/agents/factures-sst/agent.js'
import { estFactureCandidate } from '../lib/agents/factures-sst/extraction.js'
import { lireEtat, versionActive } from '../lib/agents/store.js'
import { closeConnection } from '../lib/hfsql-auto.js'

const opt = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d)
const jours = opt('jours', 200)
const n = opt('n', 10)
const details = process.argv.includes('--details')
const dump = process.argv.find((a) => a.startsWith('--dump='))?.split('=')[1] ?? ''
const seul = process.argv.find((a) => a.startsWith('--facture='))?.split('=')[1] ?? ''

const state = await lireEtat(FACTURES_SST_SLUG, FACTURES_SST_VERSION_INITIALE)
const version = versionActive(state)
const ids = await listerMessages(FACTURES_SST_BOITE, `from:mateltextiles.fr has:attachment filename:facture newer_than:${jours}d`, n)
const sql = mpsPg()
let cout = 0
const bilan: Record<string, number> = {}
for (const id of ids) {
  const m = await lireMessage(FACTURES_SST_BOITE, id)
  for (const p of m.piecesJointes.filter(estFactureCandidate)) {
    const buf = await lirePieceJointe(FACTURES_SST_BOITE, id, p.attachmentId)
    const [run] = await traiterPdfs([{ nom: p.nom, contenu: buf }], { mode: 'essai', version, source: 'essai_manuel', simulation: true })
    cout += run.coutUsd
    const res = run.resultat as unknown as ResultatFacture
    if (seul && res.extraction?.numero_facture !== seul) continue
    if (dump) {
      const fs = await import('node:fs')
      fs.mkdirSync(dump, { recursive: true })
      fs.writeFileSync(`${dump}/${res.extraction?.numero_facture || id}.ocr.md`, res.pages[0]?.ocr ?? '')
      fs.writeFileSync(`${dump}/${res.extraction?.numero_facture || id}.json`, JSON.stringify(res.extraction, null, 1))
    }
    const v = res.verification
    const num = res.extraction?.numero_facture ?? ''
    // Pierre-Emmanuel's pointing: order lines carrying this invoice number.
    const pointees = num
      ? (await sql<{ id: number }[]>`SELECT idligne_commande_sous_traitant AS id FROM ligne_commande_sous_traitant WHERE num_facture = ${num}`).map((r) => Number(r.id))
      : []
    const rattachees = new Set((v?.lignes ?? []).map((l) => l.etm?.idligne ?? 0).filter((x) => x > 0))
    const communes = pointees.filter((x) => rattachees.has(x)).length
    const lecture = v?.controles.filter((c) => c.gravite === 'bloquant') ?? []
    bilan[res.statutFacture ?? run.statut] = (bilan[res.statutFacture ?? run.statut] ?? 0) + 1
    console.log(`\n${m.date.slice(0, 10)} ${num || p.nom} — ${run.resume}`)
    console.log(`   lecture ${lecture.length ? `KO: ${lecture.map((c) => c.message).join(' | ')}` : 'OK'} · lignes de commande rattachées ${rattachees.size}, pointées par Pierre-Emmanuel ${pointees.length}, en commun ${communes}`)
    for (const l of v?.lignes ?? []) {
      if (!details && (l.verdict === 'conforme' || l.verdict === 'info')) continue
      const msg = l.controles.map((c) => c.message).join(' | ')
      console.log(`   ${l.verdict.padEnd(13)} ${(l.lotEtm || l.ligne.description).padEnd(22)} ${String(l.ligne.quantite ?? '').padStart(8)} ${l.ligne.unite.padEnd(3)} ${String(l.ligne.prix_unitaire ?? '').padStart(6)} attendu ${l.etm?.prixAttendu ?? '—'} poids ETM ${l.etm?.poids ?? '—'} ${msg}`)
    }
  }
}
console.log(`\nBilan: ${JSON.stringify(bilan)} · coût ${cout.toFixed(3)} $`)
await closeMpsPg()
await closeConnection()
process.exit(0)
