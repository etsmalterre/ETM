// The lots' Journal before it existed (Qualité › Suivi lots, lib/journal-lot.ts).
//
//   npx tsx src/scripts/journal-lot-historique.ts [--env production] [--write]
//
// Dry run by default (read-only transaction). Run ONCE after migration 0068.
// Source: `journal_activite` (every write since 2026-10-06), only for the three
// gestures that have no table of their own — everything else (soumissions,
// answers, RC, reprises…) is read live by the Journal from its own table:
//   - POST …/lignes/:ligne/pieces/fini (201)  → 'reception', one row per roll;
//   - PUT /suivi-lots/:id (2xx)               → 'mesures_ennoblisseur' / 'mesures_malterre' /
//     'coloris_malterre', from the difference between two successive saves of
//     the same lot (the form sends every field; the first save is compared with
//     nothing, so it lists the measures it carried);
//   - POST /suivi-lots/:id/etat {etat: 3} (2xx) → 'etat' « Lot validé ».
// Rows written with source 'historique', only before the first live gesture
// (so a gesture is never journaled twice), only for lots without 'historique' rows.
//
// Same pass for the orders' journal (lib/journal-commande-sst.ts, migration 0069):
//   - POST /commandes-sous-traitant/:id/email (2xx) → 'bon_commande' (who sent it);
//   - PUT  /commandes-sous-traitant/:id/etat (2xx)  → 'etat' clôturée / rouverte.
// The creation's author is not recoverable (the POST path carries no id).
import { config } from 'dotenv'
import { resolve } from 'node:path'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const env = arg('env') ?? 'development'
const write = process.argv.includes('--write')
config({ path: env === 'production' ? resolve(process.cwd(), '../../../ETM/apps/api/.env.production') : resolve(process.cwd(), '.env.development') })
if (!write) process.env.PGOPTIONS = '-c default_transaction_read_only=on'

const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const { changementsCote } = await import('../lib/journal-lot.js')
const { cleLot } = await import('../lib/cycle-ennoblissement.js')
type MesuresLot = import('../lib/journal-lot.js').MesuresLot
const sql = mpsPg()

const [{ table }] = await sql<{ table: boolean }[]>`SELECT to_regclass('journal_lot') IS NOT NULL AS table`
const [{ coupure }] = table
  ? await sql<{ coupure: Date }[]>`SELECT COALESCE(min(le) FILTER (WHERE source = 'geste'), now()) AS coupure FROM journal_lot`
  : [{ coupure: new Date() }]
const deja = new Set(table ? (await sql<{ id: number }[]>`
  SELECT DISTINCT idsuivilot AS id FROM journal_lot WHERE source = 'historique'`).map((r) => Number(r.id)) : [])

const rows = await sql<{ le: Date; idutilisateur: number; methode: string; chemin: string; corps: string | null; nom: string | null }[]>`
  SELECT j.le, j.idutilisateur, j.methode, j.chemin, j.corps, trim(concat(u.prenom, ' ', u.nom)) AS nom
  FROM journal_activite j LEFT JOIN utilisateur u ON u.idutilisateur = j.idutilisateur
  WHERE j.statut BETWEEN 200 AND 299 AND j.le < ${coupure}
    AND ((j.methode = 'PUT' AND j.chemin ~ '^/api/suivi-lots/[0-9]+$')
      OR (j.methode = 'POST' AND j.chemin ~ '^/api/suivi-lots/[0-9]+/etat$')
      OR (j.methode = 'POST' AND j.chemin ~ '^/api/commandes-sous-traitant/[0-9]+/lignes/[0-9]+/pieces/fini$'))
  ORDER BY j.le`

// Lots by line, to place a reception (the body carries the lot's name).
const lots = await sql<{ id: number; ligne: number; lot: string }[]>`
  SELECT idsuivilot AS id, COALESCE(idligne_commande_sous_traitant, 0)::bigint AS ligne, trim(lot::text) AS lot FROM suivilot`
const parLigne = new Map<number, Array<{ id: number; cle: string }>>()
for (const l of lots) {
  const a = parLigne.get(Number(l.ligne)) ?? []
  a.push({ id: Number(l.id), cle: cleLot(l.lot) })
  parLigne.set(Number(l.ligne), a)
}

const corps = (c: string | null): Record<string, unknown> => { try { return c ? JSON.parse(c) : {} } catch { return {} } }
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const mesuresDe = (b: Record<string, unknown>): MesuresLot => ({
  laize_sst: n(b.laize_sst), poids_sst: n(b.poids_sst), stabh_sst: n(b.stabH_sst), stabl_sst: n(b.stabL_sst), vrillage_sst: n(b.vrillage_sst),
  laize_tirelle: n(b.laize_tirelle), poids_tirelle: n(b.poids_tirelle), stabh_tirelle: n(b.stabH_tirelle), stabl_tirelle: n(b.stabL_tirelle), vrillage_tirelle: n(b.vrillage_tirelle),
  coloris_tirelle: typeof b.coloris_tirelle === 'string' ? b.coloris_tirelle : null,
})

