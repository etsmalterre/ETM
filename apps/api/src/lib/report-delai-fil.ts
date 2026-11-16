// A yarn supplier's delivery date is an engagement (Vincent 2026-11-16) — the rule
// of a sous-traitant's délai (lib/report-delai-sst.ts) and of a client line's date
// (lib/report-ligne-client.ts), applied to Fils › Commandes:
//   - the FIRST date a yarn order line gets is the supplier's engagement, frozen in
//     ref_fil_commande.date_delai (a date typed at the line's creation counts);
//   - pushing the date LATER afterwards is a « report »: a motif and who it is due
//     to (the supplier, or Malterre), one row of report_delai_fil (append-only,
//     migration 0075). Without them the write is refused (400 report_requis);
//   - an EARLIER date is free: the engagement does not move, the yarn is simply
//     announced sooner and the client lines waiting for it read a better date;
//   - the day the engagement is given, the date is still corrected freely (a typo):
//     the correction IS the engagement, no report;
//   - the delay a line carries = working days from the engagement to the current
//     date. Clients › Commandes prints it on the « Fil » step of a line's earliest
//     date (« Retard fournisseur Mundifios : 5 j ») and reads that date from the
//     current one (lib/delai-au-plus-tot.ts).

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { joursOuvresEntre } from './jours-ouvres.js'

export const IMPUTABLES_FIL = ['fournisseur', 'malterre'] as const
export type ImputableFil = (typeof IMPUTABLES_FIL)[number]

const ymd = (v: unknown): string => {
  const s = typeof v === 'string' ? v.replace(/-/g, '').slice(0, 8) : ''
  return /^\d{8}$/.test(s) ? s : ''
}

export interface DelaiFilActuel {
  /** YYYYMMDD the line's current date, '' / null for none */
  date_livraison: string | null
  /** YYYYMMDD the engagement, '' / null while none was given */
  date_delai: string | null
  /** YYYYMMDD (Europe/Paris) the day the engagement was given, null on lines dated before 2026-11-16 */
  donne_le: string | null
}

export type EcritureDelaiFil =
  /** same date, or cleared: the engagement stays as it is */
  | { type: 'inchange' }
  /** the first date, or a correction the day it was given: it becomes the engagement */
  | { type: 'engagement'; date: string }
  /** an earlier date: free, the engagement does not move */
  | { type: 'avance'; date: string }
  /** a later date: motif + imputable required */
  | { type: 'report'; ancien: string; date: string }

/** Pure: what writing `nouvelle` on a line means. `aujourdhui` = YYYYMMDD, Europe/Paris. */
export function ecritureDelaiFil(cur: DelaiFilActuel, nouvelle: unknown, aujourdhui: string): EcritureDelaiFil {
  const apres = ymd(nouvelle)
  const engagement = ymd(cur.date_delai)
  const avant = ymd(cur.date_livraison) || engagement
  if (!apres || apres === ymd(cur.date_livraison)) return { type: 'inchange' }
  if (!engagement || ymd(cur.donne_le) === aujourdhui) return { type: 'engagement', date: apres }
  return apres > avant ? { type: 'report', ancien: avant, date: apres } : { type: 'avance', date: apres }
}

/** Working days the current date is behind the engagement (0 when on time or earlier). */
export function retardFil(engagement: unknown, actuel: unknown): number {
  const e = ymd(engagement)
  const a = ymd(actuel)
  return e && a && a > e ? joursOuvresEntre(e, a) : 0
}

export interface ReportFil {
  motif: string
  imputable: ImputableFil
}

/** Reads the `report` object of a request body; null when absent or incomplete. */
export function lireReportFil(v: unknown): ReportFil | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const motif = typeof r.motif === 'string' ? r.motif.trim().slice(0, 1000) : ''
  const imputable = IMPUTABLES_FIL.find((i) => i === r.imputable)
  return motif && imputable ? { motif, imputable } : null
}

export const MESSAGE_REPORT_REQUIS = (ancien: string): string =>
  `La livraison du ${ancien.slice(6, 8)}/${ancien.slice(4, 6)}/${ancien.slice(0, 4)} est un engagement du fournisseur : indiquez pourquoi elle est repoussée et à qui c’est dû.`

// ── I/O ─────────────────────────────────────────────────────

const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`

/** The délai facts of these order lines (unknown ids absent). */
export async function delaisFil(ids: readonly number[], sql: Sql = mpsPg()): Promise<Map<number, DelaiFilActuel>> {
  const out = new Map<number, DelaiFilActuel>()
  const ok = [...new Set(ids.filter((x) => x > 0))]
  if (ok.length === 0) return out
  const rows = await sql<{ id: number; d: string | null; e: string | null; le: string | null }[]>`
    SELECT idref_fil_commande AS id, to_char(date_livraison, 'YYYYMMDD') AS d, to_char(date_delai, 'YYYYMMDD') AS e,
           to_char(delai_donne_le AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS le
      FROM ref_fil_commande WHERE idref_fil_commande = ANY(${ok as any})`
  for (const r of rows) out.set(Number(r.id), { date_livraison: r.d, date_delai: r.e, donne_le: r.le })
  return out
}

/** Freezes (or corrects, the same day) the engagement of a line. Call after the line's own write. */
export async function fixerEngagementFil(idligne: number, date: string, sql: Sql = mpsPg()): Promise<void> {
  await sql`UPDATE ref_fil_commande SET date_delai = ${iso(date)}::date, delai_donne_le = COALESCE(delai_donne_le, now())
             WHERE idref_fil_commande = ${idligne}`
}

/** Records one report. Call after the line's UPDATE. */
export async function enregistrerReportFil(p: {
  idligne: number
  idcommande: number
  ancien: string
  nouveau: string
  motif: string
  imputable: ImputableFil
  par: { id: number; nom: string | null } | null
}, sql: Sql = mpsPg()): Promise<void> {
  await sql`
    INSERT INTO report_delai_fil (idref_fil_commande, idcommande_fil, ancien_delai, nouveau_delai, motif, imputable, par_id, par)
    VALUES (${p.idligne}, ${p.idcommande}, ${iso(p.ancien)}::date, ${iso(p.nouveau)}::date, ${p.motif}, ${p.imputable}, ${p.par?.id ?? 0}, ${p.par?.nom ?? null})`
}

export interface ReportFilLigne {
  le: string
  /** YYYYMMDD */
  ancien: string
  nouveau: string
  motif: string
  imputable: ImputableFil
  par: string | null
}

/** Every report per line, oldest first. */
export async function reportsFilParLigne(ids: readonly number[], sql: Sql = mpsPg()): Promise<Map<number, ReportFilLigne[]>> {
  const out = new Map<number, ReportFilLigne[]>()
  const ok = [...new Set(ids.filter((x) => x > 0))]
  if (ok.length === 0) return out
  const rows = await sql<{ idl: number; le: Date; a: string; n: string; motif: string; imputable: ImputableFil; par: string | null }[]>`
    SELECT idref_fil_commande AS idl, le, to_char(ancien_delai, 'YYYYMMDD') AS a, to_char(nouveau_delai, 'YYYYMMDD') AS n,
           motif, imputable, par
      FROM report_delai_fil WHERE idref_fil_commande = ANY(${ok as any})
     ORDER BY le, id`
  for (const r of rows) {
    const arr = out.get(Number(r.idl)) ?? []
    arr.push({ le: new Date(r.le).toISOString(), ancien: r.a, nouveau: r.n, motif: r.motif, imputable: r.imputable, par: r.par })
    out.set(Number(r.idl), arr)
  }
  return out
}
