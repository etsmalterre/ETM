// READ-ONLY probe #2 — follow-ups to probe-fil-incorpore-trm.ts.
//
//   A  Reconcile stock_fil.stock on the 32 incorporated lots:
//        attendu = stock_initial − Σ(pièces poids × pourcentage/100)   [freinte formula]
//      then ask whether the residual is the incorporated weight or zero.
//      → answers "is an incorporation ever deducted from the lot?"
//   B  For the 22 (OF, fil, coloris) groups served from two DIFFERENT lots:
//      how many lines does composition_ecru declare for that pair?
//        1 line  → the OF SPLIT one share across two lots  (régleur's case)
//        2 lines → two feeding positions that happened to draw two lots
//   C  The "fil absent de la composition" population, by year — a fil missing
//      from today's composition_ecru may just be composition drift on an old
//      OF. Recent OFs showing it is what makes it a deliberate variation.
//   D  What ARE the incorporated fils (élasthanne?), and are they already in
//      the OF's own composition?
import 'dotenv/config'
import { query } from '../lib/hfsql-auto.js'

const n = (v: unknown) => Number(v) || 0
const f = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

async function main() {
  const inc = await query<any>(
    `SELECT IDfil_incorpore, IDordre_fabrication, IDstock_fil, poids FROM fil_incorpore ORDER BY IDfil_incorpore`,
  )
  const lotIds = Array.from(new Set(inc.map((r) => n(r.IDstock_fil))))

  // ── A ───────────────────────────────────────────────────
  console.log('\n═══ A · réconciliation du stock des lots incorporés ═══')
  const lotRows = await query<any>(
    `SELECT IDstock_fil, stock, stock_initial, lot, IDref_fil, IDcolori_fil
       FROM stock_fil WHERE IDstock_fil IN (${lotIds.join(',')})`,
  )
  const termine = new Set(
    (await query<any>(
      `SELECT IDstock_fil FROM stock_fil WHERE IDstock_fil IN (${lotIds.join(',')}) AND terminé = 1`,
    )).map((r) => n(r.IDstock_fil)),
  )
  const asso = await query<any>(
    `SELECT IDstock_fil, IDordre_fabrication, pourcentage FROM asso_fil_of WHERE IDstock_fil IN (${lotIds.join(',')})`,
  )
  const ofIdsAll = Array.from(new Set(asso.map((a) => n(a.IDordre_fabrication)).filter((x) => x > 0)))
  const pieces = ofIdsAll.length
    ? await query<any>(
        `SELECT IDordre_fabrication, poids FROM stock_ecru WHERE IDordre_fabrication IN (${ofIdsAll.join(',')})`,
      )
    : []
  const poidsByOf = new Map<number, number>()
  for (const p of pieces) {
    const id = n(p.IDordre_fabrication)
    poidsByOf.set(id, (poidsByOf.get(id) ?? 0) + f(p.poids))
  }
  const consoByLot = new Map<number, number>()
  for (const a of asso) {
    const lot = n(a.IDstock_fil)
    const conso = ((poidsByOf.get(n(a.IDordre_fabrication)) ?? 0) * f(a.pourcentage)) / 100
    consoByLot.set(lot, (consoByLot.get(lot) ?? 0) + conso)
  }
  const incByLot = new Map<number, number>()
  for (const r of inc) {
    const id = n(r.IDstock_fil)
    incByLot.set(id, (incByLot.get(id) ?? 0) + f(r.poids))
  }

  console.log('lot        | initial |  stock  | conso tricot | attendu | résidu (stock-attendu) | incorp | terminé')
  let residZero = 0, residIsInc = 0, other = 0, openLots = 0
  for (const r of lotRows) {
    const id = n(r.IDstock_fil)
    if (termine.has(id)) continue // archivage forces stock = 0 → non concluant
    openLots++
    const init = f(r.stock_initial)
    const st = f(r.stock)
    const conso = consoByLot.get(id) ?? 0
    const attendu = init - conso
    const resid = st - attendu
    const incW = incByLot.get(id) ?? 0
    if (Math.abs(resid) < 0.5) residZero++
    else if (Math.abs(resid + incW) < 0.5) residIsInc++
    else other++
    console.log(
      `${String(r.lot ?? '').padEnd(10)} | ${init.toFixed(1).padStart(7)} | ${st.toFixed(1).padStart(7)} | ${conso.toFixed(1).padStart(12)} | ${attendu.toFixed(1).padStart(7)} | ${resid.toFixed(2).padStart(22)} | ${incW.toFixed(1).padStart(6)} | non`,
    )
  }
  console.log(`\nlots ouverts examinés : ${openLots}`)
  console.log(`  résidu ≈ 0 (incorporation NON déduite)      : ${residZero}`)
  console.log(`  résidu ≈ −poids incorporé (DÉDUITE)         : ${residIsInc}`)
  console.log(`  autre                                      : ${other}`)

  // ── B ───────────────────────────────────────────────────
  console.log('\n═══ B · les 2-lots : la réf déclare-t-elle 1 ou 2 lignes ? ═══')
  const assoAll = await query<any>(
    `SELECT IDordre_fabrication, IDref_fil, IDcolori_fil, IDstock_fil, pourcentage FROM asso_fil_of`,
  )
  const ofAll = await query<any>(
    `SELECT IDordre_fabrication, IDref_ecru, date_creation FROM ordre_fabrication`,
  )
  const refOfOf = new Map<number, number>()
  const dateOfOf = new Map<number, string>()
  for (const o of ofAll) {
    refOfOf.set(n(o.IDordre_fabrication), n(o.IDref_ecru))
    dateOfOf.set(n(o.IDordre_fabrication), String(o.date_creation ?? ''))
  }
  const compo = await query<any>(`SELECT IDref_ecru, IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru`)
  const compoLines = new Map<string, number[]>()
  for (const c of compo) {
    const k = `${n(c.IDref_ecru)}|${n(c.IDref_fil)}|${n(c.IDcolori_fil)}`
    const g = compoLines.get(k) ?? []
    g.push(f(c.pourcentage))
    compoLines.set(k, g)
  }
  const groups = new Map<string, any[]>()
  for (const a of assoAll) {
    const k = `${n(a.IDordre_fabrication)}|${n(a.IDref_fil)}|${n(a.IDcolori_fil)}`
    const g = groups.get(k) ?? []
    g.push(a)
    groups.set(k, g)
  }
  console.log('OF    | date     | fil/col  | lignes OF | % OF          | lignes réf | % réf')
  let split = 0, positions = 0
  for (const [k, g] of groups) {
    if (g.length < 2) continue
    if (new Set(g.map((a) => n(a.IDstock_fil))).size < 2) continue
    const [ofId, refFil, colFil] = k.split('|').map(Number)
    const ref = refOfOf.get(ofId) ?? 0
    const decl = compoLines.get(`${ref}|${refFil}|${colFil}`) ?? []
    if (decl.length === g.length) positions++
    else split++
    console.log(
      `${String(ofId).padEnd(5)} | ${String(dateOfOf.get(ofId) ?? '').padEnd(8)} | ${refFil}/${colFil}`.padEnd(34) +
      ` | ${String(g.length).padStart(9)} | ${g.map((a) => f(a.pourcentage)).join(' + ').padEnd(13)} | ${String(decl.length).padStart(10)} | ${decl.join(' + ')}`,
    )
  }
  console.log(`\n  autant de lignes que la réf (positions d'alimentation) : ${positions}`)
  console.log(`  PLUS de lignes que la réf (part éclatée sur 2 lots)    : ${split}`)

  // ── C ───────────────────────────────────────────────────
  console.log('\n═══ C · fil hors composition, par année de l’OF ═══')
  const compoPairs = new Map<number, Set<string>>()
  for (const c of compo) {
    const ref = n(c.IDref_ecru)
    if (!compoPairs.has(ref)) compoPairs.set(ref, new Set())
    compoPairs.get(ref)!.add(`${n(c.IDref_fil)}|${n(c.IDcolori_fil)}`)
  }
  const perYear = new Map<string, { extra: Set<number>; total: Set<number> }>()
  for (const o of ofAll) {
    const y = String(o.date_creation ?? '').slice(0, 4) || '????'
    if (!perYear.has(y)) perYear.set(y, { extra: new Set(), total: new Set() })
    perYear.get(y)!.total.add(n(o.IDordre_fabrication))
  }
  for (const a of assoAll) {
    const ofId = n(a.IDordre_fabrication)
    const ref = refOfOf.get(ofId) ?? 0
    const set = compoPairs.get(ref)
    if (ref > 0 && set && set.size > 0 && !set.has(`${n(a.IDref_fil)}|${n(a.IDcolori_fil)}`)) {
      const y = String(dateOfOf.get(ofId) ?? '').slice(0, 4) || '????'
      perYear.get(y)?.extra.add(ofId)
    }
  }
  for (const y of Array.from(perYear.keys()).sort()) {
    const v = perYear.get(y)!
    console.log(`  ${y} : ${String(v.extra.size).padStart(4)} OF sur ${String(v.total.size).padStart(4)}  (${((v.extra.size / Math.max(1, v.total.size)) * 100).toFixed(1)} %)`)
  }

  // ── D ───────────────────────────────────────────────────
  console.log('\n═══ D · quels fils sont incorporés, et sont-ils déjà dans l’OF ? ═══')
  const refFilIds = Array.from(new Set(lotRows.map((r) => n(r.IDref_fil)).filter((x) => x > 0)))
  const refFils = refFilIds.length
    ? await query<any>(`SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refFilIds.join(',')})`)
    : []
  const filLabel = new Map<number, string>()
  for (const r of refFils) filLabel.set(n(r.IDref_fil), String(r.reference ?? '').trim())
  const lotById = new Map<number, any>()
  for (const r of lotRows) lotById.set(n(r.IDstock_fil), r)
  const assoByOf = new Map<number, Set<string>>()
  for (const a of assoAll) {
    const id = n(a.IDordre_fabrication)
    if (!assoByOf.has(id)) assoByOf.set(id, new Set())
    assoByOf.get(id)!.add(`${n(a.IDref_fil)}|${n(a.IDcolori_fil)}`)
  }
  let alreadyIn = 0, extra = 0
  console.log('OF    | poids | lot        | fil incorporé                          | déjà tricoté dans cet OF ?')
  for (const r of inc) {
    const ofId = n(r.IDordre_fabrication)
    const lot = lotById.get(n(r.IDstock_fil))
    const pair = lot ? `${n(lot.IDref_fil)}|${n(lot.IDcolori_fil)}` : ''
    const inOf = assoByOf.get(ofId)?.has(pair) ?? false
    if (inOf) alreadyIn++; else extra++
    console.log(
      `${String(ofId).padEnd(5)} | ${f(r.poids).toFixed(0).padStart(5)} | ${String(lot?.lot ?? '—').padEnd(10)} | ${(filLabel.get(n(lot?.IDref_fil)) ?? '?').padEnd(38)} | ${inOf ? 'OUI (même fil que la composition)' : 'NON (fil en plus)'}`,
    )
  }
  console.log(`\n  incorporé déjà présent dans la composition de l’OF : ${alreadyIn}`)
  console.log(`  incorporé en PLUS de la composition                : ${extra}`)

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
