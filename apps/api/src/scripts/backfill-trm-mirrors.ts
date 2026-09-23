// Backfill missing TRM commande_client mirrors for ETM sst commandes
// (IDsous_traitant = 1, Tricotage Malterre). For each sst id provided,
// recreates the header mirror + per-line mirror as the POST endpoint would
// have, using the corrected accent-safe INSERT.
//
// Usage:
//   pnpm exec tsx src/scripts/backfill-trm-mirrors.ts <sstId> [sstId...]
//   pnpm exec tsx src/scripts/backfill-trm-mirrors.ts --apply <sstId> [sstId...]
//
// Without --apply, prints a dry-run plan. With --apply, executes the inserts.
// Idempotent: if a mirror already exists for a given sst, the script reports
// it and skips. Mirrors are created with HFSQL defaults (= 0) for the
// `archivé`, `expedié`, `envoyé_client` columns since the Linux iODBC bridge
// can't tokenize accented identifiers.

import 'dotenv/config'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { stripRtf } from '../lib/rtf-utils.js'
// A rectiligne sst line (type 4, cols / bandes — LIVA #1185) mirrors as type 4
// in pieces, like the live bridge; everything else as the type-1 écru line.
import { isRectiligneType, LINE_TYPE_RECTILIGNE } from '../lib/sst-line-kind.js'

const TRICOTAGE_MALTERRE_ID = 1

