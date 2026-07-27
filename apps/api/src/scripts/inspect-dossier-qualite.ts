import { query } from '../lib/hfsql-auto.js'

const TABLES = [
  'dossier_qualite',
  'defaut_qualite',
  'action_qualite',
  'resolution_qualite',
  'mention_qualite',
  'doc_qualite',
  'conformite_action',
  'asso_lot_dq',
  'categorie_defaut',
  'cause_defaut',
  'defaut_textile',
]

async function main() {
  for (const t of TABLES) {
    console.log(`\n\n########## ${t} ##########`)
    try {
      const c = await query(`SELECT COUNT(*) AS n FROM ${t}`) as any[]
      console.log('count:', JSON.stringify(c[0]))
    } catch (e) { console.log('count err:', (e as Error).message.slice(0, 160)) }
    try {
      const r = await query(`SELECT TOP 3 * FROM ${t}`) as any[]
      if (r.length > 0) console.log('keys:', JSON.stringify(Object.keys(r[0])))
      for (const row of r) {
        const o: any = {}
        for (const [k, v] of Object.entries(row)) {
          o[k] = Buffer.isBuffer(v) ? `<buf ${(v as Buffer).length}>` : (typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v)
        }
        console.log(JSON.stringify(o))
      }
    } catch (e) { console.log('sel err:', (e as Error).message.slice(0, 200)) }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
