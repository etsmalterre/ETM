/**
 * Probe for ticket #1111 — « Adresse d'enlèvement incorrecte ».
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/probe-1111-enlevement.ts
 *
 * Finds recent ETM expeditions whose attached rolls sit in a magasin ≠ 0
 * (e.g. MATEL), i.e. the cases where the demande d'enlèvement should NOT
 * print the Ets Malterre address. Read-only.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'

async function main() {
  // Recent formelle expeditions (société 1), newest first.
  const heads = await query<any>(
    `SELECT TOP 60 IDexpedition, IDcommande_client, DATE AS dexp
     FROM expedition WHERE IDsociete = 1 ORDER BY IDexpedition DESC`,
  )
  const expIds = heads.map((h: any) => Number(h.IDexpedition))
  if (expIds.length === 0) { console.log('no expeditions'); return }

  const lines = await query<any>(
    `SELECT IDligne_expedition, IDexpedition FROM ligne_expedition
     WHERE IDexpedition IN (${expIds.join(',')})`,
  )
  const leToExp = new Map<number, number>(
    lines.map((l: any) => [Number(l.IDligne_expedition), Number(l.IDexpedition)]),
  )
  const leIds = [...leToExp.keys()]
  if (leIds.length === 0) { console.log('no lines'); return }

  const [fini, ecru] = await Promise.all([
    query<any>(
      `SELECT IDstock_fini, IDligne_expedition, IDmagasin, numero FROM stock_fini
       WHERE IDligne_expedition IN (${leIds.join(',')})`,
    ),
    query<any>(
      `SELECT IDstock_ecru, IDligne_expedition_ETM, IDmagasin, numero FROM stock_ecru
       WHERE IDligne_expedition_ETM IN (${leIds.join(',')})`,
    ),
  ])

  // magasin ids → sous_traitant names
  const sst = await query<any>(`SELECT IDsous_traitant, nom FROM sous_traitant`)
  const sstName = new Map<number, string>(
    sst.map((s: any) => [Number(s.IDsous_traitant), String(s.nom)]),
  )
  const magLabel = (id: number) => (id === 0 ? 'Ets Malterre' : sstName.get(id) || `sst #${id}`)

  // Per expedition: the set of magasins its rolls sit in.
  type Roll = { exp: number; magasin: number; numero: string; kind: string }
  const rolls: Roll[] = []
  for (const r of fini) {
    const exp = leToExp.get(Number(r.IDligne_expedition))
    if (exp) rolls.push({ exp, magasin: Number(r.IDmagasin) || 0, numero: String(r.numero), kind: 'fini' })
  }
  for (const r of ecru) {
    const exp = leToExp.get(Number(r.IDligne_expedition_ETM))
    if (exp) rolls.push({ exp, magasin: Number(r.IDmagasin) || 0, numero: String(r.numero), kind: 'ecru' })
  }

  const byExp = new Map<number, Roll[]>()
  for (const r of rolls) {
    if (!byExp.has(r.exp)) byExp.set(r.exp, [])
    byExp.get(r.exp)!.push(r)
  }

  // Client names for context.
  const cmdIds = [...new Set(heads.map((h: any) => Number(h.IDcommande_client) || 0).filter((x: number) => x > 0))]
  const cmds = cmdIds.length
    ? await query<any>(`SELECT IDcommande_client, numero, IDclient FROM commande_client WHERE IDcommande_client IN (${cmdIds.join(',')})`)
    : []
  const cmdMap = new Map<number, { numero: number; IDclient: number }>(
    cmds.map((c: any) => [Number(c.IDcommande_client), { numero: Number(c.numero), IDclient: Number(c.IDclient) }]),
  )
  const cliIds = [...new Set(cmds.map((c: any) => Number(c.IDclient)))]
  const clis = cliIds.length
    ? await query<any>(`SELECT IDclient, nom FROM client WHERE IDclient IN (${cliIds.join(',')})`)
    : []
  const cliName = new Map<number, string>(clis.map((c: any) => [Number(c.IDclient), String(c.nom)]))

  console.log('Recent ETM expeditions and where their rolls sit:\n')
  for (const h of heads) {
    const exp = Number(h.IDexpedition)
    const rs = byExp.get(exp)
    if (!rs || rs.length === 0) continue
    const mags = [...new Set(rs.map((r) => r.magasin))]
    const cmd = cmdMap.get(Number(h.IDcommande_client) || 0)
    const cli = cmd ? cliName.get(cmd.IDclient) || `client #${cmd.IDclient}` : '—'
    const flag = mags.some((m) => m !== 0) ? '  ⚠ ROLLS NOT AT ETS MALTERRE' : ''
    console.log(
      `exp ${exp}  date ${h.dexp}  cmd ${cmd?.numero ?? '—'}  ${cli}  ` +
        `rouleaux ${rs.length} @ [${mags.map(magLabel).join(', ')}]${flag}`,
    )
    if (flag) {
      for (const r of rs.slice(0, 5)) console.log(`    ${r.kind} ${r.numero} @ ${magLabel(r.magasin)}`)
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => closeConnection())
