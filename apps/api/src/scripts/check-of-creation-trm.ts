/**
 * Round-trip guard for "Créer un OF" — the flow TRM's Clients › Commandes
 * gained on the line drawer's Stock de fil tab (tick lots → create an OF).
 *
 *   API_BASE=http://localhost:8082/api pnpm --filter @mps/api exec tsx src/scripts/check-of-creation-trm.ts
 *
 * The thing worth guarding is the COMPOSITION, not the HTTP plumbing. A blend
 * may feed the same (fil, coloris) from two positions — ref 119/ecru is 71 % +
 * 14,5 % + 14,5 % of two yarns — and the seed endpoint used to fold those rows
 * together by pair, which declared 85,5 % of the yarn on the created OF. Every
 * downstream weight is `poids × pourcentage/100` (stock movement at piece
 * declaration, freinte at archivage), so the error is silent and permanent.
 * This script proves the duplicate row survives the seed AND the INSERT.
 *
 * It CREATES an OF and deletes it again (the dev database is a stale snapshot
 * of prod — same scratch-write assumption as the other check scripts here).
 */
import crypto from 'node:crypto'
import { query, closeConnection } from '../lib/hfsql-auto.js'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else { failures++; console.error(`  FAIL ${label}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`) }
}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE, ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** A société-2 line whose écru composition carries a duplicated (fil, coloris)
 *  row — the case the fold used to break. Falls back to any line with a
 *  composition so the script still runs on a base without duplicates. */
