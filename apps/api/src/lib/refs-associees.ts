import { query, fixEncoding } from './hfsql-auto.js'
import { createSerialLock } from './serial-lock.js'
import { numOf, strOf, pick } from './clients-common.js'

/**
 * Associated finished references (LIVA #1217) — the côte that goes with a
 * molleton. Two levels, both legacy:
 *
 *   • the CATALOG: `ref_fini.associee`, a CSV of IDref_fini the reference can
 *     be sold with (« 0,1769,274 » — a leading 0, empty items and sometimes the
 *     ref itself survive from WinDev). Edited on Finis › Références.
 *   • the CLIENT: when Clients › Gestion ticks an associated ref on a client's
 *     designation, a hidden `designation_client` child row is created for it
 *     (designation « Reference Associée », caché = 1) and the parent's own
 *     `associee` CSV lists those child DESIGNATION ids. The Clients checklist
 *     only offers what the catalog holds — so a catalog association may not be
 *     removed while a client still carries it (Vincent 2026-09-25): it would
 *     stay linked with no way to untick it.
 *
 * Every column named here is ASCII; `archivé` is read through SELECT * and
 * pruned in JS.
 */

export interface RefAssociee {
  IDref_fini: number
  reference: string
  designation: string
}

/** Serializes the read-modify-write of `ref_fini.associee`. */
const associeeLock = createSerialLock()

/** Parse a legacy associee CSV into distinct positive ids, dropping `selfId`. */
export function parseAssocieeCsv(raw: unknown, selfId = 0): number[] {
  return [...new Set(String(raw ?? '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== selfId))]
}

async function readCsv(IDref_fini: number): Promise<number[] | null> {
  const rows = await query<Record<string, unknown>>(`SELECT associee FROM ref_fini WHERE IDref_fini = ${IDref_fini}`)
  if (rows.length === 0) return null
  return parseAssocieeCsv(rows[0].associee, IDref_fini)
}

async function writeCsv(IDref_fini: number, ids: number[]): Promise<void> {
  // Digits and commas only — safe as a quoted literal.
  await query(`UPDATE ref_fini SET associee = '${ids.join(',')}' WHERE IDref_fini = ${IDref_fini}`)
}

/** Label rows for a set of ref_fini ids, in the given order; unknown ids dropped. */
async function labelRefs(ids: number[]): Promise<RefAssociee[]> {
  if (ids.length === 0) return []
  const rows = await query<Record<string, unknown>>(
    `SELECT IDref_fini, reference, designation FROM ref_fini WHERE IDref_fini IN (${ids.join(',')})`,
  )
  const fixed = await fixEncoding(rows, 'ref_fini', 'IDref_fini', ['reference', 'designation'])
  const byId = new Map(fixed.map((r) => [numOf(r.IDref_fini), r]))
  return ids.flatMap((id) => {
    const r = byId.get(id)
    return r ? [{ IDref_fini: id, reference: strOf(r.reference) ?? '', designation: strOf(r.designation) ?? '' }] : []
  })
}

/** The catalog associations of one reference, labelled, in CSV order. */
export async function loadRefAssociees(IDref_fini: number): Promise<RefAssociee[]> {
  const ids = await readCsv(IDref_fini)
  return ids ? labelRefs(ids) : []
}

export type AttachAssocieeResult = 'ok' | 'ref_not_found' | 'associee_not_found' | 'elle_meme' | 'deja_associee'

export async function attachRefAssociee(IDref_fini: number, IDassociee: number): Promise<AttachAssocieeResult> {
  if (IDassociee === IDref_fini) return 'elle_meme'
  return associeeLock.run(async () => {
    const ids = await readCsv(IDref_fini)
    if (!ids) return 'ref_not_found'
    const target = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ref_fini WHERE IDref_fini = ${IDassociee}`)
    if (Number(target[0]?.n ?? 0) === 0) return 'associee_not_found'
    if (ids.includes(IDassociee)) return 'deja_associee'
    await writeCsv(IDref_fini, [...ids, IDassociee])
    return 'ok'
  })
}

export interface ClientUsingAssociee {
  IDclient: number
  nom: string
}

/** Clients whose catalogue links `IDassociee` under a designation of `IDref_fini`
 *  (an active parent designation holding a hidden child row on that ref). */
export async function clientsUsingAssociation(IDref_fini: number, IDassociee: number): Promise<ClientUsingAssociee[]> {
  // designation_client tolerates SELECT * (verified); archivé is accented → pruned in JS.
  const parents = (await query<Record<string, unknown>>(
    `SELECT * FROM designation_client WHERE IDref_fini = ${IDref_fini}`,
  )).filter((r) => !numOf(pick(r, 'archivé', 'archiv')) && String(r.associee ?? '').trim() !== '')
  const clientByChild = new Map<number, number>()
  for (const p of parents) {
    for (const did of parseAssocieeCsv(p.associee)) clientByChild.set(did, numOf(p.IDclient))
  }
  if (clientByChild.size === 0) return []
  const children = await query<{ IDdesignation_client: number; IDclient: number; IDref_fini: number }>(
    `SELECT IDdesignation_client, IDclient, IDref_fini FROM designation_client ` +
      `WHERE IDdesignation_client IN (${[...clientByChild.keys()].join(',')})`,
  )
  const clientIds = [...new Set(children
    .filter((c) => numOf(c.IDref_fini) === IDassociee && clientByChild.get(numOf(c.IDdesignation_client)) === numOf(c.IDclient))
    .map((c) => numOf(c.IDclient)))]
  if (clientIds.length === 0) return []
  const rows = await query<Record<string, unknown>>(`SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`)
  const fixed = await fixEncoding(rows, 'client', 'IDclient', ['nom'])
  return fixed
    .map((r) => ({ IDclient: numOf(r.IDclient), nom: (strOf(r.nom) ?? '').trim() || `Client ${numOf(r.IDclient)}` }))
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
}

export type DetachAssocieeResult =
  | { status: 'ok' }
  | { status: 'ref_not_found' }
  | { status: 'utilisee'; clients: ClientUsingAssociee[] }

/** Remove a catalog association — refused while a client still carries it. Idempotent otherwise. */
export async function detachRefAssociee(IDref_fini: number, IDassociee: number): Promise<DetachAssocieeResult> {
  return associeeLock.run(async () => {
    const ids = await readCsv(IDref_fini)
    if (!ids) return { status: 'ref_not_found' }
    const clients = await clientsUsingAssociation(IDref_fini, IDassociee)
    if (clients.length > 0) return { status: 'utilisee', clients }
    if (ids.includes(IDassociee)) await writeCsv(IDref_fini, ids.filter((x) => x !== IDassociee))
    return { status: 'ok' }
  })
}

/** French refusal naming the clients, ready to display. */
export function associationUtiliseeMessage(clients: ClientUsingAssociee[]): string {
  const names = clients.map((c) => c.nom)
  const shown = names.length > 8 ? `${names.slice(0, 8).join(', ')} et ${names.length - 8} autre(s)` : names.join(', ')
  return `Cette association est utilisée par ${clients.length > 1 ? 'les clients' : 'le client'} ${shown}. `
    + `Décochez-la d’abord dans leur fiche (Clients › Gestion).`
}
