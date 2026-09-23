// Dry run of the BL Ennoblisseur agent on BLs already stored in ged (mode essai: no
// HFSQL write, no mail). Usage: npx tsx src/scripts/essai-agent-bl.ts [--n=5] [--skip=0] [idged...]
// Runs land in data/agents/runs-bl-ennoblisseur.json like any manual test.
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` })
dotenv.config({ path: '.env' })
import { query, queryRaw, closeConnection } from '../lib/hfsql-auto.js'
import { traiterPdfs, BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE } from '../lib/agents/bl-ennoblisseur.js'
import { lireEtat, versionActive } from '../lib/agents/store.js'
import { MATEL_IDSOUS_TRAITANT } from '../lib/pricing-sst.js'

async function main() {
  const opt = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d)
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--')).map(Number).filter(Number.isFinite)
  const n = opt('n', 5)
  const skip = opt('skip', 0)
  const ids = args.length ? args : (await query<{ IDged: number }>(
    `SELECT TOP ${n + skip} g.IDged AS IDged FROM ged g, commande_sous_traitant c
     WHERE g.IDcommande_sous_traitant = c.IDcommande_sous_traitant AND c.IDsous_traitant = ${MATEL_IDSOUS_TRAITANT} AND g.IDtype_doc = 3
     ORDER BY g.IDged DESC`)).map((r) => Number(r.IDged)).slice(skip)
  const state = await lireEtat(BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE)
  for (const id of ids) {
    const rows = await queryRaw(`SELECT fichier FROM ged WHERE IDged = ${id}`)
    const f = rows[0]?.fichier
    const buf = Buffer.isBuffer(f) ? f : f instanceof ArrayBuffer ? Buffer.from(f) : null
    if (!buf || buf.subarray(0, 4).toString() !== '%PDF') { console.log(id, 'no PDF'); continue }
    const runs = await traiterPdfs([{ nom: `ged-${id}.pdf`, contenu: buf }], { mode: 'essai', version: versionActive(state), source: 'essai_manuel' })
    for (const r of runs) {
      const res = r.resultat as any
      console.log(`ged ${id} → ${r.statut} | ${r.resume} | ligne ${res.resolution?.ligneId ?? '-'} | ${(r.coutUsd * 1000).toFixed(2)} m$ | ${r.dureeMs} ms`)
      for (const c of res.controles ?? []) console.log(`   ${c.gravite}: ${c.message}`)
    }
  }
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
