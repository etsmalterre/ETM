// Probe the "search commandes by article reference" two-step query against
// the live DB. Usage: tsx src/scripts/probe-commande-ref-search.ts 040A
import { query } from '../lib/hfsql-auto.js'

async function main() {
  const q = process.argv[2] ?? '040A'
  const e = q.replace(/'/g, "''")
  const [fini, ecru, divers] = await Promise.all([
    query<any>(`SELECT TOP 500 IDref_fini, reference FROM ref_fini WHERE reference LIKE '%${e}%'`),
    query<any>(`SELECT TOP 500 IDref_ecru, reference FROM ref_ecru WHERE reference LIKE '%${e}%'`),
    query<any>(`SELECT TOP 500 IDref_divers, designation FROM ref_divers WHERE designation LIKE '%${e}%'`),
  ])
  console.log(`q=${q} → ref_fini ${fini.length}, ref_ecru ${ecru.length}, ref_divers ${divers.length}`)
  console.log('  fini:', fini.slice(0, 8).map((r: any) => `${r.IDref_fini}:${r.reference}`).join(' | '))
  console.log('  ecru:', ecru.slice(0, 8).map((r: any) => `${r.IDref_ecru}:${r.reference}`).join(' | '))
  console.log('  divers:', divers.slice(0, 8).map((r: any) => `${r.IDref_divers}:${r.designation}`).join(' | '))

  const orParts: string[] = []
  if (fini.length) orParts.push(`(TYPE = 2 AND IDreference IN (${fini.map((r: any) => r.IDref_fini).join(',')}))`)
  if (ecru.length) orParts.push(`(TYPE = 1 AND IDreference IN (${ecru.map((r: any) => r.IDref_ecru).join(',')}))`)
  if (divers.length) orParts.push(`(TYPE = 3 AND IDreference IN (${divers.map((r: any) => r.IDref_divers).join(',')}))`)
  if (orParts.length === 0) { console.log('no catalog match'); return }

  const lignes = await query<any>(
    `SELECT IDcommande_client FROM ligne_commande_client WHERE ${orParts.join(' OR ')}`,
  )
  const ids = Array.from(new Set(lignes.map((l: any) => Number(l.IDcommande_client)).filter(Boolean))).sort((a, b) => b - a)
  console.log(`  lignes ${lignes.length} → ${ids.length} commandes, latest:`, ids.slice(0, 10).join(', '))
  if (ids.length > 0) {
    const cmds = await query<any>(
      `SELECT IDcommande_client, numero, est_soldee FROM commande_client WHERE IDcommande_client IN (${ids.slice(0, 10).join(',')})`,
    )
    for (const c of cmds) console.log(`    #${c.IDcommande_client} numero=${c.numero} soldee=${c.est_soldee}`)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
