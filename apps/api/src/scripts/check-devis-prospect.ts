// Guard for ticket #1112 — devis prospect (create a devis from Prospects ›
// Demandes, served by the shared Clients › Devis screen).
//
// Read-only pins (always run):
//   1. Adresse 795 « A Définir » exists — the placeholder every prospect
//      devis points at (legacy FEN_devis_prospect convention, kept for
//      WinDev compatibility).
//   2. Every prospect devis (IDprospect > 0) has IDclient = 0 — a row with
//      both set would show under two identities at once.
//   3. Every prospect devis resolves to an existing prospect row with a
//      non-empty display name (what the list, PDF and email show).
//   4. The legacy reference devis (numero 181, prospect 1073) still reads as
//      the ticket's reverse-engineering established: placeholder addresses,
//      2 fini lines.
//
// --roundtrip: inserts a prospect devis + one line through the same SQL
// shapes the route uses, re-reads them, then deletes both. Dev-safe (the
// rows exist for milliseconds and carry a marker ref_client).
//
// Run:   npx tsx src/scripts/check-devis-prospect.ts [--roundtrip]
// (on the prod API server, prefix with --env-file — see memory
// project-server-side-api-scripts-env)

import { query } from '../lib/hfsql-auto.js'
import { loadProspectsLite } from '../routes/prospects.js'
import { buildDevisPdfData } from '../routes/devis.js'

const ROUNDTRIP = process.argv.includes('--roundtrip')

let failures = 0
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function esc(v: string): string { return v.replace(/'/g, "''") }

async function main() {
  // 1. Placeholder adresse 795.
  const adr = await query<Record<string, unknown>>(`SELECT * FROM adresse WHERE IDadresse = 795`)
  const adrNom = String(adr[0]?.nom ?? '')
  check('adresse 795 exists', adr.length === 1)
  // Encoding-tolerant: « A Définir » may arrive with a mangled é.
  check('adresse 795 is the « A Définir » placeholder', /^A D.finir$/i.test(adrNom), JSON.stringify(adrNom))

  // 2 + 3. Prospect devis population.
  const pdevis = await query<Record<string, unknown>>(
    `SELECT IDDevis_etm, IDclient, IDprospect, IDadresse_livraison, IDadresse_facturation, numero
     FROM devis_etm WHERE IDprospect > 0`,
  )
  check('prospect devis exist', pdevis.length > 0, `${pdevis.length} rows`)
  const withClient = pdevis.filter((r) => Number(r.IDclient) > 0)
  check('no prospect devis carries an IDclient', withClient.length === 0,
    withClient.map((r) => `devis ${r.IDDevis_etm}`).join(', ') || undefined)

  const prospectIds = pdevis.map((r) => Number(r.IDprospect))
  const prospects = await loadProspectsLite(prospectIds)
  const orphans = pdevis.filter((r) => !prospects.has(Number(r.IDprospect)))
  check('every prospect devis joins to an existing prospect', orphans.length === 0,
    orphans.map((r) => `devis ${r.IDDevis_etm} → prospect ${r.IDprospect}`).join(', ') || undefined)
  const nameless = Array.from(prospects.values()).filter((p) => !p.nom.trim())
  check('every joined prospect has a display name', nameless.length === 0,
    nameless.map((p) => `prospect ${p.IDprospect}`).join(', ') || undefined)

  // 4. Legacy reference devis (dev copy: IDDevis_etm 193, numero 181,
  // prospect 1073). Skipped when absent (prod may have moved on).
  const ref = pdevis.find((r) => Number(r.numero) === 181 && Number(r.IDprospect) === 1073)
  if (ref) {
    const refId = Number(ref.IDDevis_etm)
    check('reference devis 181 uses the placeholder addresses',
      Number(ref.IDadresse_livraison) === 795 && Number(ref.IDadresse_facturation) === 795)
    const lignes = await query<Record<string, unknown>>(
      `SELECT TYPE AS type_kind FROM ligne_devis_etm WHERE IDDevis_etm = ${refId}`,
    )
    check('reference devis 181 has its 2 fini lines',
      lignes.length === 2 && lignes.every((l) => Number((l as any).type_kind) === 2),
      `${lignes.length} lines`)

    // PDF data (the assertable element-tree input — see pdf_email.md): the
    // prospect's name and own address must replace the « A Définir »
    // placeholder that the row physically stores.
    const pdf = await buildDevisPdfData(refId)
    check('PDF data carries the prospect name', !!pdf && pdf.clientNom === prospects.get(1073)?.nom, pdf?.clientNom)
    const pdfAdr = pdf?.adresseFacturation
    check('PDF address is the prospect\'s own, not « A Définir »',
      !!pdfAdr && !/A D.finir/i.test(pdfAdr.nom ?? '') && !!pdfAdr.ville,
      pdfAdr ? `${pdfAdr.nom} / ${pdfAdr.ville}` : 'null')
  } else {
    console.log('SKIP reference devis 181/prospect 1073 not in this copy')
  }

  // --roundtrip: create → read → delete, through the route's SQL shapes.
  if (ROUNDTRIP) {
    const anyProspect = prospects.size > 0
      ? Array.from(prospects.keys())[0]
      : Number((await query<{ IDprospect: number }>(`SELECT IDprospect FROM prospect ORDER BY IDprospect DESC`))[0]?.IDprospect)
    check('roundtrip: a prospect to attach to', Number(anyProspect) > 0)
    const marker = `check-devis-prospect-${Date.now()}`
    const numRow = await query<{ m: number | null }>(`SELECT MAX(numero) AS m FROM devis_etm`)
    const numero = (Number(numRow[0]?.m) || 0) + 1
    await query(
      `INSERT INTO devis_etm
         (IDclient, IDprospect, numero, date, date_expiration,
          IDadresse_livraison, IDadresse_facturation, IDmode_paiement, IDecheance,
          ref_client, commentaire, commentaire_interne, observations_facturation,
          est_soldee, remise, frais_port, IDcommande_ETM)
       VALUES
         (0, ${anyProspect}, ${numero}, '20260101', '20260201', 795, 795, 3, 11,
          '${esc(marker)}', '', '', '', 0, 0, 0, 0)`,
    )
    const created = await query<Record<string, unknown>>(
      `SELECT IDDevis_etm, IDprospect, IDadresse_livraison FROM devis_etm WHERE ref_client = '${esc(marker)}'`,
    )
    const newId = Number(created[0]?.IDDevis_etm) || 0
    check('roundtrip: devis created and re-readable', newId > 0 && Number(created[0]?.IDprospect) === Number(anyProspect))
    try {
      await query(
        `INSERT INTO ligne_devis_etm
           (IDDevis_etm, TYPE, IDreference, IDref_ecru, IDcolori,
            quantite, unite, prix, poids, date_livraison, commentaire, IDdesignation_client)
         VALUES (${newId}, 2, 1, 0, 0, 10, 3, 5.5, 0, '', '', 0)`,
      )
      const lines = await query<Record<string, unknown>>(
        `SELECT IDligne_devis_etm FROM ligne_devis_etm WHERE IDDevis_etm = ${newId}`,
      )
      check('roundtrip: line created', lines.length === 1)
    } finally {
      await query(`DELETE FROM ligne_devis_etm WHERE IDDevis_etm = ${newId}`)
      await query(`DELETE FROM devis_etm WHERE IDDevis_etm = ${newId}`)
      const gone = await query<Record<string, unknown>>(`SELECT IDDevis_etm FROM devis_etm WHERE IDDevis_etm = ${newId}`)
      check('roundtrip: cleanup complete', gone.length === 0)
    }
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
