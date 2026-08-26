/**
 * Read-only probe for the TRM Atelier > Maintenance port (routes/maintenance-trm.ts).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/probe-maintenance-trm.ts
 *
 * Re-run it against prod after /etm_deploy: it is the only thing that exercises
 * the Linux read path (queryB64Text on `machine`, whose `connecté` / `archivé` /
 * `diamètre` columns can never be named in SQL).
 *
 * What it checks:
 *   1. `machine` full select works on this platform and the physical key order
 *      matches what the router expects (no memo-binary column on this table, so
 *      SELECT * is safe on Windows too — unlike stock_fil / client).
 *   2. ROULOIR THRESHOLD PARITY — the load-bearing test. The legacy
 *      FI_Maintenance window is PCS-compressed and integer literals do NOT
 *      survive WinDev's compile cache, so the 15 000 Kg threshold was recovered
 *      by reconstructing the "Rouloir dans N Kgs" values read off a live
 *      screenshot (2026-08-26). This replays that reconciliation: if it fails,
 *      MAINTENANCE_ROULOIR_SEUIL_KG is wrong.
 *   3. operation_maintenance: the 3 atelier-wide rows and their `frequence`
 *      (months — cross-checked against the screenshot's "Il y a 10 mois").
 *   4. Encoding: maintenance comments carry accents ("poignée", "surveillé") —
 *      verifies the platform's repair path returns them clean.
 *   5. double_fonture is a plain 0/1 flag (the Simple/Double Fonture radio).
 */
import { query, queryB64Text, fixEncoding, closeConnection } from '../lib/hfsql-auto.js'

const IS_WINDOWS = process.platform === 'win32'

/** Same constant as routes/maintenance-trm.ts — deliberately duplicated so the
 *  probe fails loudly if someone edits the router's copy without re-verifying. */
const SEUIL_KG = 15_000

/** Expected physical column order of `machine`, from a runtime SELECT *. */
const EXPECTED_KEYS = [
  'IDmachine', 'nom', 'commentaire', 'date_maintenance', 'observation_maintenace',
  'nett_cylindre', 'nett_plateau', 'nett_platines', 'double_fonture',
  'comm_nett_cylindre', 'comm_nett_plateau', 'comm_nett_platines',
  'chg_aiguilles', 'chg_platines', 'comm_chg_aiguilles', 'comm_chg_platines',
  'connecté', 'IDDernier_evenement', 'emplacement', 'archivé', 'adresse_automate',
  'Jauge', 'diamètre', 'nb_chutes_max', 'elasthanne', 'nb_chutes',
  'pulsonique', 'comm_pulsonque', 'vitesse',
]

/**
 * "Rouloir dans N Kgs" as displayed by the legacy window on 2026-08-26, keyed by
 * `machine.emplacement`. These are the observed outputs the threshold was solved
 * from — do not "refresh" them from the app's own numbers, that would make the
 * test circular.
 */
const LEGACY_ROULOIR_KGS: Record<string, number> = {
  '2E': 0, '3G': 0, '3J': 0,
  '3H': 610, '3K': 610, '3F': 3495, '2J': 3834, '1J': 4188, '1G': 4650,
  '3I': 5170, '2F': 6483, '2D': 7188, '2H': 7359, '2I': 7770,
}

const num = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/** Key-fold helper: on the Linux bridge accented keys come back mangled. */
function pick(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}

