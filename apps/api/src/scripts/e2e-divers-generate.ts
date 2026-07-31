// End-to-end exercise of POST /factures/prov/generate on the DEV database:
// snapshot → generate → inspect → roll back via the app's own delete-batch.
//
// ⚠ THIS SCRIPT WRITES. It creates real proformas and flips est_facture on the
// shipments they invoice, then deletes them again through /prov/delete-batch
// (which is what reopens the shipments). It refuses any non-localhost target —
// never point it at mpsng.malterre. For a read-only check use
// check-divers-facturation.ts instead.
//
// Run:  node scripts/worktree/status.mjs      # find your slot's API port
//       E2E_BASE=http://localhost:8081/api E2E_USER=1 npx tsx src/scripts/e2e-divers-generate.ts
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { signUserId } from '../lib/auth.js'

const BASE = process.env.E2E_BASE ?? 'http://localhost:8080/api'

async function main() {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(BASE)) {
    console.error(`Refus: E2E_BASE doit viser localhost (reçu "${BASE}"). Ce script écrit en base.`)
    process.exit(1)
  }
  const uid = Number(process.env.E2E_USER ?? 1)
  const signed = signUserId(uid)
  // Both cookies → effective admin (auth.ts isEffectiveAdmin), which is what
  // grants edit_factures without a local permissions.json.
  const cookie = `mps_uid=${signed}; mps_uid_admin=${signed}`

  const before = (await query<any>(`SELECT IDfacture_prov FROM facture_prov WHERE IDsociete = 1`)) as any[]
  const beforeIds = new Set(before.map((r) => Number(r.IDfacture_prov)))
  const openDivers = (await query<any>(
    `SELECT IDexpedition_divers FROM expedition_divers WHERE est_facture IS NULL OR est_facture = 0`,
  )) as any[]
  console.log(`before: ${beforeIds.size} proforma(s), ${openDivers.length} expédition(s) diverse(s) ouverte(s)`)

  const res = await fetch(`${BASE}/factures/prov/generate`, { method: 'POST', headers: { cookie } })
  const body = await res.json() as any
  console.log(`POST /prov/generate → ${res.status}`)
  console.log(JSON.stringify(body, null, 2))
  if (!res.ok) process.exit(1)

  const createdIds: number[] = (body.created ?? []).map((c: any) => Number(c.id))
  for (const c of body.created ?? []) {
    const lignesRaw = (await query<any>(
      `SELECT IDligne_facture_prov, designation, quantite, unite, prix FROM ligne_facture_prov WHERE IDfacture_prov = ${Number(c.id)}`,
    )) as any[]
    // Read back through fixEncoding, like every screen does — this is what
    // proves the accented write round-tripped ("Tissu Voltige ®", "Mètres",
    // "Pièce" all go out as Latin-1 hex literals via sqlText).
    const lignes = (await fixEncoding(
      lignesRaw, 'ligne_facture_prov', 'IDligne_facture_prov', ['designation', 'unite'],
    )) as any[]
    const head = (await query<any>(
      `SELECT IDfacture_prov, IDclient, IDadresse, IDtva, IDexpedition_divers FROM facture_prov WHERE IDfacture_prov = ${Number(c.id)}`,
    )) as any[]
    console.log(`\nproforma ${c.id} (divers=${c.divers}) head=${JSON.stringify(head[0])}`)
    for (const l of lignes) {
      console.log('   ', JSON.stringify({ des: String(l.designation).replace(/\r\n/g, ' | '), q: Number(l.quantite), u: String(l.unite ?? ''), p: Number(l.prix) }))
    }
  }
  const stillOpen = (await query<any>(
    `SELECT IDexpedition_divers FROM expedition_divers WHERE est_facture IS NULL OR est_facture = 0`,
  )) as any[]
  console.log(`\nexpéditions diverses encore ouvertes après génération: ${stillOpen.map((r) => Number(r.IDexpedition_divers)).join(', ') || '(aucune)'}`)

  // --- roll back ------------------------------------------------------
  if (createdIds.length > 0) {
    const del = await fetch(`${BASE}/factures/prov/delete-batch`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: createdIds }),
    })
    console.log(`\nrollback DELETE-batch → ${del.status} ${JSON.stringify(await del.json())}`)
  }
  const after = (await query<any>(`SELECT IDfacture_prov FROM facture_prov WHERE IDsociete = 1`)) as any[]
  const reopened = (await query<any>(
    `SELECT IDexpedition_divers FROM expedition_divers WHERE est_facture IS NULL OR est_facture = 0`,
  )) as any[]
  console.log(`after rollback: ${after.length} proforma(s) (attendu ${beforeIds.size}), ${reopened.length} expédition(s) diverse(s) ouverte(s) (attendu ${openDivers.length})`)
  const ok = after.length === beforeIds.size && reopened.length === openDivers.length
  console.log(ok ? '✅ état restauré' : '❌ ÉTAT NON RESTAURÉ')
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
