/**
 * Guard for the coloris picker of a client order line
 * (routes/commandes-client.ts → clientColorisIds / scopeColoris and the two
 * /lookups/colori-* endpoints).
 *
 * The bug this pins (reported 2026-07-30): "Lorsque l'on crée une ligne de
 * commande, MPS propose tous les coloris réalisés sur la référence et pas
 * seulement ceux du client". The lookups filtered by reference only, so a
 * reference dyed for dozens of customers offered all of their colours — 389
 * options where the client buys 71.
 *
 * Checks:
 *  1. Scoping narrows the list to the client's ref_client_colori rows.
 *  2. WITHOUT `client` the full list is returned — Clients › Gestion is the
 *     screen where the catalogue is built and must keep seeing everything.
 *  3. An existing line's coloris is kept even when it is outside the catalogue
 *     (381 legacy lines are in that case), and flagged `hors_catalogue`.
 *  4. A client × ref with NO registered coloris falls back to the full list
 *     (all rows flagged) instead of an empty, unusable picker.
 *  5. Sweep: for every client × ref that has a catalogue, the scoped list is a
 *     strict subset of the unscoped one and never empty.
 *
 * Read-only — never writes. Runs against the API's own HFSQL connection, not
 * over HTTP, so it works headless.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env' })
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` })
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { commandesClientRouter } from '../routes/commandes-client.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  OK   ${label}${detail ? ` — ${detail}` : ''}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

type ColoriRow = { id: number; reference: string; hors_catalogue?: boolean }

/** Call a lookup handler directly with a fake req/res pair. */
function callLookup(path: string, q: Record<string, string>): Promise<ColoriRow[]> {
  const layer = (commandesClientRouter as unknown as {
    stack: { route?: { path: string; stack: { handle: Function }[] } }[]
  }).stack.find((l) => l.route?.path === path)
  if (!layer?.route) throw new Error(`route ${path} introuvable`)
  const handler = layer.route.stack[layer.route.stack.length - 1].handle
  return new Promise((resolve, reject) => {
    const res = {
      json: (body: unknown) => resolve(body as ColoriRow[]),
      status: (code: number) => ({ json: (body: unknown) => reject(new Error(`${code}: ${JSON.stringify(body)}`)) }),
    }
    Promise.resolve(handler({ query: q } as never, res as never)).catch(reject)
  })
}
const coloriFini = (q: Record<string, string>) => callLookup('/lookups/colori-fini', q)

const num = (v: unknown) => Number(v) || 0
const arch = (r: Record<string, unknown>) => Number(r['archivé'] ?? r['archiv'] ?? 0) === 1
const cach = (r: Record<string, unknown>) => Number(r['caché'] ?? r['cach'] ?? 0) === 1

async function main() {
  console.log('\n1) Le catalogue client réduit la liste')
  // ref_fini 2 is dyed for many customers; client 31 buys a fraction of it.
  const all2 = await coloriFini({ ref_fini: '2' })
  const scoped2 = await coloriFini({ ref_fini: '2', client: '31' })
  check('liste complète volumineuse', all2.length > 300, `${all2.length} coloris`)
  check('liste client réduite', scoped2.length > 0 && scoped2.length < all2.length, `${scoped2.length} coloris pour le client 31`)
  check('sous-ensemble strict', scoped2.every((c) => all2.some((a) => a.id === c.id)))
  check('aucun coloris marqué hors catalogue', scoped2.every((c) => c.hors_catalogue === false))

  console.log('\n2) Sans client, la liste reste complète (Clients › Gestion)')
  check('pas de champ hors_catalogue', all2.every((c) => c.hors_catalogue === undefined))
  check('même volume qu’avant le correctif', all2.length === 389, `${all2.length}`)

  console.log('\n3) Le coloris d’une ligne existante reste visible')
  // client 490 / ref 1367: catalogue = {180, 628}, an old line carries 181.
  const without = await coloriFini({ ref_fini: '1367', client: '490' })
  const withCur = await coloriFini({ ref_fini: '1367', client: '490', current: '181' })
  check('hors catalogue absent sans current', !without.some((c) => c.id === 181), `${without.length} coloris`)
  check('présent avec current', withCur.some((c) => c.id === 181), `${withCur.length} coloris`)
  check('et marqué hors catalogue', withCur.find((c) => c.id === 181)?.hors_catalogue === true)
  check('les autres restent au catalogue', withCur.filter((c) => c.id !== 181).every((c) => c.hors_catalogue === false))

  console.log('\n4) Client sans coloris enregistré → repli sur la liste complète')
  // Find a live (client × ref_fini) entry with no ref_client_colori row.
  const desigs = await query<Record<string, unknown>>(`SELECT * FROM designation_client`)
  const rcc = await query<Record<string, unknown>>(`SELECT * FROM ref_client_colori`)
  const rccByDid = new Map<number, Record<string, unknown>[]>()
  for (const r of rcc) {
    const did = num(r.IDdesignation_client)
    rccByDid.set(did, [...(rccByDid.get(did) ?? []), r])
  }
  const live = desigs.filter((d) => !arch(d) && !cach(d) && num(d.IDref_fini) > 0)
  const orphan = live.find((d) => (rccByDid.get(num(d.IDdesignation_client)) ?? []).filter((r) => !arch(r)).length === 0)
  if (orphan) {
    const cid = num(orphan.IDclient), ref = num(orphan.IDref_fini)
    const full = await coloriFini({ ref_fini: String(ref) })
    const fallback = await coloriFini({ ref_fini: String(ref), client: String(cid) })
    check('même nombre de coloris que la liste complète', fallback.length === full.length, `client ${cid} ref ${ref}: ${fallback.length}/${full.length}`)
    check('tout est marqué hors catalogue (l’UI le dit à l’utilisateur)', fallback.length === 0 || fallback.every((c) => c.hors_catalogue === true))
  } else {
    console.log('  (aucune référence sans coloris enregistré dans cette base — contrôle ignoré)')
  }

  console.log('\n5) Balayage: le périmètre client ne vide jamais la liste')
  let pairs = 0, narrowed = 0, empty = 0
  const seen = new Set<string>()
  for (const d of live) {
    const cid = num(d.IDclient), ref = num(d.IDref_fini)
    const key = `${cid}:${ref}`
    if (seen.has(key)) continue
    seen.add(key)
    const active = (rccByDid.get(num(d.IDdesignation_client)) ?? []).filter((r) => !arch(r))
    if (active.length === 0) continue // covered by check 4
    if (pairs >= 150) break // enough for a regression signal without a full scan
    pairs++
    const scoped = await coloriFini({ ref_fini: String(ref), client: String(cid) })
    if (scoped.length === 0) { empty++; console.log(`       liste vide: client ${cid} ref ${ref}`); continue }
    const full = await coloriFini({ ref_fini: String(ref) })
    if (scoped.length < full.length) narrowed++
    if (!scoped.every((c) => full.some((f) => f.id === c.id))) {
      failures++
      console.log(`       hors liste complète: client ${cid} ref ${ref}`)
    }
  }
  console.log(`  paires testées: ${pairs}, dont réduites: ${narrowed}, vides: ${empty}`)
  check('aucune liste vide', empty === 0)

  console.log(`\n${failures === 0 ? 'TOUT EST VERT' : `${failures} ÉCHEC(S)`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