let failures = 0
function check(ok: boolean, label: string, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  console.log(`platform: ${process.platform}\n`)

  // ── 1. machine full select + key order ──
  const sql = 'SELECT * FROM machine'
  const machines = IS_WINDOWS
    ? await fixEncoding(
        await query<Record<string, unknown>>(sql),
        'machine',
        'IDmachine',
        ['nom', 'emplacement', 'commentaire', 'observation_maintenace'],
      )
    : await queryB64Text<Record<string, unknown>>(sql)

  console.log(`[1] machine — ${machines.length} rows`)
  check(machines.length > 0, 'SELECT * FROM machine returns rows')
  if (machines.length === 0) throw new Error('machine full select returned 0 rows on this platform')

  const keys = Object.keys(machines[0])
  console.log(`    key order: ${keys.join(', ')}`)
  if (IS_WINDOWS) {
    check(
      keys.length === EXPECTED_KEYS.length && keys.every((k, i) => k === EXPECTED_KEYS[i]),
      'physical column order matches the recovered layout',
    )
  } else {
    // Linux mangles the three accented names; compare only the ASCII ones by position.
    const ascii = EXPECTED_KEYS.map((k, i) => (/[^\x20-\x7E]/.test(k) ? null : [k, i] as const))
      .filter((x): x is readonly [string, number] => x !== null)
    check(
      keys.length === EXPECTED_KEYS.length && ascii.every(([k, i]) => keys[i] === k),
      'physical column order matches (ASCII positions)',
    )
  }

  const actifs = machines.filter((r) => num(pick(r, /^archiv/i)) === 0)
  console.log(`    non-archivées: ${actifs.length} / ${machines.length}`)
  check(actifs.length > 0, 'at least one non-archived métier')

  // ── 5. double_fonture domain ──
  const fontures = new Set(machines.map((r) => num(r.double_fonture)))
  check(
    [...fontures].every((v) => v === 0 || v === 1),
    'double_fonture is a 0/1 flag',
    `values: ${[...fontures].sort().join(', ')}`,
  )

  // ── 2. rouloir threshold parity ──
  // One grouped pass over the OF table, folded in JS — 30 correlated queries
  // would be 30 bridge round-trips.
  const ofs = await query<Record<string, unknown>>(
    'SELECT IDmachine, date_creation, quantite FROM ordre_fabrication WHERE est_termine = 1',
  )
  const produitByMachine = new Map<number, number>()
  const visiteById = new Map<number, string>()
  for (const m of machines) {
    visiteById.set(num(m.IDmachine), String(m.date_maintenance ?? '').trim())
  }
  for (const o of ofs) {
    const id = num(o.IDmachine)
    const visite = visiteById.get(id)
    if (!visite || !/^\d{8}$/.test(visite)) continue
    const created = String(o.date_creation ?? '').trim()
    if (!/^\d{8}$/.test(created) || created <= visite) continue
    produitByMachine.set(id, (produitByMachine.get(id) ?? 0) + num(o.quantite))
  }

  console.log(`\n[2] rouloir parity vs the legacy screenshot (seuil = ${SEUIL_KG} Kg)`)
  let worst = 0
  for (const [emplacement, expected] of Object.entries(LEGACY_ROULOIR_KGS)) {
    const row = actifs.find((r) => String(r.emplacement ?? '').trim() === emplacement)
    if (!row) {
      check(false, `métier ${emplacement}`, 'not found among non-archived machines')
      continue
    }
    const produit = produitByMachine.get(num(row.IDmachine)) ?? 0
    const restant = Math.max(0, SEUIL_KG - produit)
    const delta = Math.abs(Math.round(restant) - expected)
    worst = Math.max(worst, delta)
    check(
      delta <= 1,
      `métier ${emplacement}`,
      `produit ${produit.toFixed(2)} → restant ${restant.toFixed(2)} (legacy ${expected}, écart ${delta})`,
    )
  }
  console.log(`    worst delta: ${worst} Kg`)

  // ── 3. operation_maintenance ──
  const ops = await query<Record<string, unknown>>('SELECT * FROM operation_maintenance')
  console.log(`\n[3] operation_maintenance — ${ops.length} rows`)
  for (const o of ops) {
    const last = String(o.date_derniere ?? '').trim()
    console.log(
      `    #${num(o.IDoperation_maintenance)} ${String(o.nom ?? '')} — dernière ${last || '—'}, tous les ${num(o.frequence)} mois`,
    )
    check(/^\d{8}$/.test(last) || last === '', `#${num(o.IDoperation_maintenance)} date_derniere is a DATE`, last)
    check(num(o.frequence) > 0, `#${num(o.IDoperation_maintenance)} frequence set`)
  }
  check(ops.length >= 3, 'the three atelier-wide operations exist')

  // ── 4. encoding ──
  console.log('\n[4] encoding of maintenance comments')
  const TEXTS = [
    'commentaire', 'observation_maintenace',
    'comm_nett_cylindre', 'comm_nett_plateau', 'comm_nett_platines',
    'comm_chg_aiguilles', 'comm_chg_platines', 'comm_pulsonque',
  ]
  let accented = 0
  let mojibake = 0
  for (const m of machines) {
    for (const col of TEXTS) {
      const v = String(m[col] ?? '')
      if (/[À-ÿ]/.test(v)) accented++
      // The classic HFSQL breakage: a Latin-1 byte surfacing as U+FFFD or as
      // the "Ã©" double-encoding.
      if (/�|Ã.|Â./.test(v)) {
        mojibake++
        console.log(`    mojibake on IDmachine ${num(m.IDmachine)}.${col}: ${JSON.stringify(v.slice(0, 60))}`)
      }
    }
  }
  console.log(`    accented values: ${accented}`)
  check(accented > 0, 'accented comments are present (the repair path is exercised)')
  check(mojibake === 0, 'no mojibake in maintenance comments')

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  await closeConnection()
  if (failures > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
