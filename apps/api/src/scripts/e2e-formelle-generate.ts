// End-to-end exercise of the FORMELLE pass of POST /factures/prov/generate on
// the DEV database (LIVA #1117): snapshot → generate → assert the split by
// delivery address → roll back via the app's own delete-batch.
//
// Asserts, on whatever un-invoiced avis the dev copy holds:
//   - no proforma carries lines from avis shipped to two different addresses
//   - a client whose avis went to N addresses (× M billing addresses) gets
//     exactly N × M proformas, each flagged with its `adresse_livraison`
//   - each proforma's IDadresse is the commande's IDadresse_facturation
//     (client default only when the commande carries none)
//   - the rollback reopens every expedition it had marked
//
// Run:  node scripts/worktree/status.mjs      # find your slot's API port
//       E2E_BASE=http://localhost:8083/api E2E_USER=1 npx tsx src/scripts/e2e-formelle-generate.ts
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
import { query } from '../lib/hfsql-auto.js'
import { signUserId } from '../lib/auth.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:8080/api'
function n(v: unknown): number { return Number(v) || 0 }

async function main() {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(BASE)) {
    console.error(`Refus: E2E_BASE doit viser localhost (reçu "${BASE}"). Ce script écrit en base.`)
    process.exit(1)
  }
  const signed = signUserId(Number(process.env.E2E_USER ?? 1))
  const cookie = `mps_uid=${signed}; mps_uid_admin=${signed}`

  const before = (await query<any>(`SELECT IDfacture_prov FROM facture_prov WHERE IDsociete = 1`)).length
  const openBefore = (await query<any>(
    `SELECT IDexpedition FROM expedition WHERE IDsociete = 1 AND (est_facture IS NULL OR est_facture = 0)`,
  )).map((r: any) => n(r.IDexpedition))
  console.log(`before: ${before} proforma(s), ${openBefore.length} avis formels ouverts`)

  const res = await fetch(`${BASE}/factures/prov/generate`, { method: 'POST', headers: { cookie } })
  const body = await res.json() as any
  console.log(`POST /prov/generate → ${res.status}`)
  if (!res.ok) { console.log(JSON.stringify(body, null, 2)); process.exit(1) }
  const created: any[] = (body.created ?? []).filter((c: any) => !c.divers)
  const createdIds: number[] = (body.created ?? []).map((c: any) => n(c.id))

  let failures = 0
  const check = (ok: boolean, label: string) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++ }

  // Per proforma: the avis behind its lines, their delivery + billing addresses.
  const perClient = new Map<number, Array<{ id: number; livr: Set<number>; fact: Set<number>; head: number; label: string | null }>>()
  for (const c of created) {
    const id = n(c.id)
    const head = (await query<any>(`SELECT IDclient, IDadresse FROM facture_prov WHERE IDfacture_prov = ${id}`))[0]
    const lignes = await query<any>(`SELECT IDligne_expedition FROM ligne_facture_prov WHERE IDfacture_prov = ${id} AND IDligne_expedition > 0`)
    const leIds = Array.from(new Set(lignes.map((l: any) => n(l.IDligne_expedition))))
    const exps = leIds.length
      ? await query<any>(`SELECT DISTINCT e.IDexpedition, e.IDadresse, e.IDcommande_client FROM ligne_expedition le JOIN expedition e ON e.IDexpedition = le.IDexpedition WHERE le.IDligne_expedition IN (${leIds.join(',')})`)
      : []
    const livr = new Set<number>(exps.map((e: any) => n(e.IDadresse)))
    const fact = new Set<number>()
    for (const e of exps as any[]) {
      const cmd = (await query<any>(`SELECT IDadresse_facturation FROM commande_client WHERE IDcommande_client = ${n(e.IDcommande_client)}`))[0]
      fact.add(n(cmd?.IDadresse_facturation))
    }
    const entry = { id, livr, fact, head: n(head?.IDadresse), label: c.adresse_livraison ?? null }
    const arr = perClient.get(n(head?.IDclient)) ?? []
    arr.push(entry)
    perClient.set(n(head?.IDclient), arr)
    console.log(`  proforma ${id} client ${head?.IDclient} → livr {${[...livr].join(',')}} fact {${[...fact].join(',')}} IDadresse ${entry.head} ${entry.label ? `« ${entry.label} »` : ''}`)
  }

  check(created.length > 0, `${created.length} proforma(s) formel(s) créé(s)`)
  check(created.every((c) => perClient.get(0) === undefined), 'chaque proforma a un client')
  let mixed = 0, badHead = 0, split = 0, splitOk = 0, labelOk = 0, labelBad = 0
  for (const [, arr] of perClient) {
    for (const p of arr) {
      if (p.livr.size > 1) mixed++
      const expectedHead = [...p.fact][0]
      if (p.fact.size === 1 && expectedHead > 0 && p.head !== expectedHead) badHead++
    }
    if (arr.length > 1) {
      split++
      const distinct = new Set(arr.map((p) => `${[...p.fact][0]}|${[...p.livr][0]}`))
      if (distinct.size === arr.length) splitOk++
      for (const p of arr) { if (p.label) labelOk++; else labelBad++ }
    } else if (arr[0].label) labelBad++
  }
  check(mixed === 0, 'aucun proforma ne mêle deux adresses de livraison')
  check(badHead === 0, "l'IDadresse du proforma est l'adresse de facturation de la commande")
  check(split > 0 && splitOk === split, `${split} client(s) réparti(s) sur plusieurs proformas, un par (facturation × livraison)`)
  check(labelBad === 0 && labelOk > 0, `adresse_livraison renseignée sur les ${labelOk} proformas du découpage, et seulement là`)

  // --- roll back ------------------------------------------------------
  if (createdIds.length > 0) {
    const del = await fetch(`${BASE}/factures/prov/delete-batch`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ids: createdIds }),
    })
    console.log(`\nrollback DELETE-batch → ${del.status} ${JSON.stringify(await del.json())}`)
  }
  const after = (await query<any>(`SELECT IDfacture_prov FROM facture_prov WHERE IDsociete = 1`)).length
  const openAfter = (await query<any>(
    `SELECT IDexpedition FROM expedition WHERE IDsociete = 1 AND (est_facture IS NULL OR est_facture = 0)`,
  )).map((r: any) => n(r.IDexpedition))
  const restored = after === before && openAfter.length === openBefore.length && openBefore.every((id) => openAfter.includes(id))
  console.log(`after rollback: ${after} proforma(s) (attendu ${before}), ${openAfter.length} avis ouverts (attendu ${openBefore.length})`)
  console.log(restored ? '✅ état restauré' : '❌ ÉTAT NON RESTAURÉ')
  process.exit(failures === 0 && restored ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