function esc(value: string): string {
  return value.replace(/'/g, "''")
}

function n(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const x = Number(value)
  return Number.isFinite(x) ? x : 0
}

async function nextTrmNumero(): Promise<number> {
  const r = await query<{ m: number | null }>(
    `SELECT MAX(numero) AS m FROM commande_client WHERE IDsociete = 2`,
  )
  return (Number(r[0]?.m) || 0) + 1
}

async function refClientFor(sstId: number, lineRefs: number[]): Promise<string> {
  const ids = Array.from(new Set(lineRefs.filter((x) => x > 0)))
  if (ids.length === 0) return `commande ${sstId}`
  const rows = await query<{ IDref_ecru: number; reference: string | null }>(
    `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${ids.join(',')})`,
  )
  const fixed = await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference'])
  const labelById = new Map<number, string>()
  for (const f of fixed as Array<{ IDref_ecru: number; reference: string | null }>) {
    labelById.set(Number(f.IDref_ecru), (f.reference ?? '').toString().trim())
  }
  const labels: string[] = []
  for (const id of lineRefs) {
    const lbl = labelById.get(id)
    if (lbl) labels.push(lbl)
  }
  return labels.length > 0 ? `commande ${sstId}, ${labels.join(', ')}` : `commande ${sstId}`
}

interface SstLine {
  IDligne_commande_sous_traitant: number
  IDreference: number | null
  IDColoris: number | null
  quantite: number | null
  prix: number | null
  date_livraison: string | null
  commentaire: string | null
  type_kind: number | null
  unite: number | null
}

async function backfillOne(sstId: number, apply: boolean): Promise<'created' | 'exists' | 'not-trm' | 'no-sst' | 'failed'> {
  // 1) Verify the sst exists and targets TRM.
  const sstRows = await query<{ IDcommande_sous_traitant: number; IDsous_traitant: number; date_commande: string | null }>(
    `SELECT IDcommande_sous_traitant, IDsous_traitant, date_commande
     FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${sstId}`,
  )
  if (sstRows.length === 0) {
    console.log(`  sst ${sstId}: NOT FOUND in commande_sous_traitant — skipped`)
    return 'no-sst'
  }
  if (Number(sstRows[0].IDsous_traitant) !== TRICOTAGE_MALTERRE_ID) {
    console.log(`  sst ${sstId}: IDsous_traitant = ${sstRows[0].IDsous_traitant} (not Tricotage Malterre) — skipped`)
    return 'not-trm'
  }
  const dateCmd = sstRows[0].date_commande ?? ''

  // 2) Idempotency check.
  const exists = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM commande_client WHERE IDcommande_ETM = ${sstId}`,
  )
  if (exists.length > 0) {
    console.log(`  sst ${sstId}: mirror cc ${exists[0].IDcommande_client} already exists — skipped`)
    return 'exists'
  }

  // 3) Load lines (raw RTF — we'll strip per line).
  const linesRaw = await query<SstLine>(
    `SELECT IDligne_commande_sous_traitant, IDreference, IDColoris, quantite, prix,
            date_livraison, commentaire, type AS type_kind, unite
     FROM ligne_commande_sous_traitant
     WHERE IDcommande_sous_traitant = ${sstId}
     ORDER BY IDligne_commande_sous_traitant`,
  )
  const linesFixed = await fixEncoding(linesRaw, 'ligne_commande_sous_traitant',
    'IDligne_commande_sous_traitant', ['commentaire'])
  const lines = linesFixed as SstLine[]

  const lineRefs = lines.map((l) => Number(l.IDreference) || 0)
  const refClient = await refClientFor(sstId, lineRefs)

  if (!apply) {
    console.log(`  sst ${sstId}: WOULD CREATE mirror cc — ref_client="${refClient}", date=${dateCmd}, ${lines.length} line(s)`)
    for (const l of lines) {
      const plain = stripRtf(l.commentaire ?? '') || ''
      console.log(`      line ${l.IDligne_commande_sous_traitant}: ref=${l.IDreference} colori=${l.IDColoris} qty=${l.quantite} prix=${l.prix} dl=${l.date_livraison}${plain ? ' notes="' + plain.slice(0, 30) + '"' : ''}`)
    }
    return 'created' // shown as planned
  }

  // 4) Allocate numero with retry (matches POST endpoint behaviour).
  let inserted = false
  let lastErr: unknown = null
  let newCcId = 0
  for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
    const numero = await nextTrmNumero()
    try {
      await query(
        `INSERT INTO commande_client
         (IDclient, IDsociete, IDcommande_ETM, numero, date_commande,
          IDadresse_livraison, IDadresse_facturation, IDmode_paiement, IDecheance,
          ref_client, est_soldee, remise, donation,
          attente_paiement, frais_port, IDdossier)
         VALUES (1, 2, ${sstId}, ${numero}, '${esc(dateCmd)}',
                 1, 1, 3, 2,
                 '${esc(refClient)}', 0, 0, 0,
                 0, 0, 0)`,
      )
      // Resolve the newly inserted cc id.
      const lookup = await query<{ IDcommande_client: number }>(
        `SELECT IDcommande_client FROM commande_client
         WHERE IDcommande_ETM = ${sstId}`,
      )
      if (lookup.length === 0) throw new Error('post-insert lookup failed')
      newCcId = Number(lookup[0].IDcommande_client)
      inserted = true
    } catch (e) {
      lastErr = e
    }
  }
  if (!inserted) {
    console.error(`  sst ${sstId}: header mirror INSERT failed after 3 attempts:`, lastErr)
    return 'failed'
  }

  // 5) Per-line mirror INSERTs.
  let lineOk = 0
  for (const l of lines) {
    const plainCmt = stripRtf(l.commentaire ?? '') || ''
    try {
      await query(
        `INSERT INTO ligne_commande_client
         (IDcommande_client, IDligne_commande_ETM, TYPE, IDreference, IDcolori,
          quantite, unite, prix, poids, date_livraison, commentaire)
         VALUES (${newCcId}, ${Number(l.IDligne_commande_sous_traitant)}, ${isRectiligneType(l.type_kind) ? LINE_TYPE_RECTILIGNE : 1},
                 ${Number(l.IDreference) || 0}, ${Number(l.IDColoris) || 0},
                 ${n(l.quantite)}, ${isRectiligneType(l.type_kind) ? (Number(l.unite) || 4) : 1}, ${n(l.prix)}, 0,
                 '${esc(l.date_livraison ?? '')}', '${esc(plainCmt)}')`,
      )
      lineOk++
    } catch (e) {
      console.error(`  sst ${sstId}: line ${l.IDligne_commande_sous_traitant} mirror INSERT failed:`, (e as Error).message)
    }
  }
  console.log(`  sst ${sstId}: created cc ${newCcId} (${lineOk}/${lines.length} lines)`)
  return 'created'
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const ids = args
    .filter((a) => !a.startsWith('--'))
    .map((a) => parseInt(a, 10))
    .filter((x) => Number.isFinite(x) && x > 0)

  if (ids.length === 0) {
    console.error('usage: backfill-trm-mirrors.ts [--apply] <sstId> [sstId...]')
    process.exit(1)
  }

  console.log(`[${apply ? 'APPLY' : 'DRY-RUN'}] backfilling ${ids.length} sst(s): ${ids.join(', ')}`)

  let created = 0, skipped = 0, failed = 0
  for (const id of ids) {
    const result = await backfillOne(id, apply)
    if (result === 'created') created++
    else if (result === 'failed') failed++
    else skipped++
  }

  console.log(`\n${apply ? 'Created' : 'Planned'}: ${created}, skipped: ${skipped}, failed: ${failed}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
