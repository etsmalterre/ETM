// Benchmark of the BL Ennoblisseur agent on the delivery documents already filed
// in ged (type 3), per dyer. Nothing is written: no HFSQL, no run stored, no
// file kept (traiterPdfs with `simulation`). Each document is compared with what
// was really received: the order it is filed on, and the métrage of the fini
// rolls of that order's lines carrying the same piece numbers.
//
//   node --env-file=.env --import tsx src/scripts/bench-bl-ennoblisseurs.ts --sst=38 [--n=40] [idged...]
//
// Costs the Mistral OCR + one small call per page (~0,0045 $).
import { query, queryRaw, closeConnection } from '../lib/hfsql-auto.js'
import { traiterPdfs, BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE, type ResultatBl } from '../lib/agents/bl-ennoblisseur.js'
import { lireEtat, versionActive } from '../lib/agents/store.js'

const opt = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d)
const sst = opt('sst', 38)
const n = opt('n', 40)
const ids = process.argv.slice(2).filter((a) => !a.startsWith('--')).map(Number).filter(Number.isFinite)

const cmds = (await query<{ c: number }>(`SELECT IDcommande_sous_traitant AS c FROM commande_sous_traitant WHERE IDsous_traitant = ${sst}`)).map((r) => Number(r.c))
const geds: Array<{ IDged: number; cmd: number; nom: string }> = []
if (ids.length) {
  for (const id of ids) {
    const [g] = await query<{ IDged: number; cmd: number; nom: string }>(`SELECT IDged, IDcommande_sous_traitant AS cmd, nom FROM ged WHERE IDged = ${id}`)
    if (g) geds.push(g)
  }
} else {
  for (let i = 0; i < cmds.length; i += 50) {
    geds.push(...await query<{ IDged: number; cmd: number; nom: string }>(
      `SELECT IDged, IDcommande_sous_traitant AS cmd, nom FROM ged WHERE IDtype_doc = 3 AND IDcommande_sous_traitant IN (${cmds.slice(i, i + 50).join(',')})`,
    ))
  }
  geds.sort((a, b) => Number(b.IDged) - Number(a.IDged))
  geds.splice(n)
}

const state = await lireEtat(BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE)
const version = versionActive(state)
const bilan: Record<string, number> = {}
let cout = 0
for (const g of geds) {
  const [row] = await queryRaw(`SELECT fichier FROM ged WHERE IDged = ${g.IDged}`)
  const f = (row as { fichier?: unknown } | undefined)?.fichier
  const buf = Buffer.isBuffer(f) ? f : f instanceof ArrayBuffer ? Buffer.from(f) : null
  if (!buf || buf.subarray(0, 4).toString() !== '%PDF') { console.log(`ged ${g.IDged} ${g.nom} — pas un PDF`); bilan.pas_pdf = (bilan.pas_pdf ?? 0) + 1; continue }
  const runs = await traiterPdfs([{ nom: String(g.nom), contenu: buf }], { mode: 'essai', version, source: 'essai_manuel', simulation: true })
  // What was received on the order: métrage per piece number.
  const lignes = (await query<{ l: number }>(`SELECT IDligne_commande_sous_traitant AS l FROM ligne_commande_sous_traitant WHERE IDcommande_sous_traitant = ${Number(g.cmd)}`)).map((r) => Number(r.l))
  const recu = new Map<string, number>()
  if (lignes.length) {
    for (const r of await query<{ numero: string; metrage: number }>(`SELECT numero, metrage FROM stock_fini WHERE IDref_commande_source IN (${lignes.join(',')})`)) {
      recu.set(String(r.numero).trim().replace(/-\d+$/, ''), Number(r.metrage))
    }
  }
  for (const r of runs) {
    cout += r.coutUsd
    const res = r.resultat as unknown as ResultatBl
    const e = res.extraction
    let verdict: string = r.statut
    if (e) {
      const bonneCommande = e.numero_commande === String(g.cmd)
      const connues = e.pieces.filter((p) => recu.has(p.composants[0]))
      const memeMetrage = connues.filter((p) => Math.abs((recu.get(p.composants[0]) ?? 0) - (p.metrage ?? -1)) < 0.051)
      verdict = `${r.statut}${bonneCommande ? '' : ` MAUVAISE_COMMANDE(${e.numero_commande}≠${g.cmd})`} · ${memeMetrage.length}/${connues.length}/${e.pieces.length} métrages = reçus/connus/lus`
      const k = !bonneCommande ? 'mauvaise_commande' : r.statut
      bilan[k] = (bilan[k] ?? 0) + 1
    } else bilan[r.statut] = (bilan[r.statut] ?? 0) + 1
    console.log(`ged ${g.IDged} ${g.nom} (cde ${g.cmd}) → ${res.profil ?? '—'}/${res.typeDocument ?? '—'} ${verdict} | ${r.resume}`)
    for (const c of res.controles ?? []) console.log(`    ${c.gravite}: ${c.message}`)
  }
}
console.log('\nBilan', bilan, `coût ${cout.toFixed(3)} $`)
await closeConnection()
process.exit(0)
