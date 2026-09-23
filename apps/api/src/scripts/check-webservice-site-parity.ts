/**
 * Parity of the website catalogue (lib/webservice-site.ts) against answers
 * saved from the legacy WinDev webservice MPS_WS (claude_doc/webservice_legacy.md).
 *
 *   node --import tsx src/scripts/check-webservice-site-parity.ts <oracleDir> [--prod-env <file>]
 *
 * <oracleDir> holds ref_interne/<IDref_fini>.json and ref_produit/<IDdesignation>_<IDclient>.json,
 * each `{ status, fetchedAt, body }` with the legacy body verbatim. The catalogue
 * is read from the database the connection string points at — pass the PROD
 * env file so both sides price the same data. The loader only SELECTs.
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const oracleDir = args.find((a) => !a.startsWith('--'))
if (!oracleDir) {
  console.error('usage: check-webservice-site-parity.ts <oracleDir> [--prod-env <file>]')
  process.exit(2)
}
const envIdx = args.indexOf('--prod-env')
if (envIdx >= 0) {
  const env = fs.readFileSync(args[envIdx + 1], 'utf8')
  const cs = env.match(/^HFSQL_CONNECTION_STRING=(.*)$/m)?.[1]?.trim()
  if (!cs) throw new Error('no HFSQL_CONNECTION_STRING in the env file')
  process.env.HFSQL_CONNECTION_STRING = cs
}

const { loadCatalog } = await import('../lib/webservice-site-data.js')
const { buildSite } = await import('../lib/webservice-site.js')
const { closeConnection } = await import('../lib/hfsql-auto.js')

type Tr = { nb_rouleau: number; qte_ml: number; prix: string }
type Col = { id_ref_coloris: number; Nom: string; tranche_tarifaire: Tr[] }

const t0 = Date.now()
const cat = await loadCatalog()
const t1 = Date.now()
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const site = buildSite(cat, { publicBaseUrl: 'https://alpha.etsmalterre.com', today })
const t2 = Date.now()
console.log(`catalogue loaded in ${t1 - t0} ms, built in ${t2 - t1} ms — ${site.refInterne.size} refs, ${site.refProduit.size} client products`)

const tally: Record<string, number> = {}
const samples: Record<string, string[]> = {}
function note(kind: string, detail: string): void {
  tally[kind] = (tally[kind] ?? 0) + 1
  const arr = (samples[kind] ??= [])
  if (arr.length < 6) arr.push(detail)
}

function compareHeader(where: string, L: Record<string, unknown>, N: Record<string, unknown>): void {
  for (const k of ['titre', 'reference', 'contexture', 'poids', 'CategoriePoids', 'laize', 'ref_client', 'associee']) {
    if (!(k in L)) continue
    if (String(L[k] ?? '') !== String(N[k] ?? '')) note(`header.${k}`, `${where}: legacy=${JSON.stringify(L[k])} new=${JSON.stringify(N[k])}`)
  }
  if (Math.abs(Number(L.longueur_rouleaux) - Number(N.longueur_rouleaux)) > 0.01) {
    note('header.longueur_rouleaux', `${where}: ${L.longueur_rouleaux} vs ${N.longueur_rouleaux}`)
  }
  const lv = JSON.stringify(((L.vertus as { Label: string }[] | null) ?? []).map((v) => v.Label).sort())
  const nv = JSON.stringify(((N.vertus as { Label: string }[] | null) ?? []).map((v) => v.Label).sort())
  if (lv !== nv) note('header.vertus', `${where}: ${lv} vs ${nv}`)
  // Legacy repeats a matière per yarn — compare the merged totals.
  const merge = (m: { label: string; proportion: number }[]) => {
    const t = new Map<string, number>()
    for (const x of m ?? []) t.set(x.label, (t.get(x.label) ?? 0) + Number(x.proportion))
    return [...t.entries()].map(([k, v]) => `${k}:${Math.round(v)}`).sort().join(',')
  }
  const lm = merge(L.matiere as never)
  const nm = merge(N.matiere as never)
  if (lm !== nm) note('header.matiere', `${where}: ${lm} | ${nm}`)
}

function compareColoris(where: string, Lc0: Col[] | null, Nc: Col[]): void {
  const Lc = Lc0 ?? []
  if (Lc0 === null) note('coloris.legacy_null', `${where}: new has ${Nc.length}`)
  const nById = new Map(Nc.map((c) => [c.id_ref_coloris, c]))
  const lIds = new Set(Lc.map((c) => c.id_ref_coloris))
  for (const c of Nc) if (!lIds.has(c.id_ref_coloris)) note('coloris.extra_in_new', `${where}: ${c.id_ref_coloris} ${c.Nom}`)
  for (const lc of Lc) {
    // An unpriced legacy coloris (expired contract) carries no tranche_tarifaire key at all.
    lc.tranche_tarifaire ??= []
    const nc = nById.get(lc.id_ref_coloris)
    if (!nc) { note('coloris.missing_in_new', `${where}: ${lc.id_ref_coloris} ${lc.Nom}`); continue }
    tally['coloris.compared'] = (tally['coloris.compared'] ?? 0) + 1
    if (lc.Nom.trim() !== nc.Nom.trim()) note('coloris.name', `${where}/${lc.id_ref_coloris}: ${JSON.stringify(lc.Nom)} vs ${JSON.stringify(nc.Nom)}`)
    const lk = lc.tranche_tarifaire.map((t) => t.nb_rouleau).join(',')
    const nk = nc.tranche_tarifaire.map((t) => t.nb_rouleau).join(',')
    if (lk !== nk) { note('tranches.set', `${where}/${lc.id_ref_coloris}: [${lk}] vs [${nk}]`); continue }
    let worst = 0
    let qteDiff = false
    for (let i = 0; i < lc.tranche_tarifaire.length; i++) {
      worst = Math.max(worst, Math.abs(Number(lc.tranche_tarifaire[i].prix) - Number(nc.tranche_tarifaire[i].prix)))
      if (lc.tranche_tarifaire[i].qte_ml !== nc.tranche_tarifaire[i].qte_ml) qteDiff = true
    }
    if (qteDiff) note('tranches.qte_ml', `${where}/${lc.id_ref_coloris}: ${lc.tranche_tarifaire.map((t) => t.qte_ml)} vs ${nc.tranche_tarifaire.map((t) => t.qte_ml)}`)
    const fmt = (c: Col) => c.tranche_tarifaire.map((t) => t.prix).join(' ')
    if (worst === 0) tally['prix.exact'] = (tally['prix.exact'] ?? 0) + 1
    else if (worst <= 0.011) note('prix.off_by_1_centime', `${where}/${lc.id_ref_coloris}: ${fmt(lc)} | ${fmt(nc)}`)
    else note('prix.different', `${where}/${lc.id_ref_coloris} (${lc.Nom}): ${fmt(lc)} | ${fmt(nc)}`)
  }
}

function readOracle(file: string): unknown | null {
  const o = JSON.parse(fs.readFileSync(file, 'utf8')) as { body: string }
  try { return JSON.parse(o.body) } catch { return null }
}

const riDir = path.join(oracleDir, 'ref_interne')
for (const f of fs.existsSync(riDir) ? fs.readdirSync(riDir) : []) {
  const id = parseInt(f, 10)
  const L = readOracle(path.join(riDir, f)) as { ref_produit: Record<string, unknown> } | null
  const N = site.refInterne.get(id)?.doc
  if (!L) { note(N ? 'ri.legacy_error_new_ok' : 'ri.both_error', `${id}`); continue }
  if (!N) { note('ri.missing_in_new', `${id}`); continue }
  tally['ri.compared'] = (tally['ri.compared'] ?? 0) + 1
  compareHeader(`RI ${id}`, L.ref_produit, N.ref_produit as never)
  compareColoris(`RI ${id}`, L.ref_produit.coloris as Col[], N.ref_produit.coloris as Col[])
}

const rpDir = path.join(oracleDir, 'ref_produit')
for (const f of fs.existsSync(rpDir) ? fs.readdirSync(rpDir) : []) {
  const [d] = f.replace('.json', '').split('_').map((x) => parseInt(x, 10))
  const L = readOracle(path.join(rpDir, f)) as { ref_produit: Record<string, unknown> } | null
  const N = site.refProduit.get(d)?.doc
  if (!L) { note(N ? 'rp.legacy_error_new_ok' : 'rp.both_error', `${f}`); continue }
  if (!N) { note('rp.missing_in_new', `${f}`); continue }
  tally['rp.compared'] = (tally['rp.compared'] ?? 0) + 1
  compareHeader(`RP ${f}`, L.ref_produit, N.ref_produit as never)
  compareColoris(`RP ${f}`, L.ref_produit.coloris as Col[], N.ref_produit.coloris as Col[])
}

console.log('\n── tally ──')
for (const [k, v] of Object.entries(tally).sort()) console.log(`${k.padEnd(28)} ${v}`)
for (const [k, arr] of Object.entries(samples)) {
  console.log(`\n── ${k} ──`)
  for (const s of arr) console.log('  ' + s)
}
await closeConnection()