interface Ajout { id: number; evenement: string; detail: string | null; par_id: number; par: string | null; le: Date }
const ajouts: Ajout[] = []
const dernier = new Map<number, MesuresLot>()
for (const r of rows) {
  const b = corps(r.corps)
  const par = { par_id: Number(r.idutilisateur) || 0, par: r.nom || null, le: r.le }
  let m = /^\/api\/suivi-lots\/(\d+)$/.exec(r.chemin)
  if (m) {
    const id = Number(m[1])
    const apres = mesuresDe(b)
    const avant = dernier.get(id) ?? null
    dernier.set(id, apres)
    if (deja.has(id)) continue
    const sst = changementsCote(avant, apres, 'sst')
    if (sst) ajouts.push({ id, evenement: 'mesures_ennoblisseur', detail: sst, ...par })
    const tir = changementsCote(avant, apres, 'tirelle')
    if (tir) ajouts.push({ id, evenement: 'mesures_malterre', detail: tir, ...par })
    if ('coloris_tirelle' in b && (avant?.coloris_tirelle ?? null) !== apres.coloris_tirelle) {
      const v = apres.coloris_tirelle
      ajouts.push({ id, evenement: 'coloris_malterre', detail: v === 'conforme' ? 'Conforme au rond 0' : v === 'ecart' ? 'Écart avec le rond 0' : 'Effacé', ...par })
    }
    continue
  }
  m = /^\/api\/suivi-lots\/(\d+)\/etat$/.exec(r.chemin)
  if (m) {
    const id = Number(m[1])
    if (!deja.has(id) && Number(b.etat) === 3) ajouts.push({ id, evenement: 'etat', detail: 'Lot validé', ...par })
    continue
  }
  m = /\/lignes\/(\d+)\/pieces\/fini$/.exec(r.chemin)
  if (m && typeof b.lot === 'string' && b.lot.trim()) {
    const cle = cleLot(b.lot)
    const lot = (parLigne.get(Number(m[1])) ?? []).find((l) => l.cle === cle)
    if (lot && !deja.has(lot.id)) ajouts.push({ id: lot.id, evenement: 'reception', detail: b.numero ? String(b.numero) : null, ...par })
  }
}

const parType = new Map<string, number>()
for (const a of ajouts) parType.set(a.evenement, (parType.get(a.evenement) ?? 0) + 1)
console.log(`Coupure : ${coupure.toISOString()} · ${deja.size} lot(s) déjà repris`)
for (const [t, c] of parType) console.log(`  ${t.padEnd(22)} ${c}`)
console.log(`${ajouts.length} ligne(s) sur ${new Set(ajouts.map((a) => a.id)).size} lot(s).`)

// ── Orders ──
const [{ tableCmd }] = await sql<{ tableCmd: boolean }[]>`SELECT to_regclass('journal_commande_sst') IS NOT NULL AS "tableCmd"`
const [{ coupureCmd }] = tableCmd
  ? await sql<{ coupureCmd: Date }[]>`SELECT COALESCE(min(le) FILTER (WHERE source = 'geste'), now()) AS "coupureCmd" FROM journal_commande_sst`
  : [{ coupureCmd: new Date() }]
const dejaCmd = new Set(tableCmd ? (await sql<{ id: number }[]>`
  SELECT DISTINCT idcommande_sous_traitant AS id FROM journal_commande_sst WHERE source = 'historique'`).map((r) => Number(r.id)) : [])
const rowsCmd = await sql<{ le: Date; idutilisateur: number; chemin: string; corps: string | null; nom: string | null }[]>`
  SELECT j.le, j.idutilisateur, j.chemin, j.corps, trim(concat(u.prenom, ' ', u.nom)) AS nom
  FROM journal_activite j LEFT JOIN utilisateur u ON u.idutilisateur = j.idutilisateur
  WHERE j.statut BETWEEN 200 AND 299 AND j.le < ${coupureCmd}
    AND ((j.methode = 'POST' AND j.chemin ~ '^/api/commandes-sous-traitant/[0-9]+/email$')
      OR (j.methode = 'PUT' AND j.chemin ~ '^/api/commandes-sous-traitant/[0-9]+/etat$'))
  ORDER BY j.le`
const ajoutsCmd: Ajout[] = []
for (const r of rowsCmd) {
  const m = /^\/api\/commandes-sous-traitant\/(\d+)\/(email|etat)$/.exec(r.chemin)
  if (!m || dejaCmd.has(Number(m[1]))) continue
  const par = { par_id: Number(r.idutilisateur) || 0, par: r.nom || null, le: r.le }
  if (m[2] === 'email') ajoutsCmd.push({ id: Number(m[1]), evenement: 'bon_commande', detail: null, ...par })
  else ajoutsCmd.push({ id: Number(m[1]), evenement: 'etat', detail: Number(corps(r.corps).est_soldee) ? 'Commande clôturée' : 'Commande rouverte', ...par })
}
console.log(`Commandes — coupure : ${coupureCmd.toISOString()} · ${ajoutsCmd.length} ligne(s) sur ${new Set(ajoutsCmd.map((a) => a.id)).size} commande(s).`)

if (write && ajoutsCmd.length && tableCmd) {
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql
    for (const a of ajoutsCmd) {
      await tx`
        INSERT INTO journal_commande_sst (idcommande_sous_traitant, evenement, detail, par_id, par, le, source)
        VALUES (${a.id}, ${a.evenement}, ${a.detail}, ${a.par_id}, ${a.par}, ${a.le}, 'historique')`
    }
  })
}

if (write && ajouts.length) {
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql // postgres.js typing: TransactionSql loses its call signatures
    for (const a of ajouts) {
      await tx`
        INSERT INTO journal_lot (idsuivilot, evenement, detail, par_id, par, le, source)
        VALUES (${a.id}, ${a.evenement}, ${a.detail}, ${a.par_id}, ${a.par}, ${a.le}, 'historique')`
    }
  })
  console.log('Écrit.')
}
await closeMpsPg()