async function pickLine(): Promise<{ id: number; duplicated: boolean } | null> {
  const compo = await query<{ IDref_ecru: number; IDcolori_ecru: number; IDref_fil: number; IDcolori_fil: number }>(
    `SELECT IDref_ecru, IDcolori_ecru, IDref_fil, IDcolori_fil FROM composition_ecru WHERE IDref_fil > 0`,
  )
  const seen = new Set<string>()
  const dupRefs = new Set<string>()
  for (const c of compo) {
    const k = `${c.IDref_ecru}:${c.IDcolori_ecru}:${c.IDref_fil}:${c.IDcolori_fil}`
    if (seen.has(k)) dupRefs.add(`${c.IDref_ecru}:${c.IDcolori_ecru}`)
    seen.add(k)
  }
  const cmds = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM commande_client WHERE IDsociete = 2`,
  )
  const trmCmds = new Set(cmds.map((c) => Number(c.IDcommande_client)).filter(Boolean))
  if (trmCmds.size === 0) return null

  // TYPE = 1 only: a TRM line is always écru, and the partition still carries a
  // few type-2/3 rows whose IDreference points at another catalog (no
  // composition_ecru at all, so they would read as a failure here).
  const lines = await query<{ IDligne_commande_client: number; IDcommande_client: number; IDreference: number; IDcolori: number }>(
    `SELECT IDligne_commande_client, IDcommande_client, IDreference, IDcolori FROM ligne_commande_client
     WHERE IDreference > 0 AND quantite > 0 AND TYPE = 1
     ORDER BY IDligne_commande_client DESC`,
  )
  const trmLines = lines.filter((l) => trmCmds.has(Number(l.IDcommande_client)))
  const dup = trmLines.find((l) => dupRefs.has(`${l.IDreference}:${l.IDcolori}`))
  if (dup) return { id: Number(dup.IDligne_commande_client), duplicated: true }
  const any = trmLines[0]
  return any ? { id: Number(any.IDligne_commande_client), duplicated: false } : null
}

async function main() {
  console.log(`\nCréation d'OF depuis une commande TRM - ${API}\n`)
  const line = await pickLine()
  if (!line) { console.error('  FAIL aucune ligne de commande société 2 exploitable'); process.exit(1) }
  console.log(`ligne #${line.id}${line.duplicated ? ' (composition à position dupliquée)' : ''}`)

  // 1. The seed the dialog opens with.
  const seed = await api(`/of-trm/lookups/composition?ligne=${line.id}`)
  check('  seed 200', seed.status === 200, seed.status)
  const components: any[] = seed.json?.components ?? []
  check('  au moins un fil', components.length > 0, components.length)
  check('  chaque ligne porte une clé distincte',
    new Set(components.map((c) => c.key)).size === components.length,
    components.map((c) => c.key))
  check('  total des pourcentages = 100 %', Math.abs((seed.json?.total_pourcentage ?? 0) - 100) < 0.01, seed.json?.total_pourcentage)
  check('  défauts de la fiche écru présents', seed.json?.defaults != null, seed.json?.defaults)
  if (line.duplicated) {
    const pairs = components.map((c) => `${c.IDref_fil}:${c.IDcolori_fil}`)
    check('  la position dupliquée survit au seed', new Set(pairs).size < pairs.length, pairs)
  }

  // 2. The line lookup the dialog uses when the line is imposed.
  const one = await api(`/of-trm/lookups/lignes-commande?ligne=${line.id}`)
  check('  lookup ?ligne= renvoie exactement la ligne',
    Array.isArray(one.json) && one.json.length === 1 && Number(one.json[0]?.id) === line.id,
    one.json?.length)

  // 2bis. The régleur's standing notes on the reference (obs_ref_ecru). The
  // machine filter is the legacy predicate: 0 narrows to the "Toutes" rows.
  const obs = await api(`/of-trm/lookups/observations?ligne=${line.id}&machine=0`)
  check('  observations 200', obs.status === 200, obs.status)
  check('  observations = tableau', Array.isArray(obs.json), typeof obs.json)
  check('  aucune observation ciblée machine avec machine=0',
    (obs.json ?? []).every((o: any) => o.cible_machine === false),
    (obs.json ?? []).map((o: any) => o.machine))

  // 3. Create, inspect, delete.
  const machines = await api('/of-trm/lookups/machines')
  const machineId = Number((machines.json ?? [])[0]?.id) || 0
  check('  un métier existe', machineId > 0, machineId)

  const quantite = 100
  const created = await api('/of-trm', {
    method: 'POST',
    body: JSON.stringify({
      IDligne_commande_client: line.id,
      IDmachine: machineId,
      quantite,
      composition: components.map((c) => ({
        IDref_fil: c.IDref_fil, IDcolori_fil: c.IDcolori_fil,
        IDstock_fil: c.defaultLot, pourcentage: c.pourcentage,
      })),
      // "Incorporer un fil" — the création window's second table, accepted by
      // POST since 2026-08-26 so the dialog does not create-then-edit.
      incorpore: components[0]?.defaultLot > 0
        ? [{ IDstock_fil: components[0].defaultLot, poids: 1 }]
        : [],
      visitage: 2, nettoyage: 2, finir_fil: 1, auto_activation: 1,
      observations: '[CHECK] création depuis la commande',
    }),
  })
  check('  POST /of-trm 201', created.status === 201, created.json)
  const ofId = Number(created.json?.id) || 0

  if (ofId > 0) {
    const rows = await query<{ IDref_fil: number; IDcolori_fil: number; pourcentage: number; IDstock_fil: number }>(
      `SELECT IDref_fil, IDcolori_fil, pourcentage, IDstock_fil FROM asso_fil_of WHERE IDordre_fabrication = ${ofId}`,
    )
    check('  une ligne asso_fil_of par position', rows.length === components.length, { got: rows.length, want: components.length })
    const total = rows.reduce((s, r) => s + (Number(r.pourcentage) || 0), 0)
    check('  les pourcentages écrits totalisent 100 %', Math.abs(total - 100) < 0.01, total)

    if (components[0]?.defaultLot > 0) {
      const incRows = await query<{ IDstock_fil: number; poids: number }>(
        `SELECT IDstock_fil, poids FROM fil_incorpore WHERE IDordre_fabrication = ${ofId}`,
      )
      check('  le fil incorporé est écrit', incRows.length === 1 && Number(incRows[0].poids) === 1, incRows)
    }

    const detail = await api(`/of-trm/${ofId}`)
    check('  GET /of-trm/:id 200', detail.status === 200, detail.status)
    check('  options de tricotage enregistrées',
      detail.json?.visitage === 2 && detail.json?.nettoyage === 2 && detail.json?.finir_fil === 1 && detail.json?.auto_activation === 1,
      { visitage: detail.json?.visitage, nettoyage: detail.json?.nettoyage, finir_fil: detail.json?.finir_fil, auto: detail.json?.auto_activation })
    check('  créé en attente', detail.json?.est_actif === 0 && detail.json?.est_termine === 0, detail.json?.est_actif)

    const del = await api(`/of-trm/${ofId}`, { method: 'DELETE' })
    check('  nettoyage (DELETE) 200', del.status === 200, del.status)
    const left = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM asso_fil_of WHERE IDordre_fabrication = ${ofId}`,
    )
    check('  asso_fil_of nettoyé', Number(left[0]?.n) === 0, left[0]?.n)
    const leftInc = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM fil_incorpore WHERE IDordre_fabrication = ${ofId}`,
    )
    check('  fil_incorpore nettoyé', Number(leftInc[0]?.n) === 0, leftInc[0]?.n)
  }

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
  await closeConnection()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  await closeConnection()
  process.exit(1)
})
