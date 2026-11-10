// A sous-traitant's délai is an engagement (LIVA #1364, Vincent 2026-11-10) — the
// same rule as a client line's date (lib/report-ligne-client.ts):
//   - the FIRST date a line gets is the sous-traitant's engagement, frozen in
//     ligne_commande_sous_traitant.date_delai (sstDelaiSets in lib/sst-shared.ts).
//     « We never type a date ourselves, except a délai the dyer gave by phone »:
//     a date typed at the line's creation counts too;
//   - pushing the date LATER afterwards is a « report »: a motif and who it is due
//     to (the sous-traitant, or Malterre: yarn not there, client undecided…),
//     recorded as a `report_delai` row of delai_sst_evenement (append-only,
//     migration 0073). Bringing it earlier needs nothing: good news is free;
//   - the delay a line carries = working days from the engagement to the current
//     date, in the sous-traitant's own calendar. Clients › Commandes prints it
//     (« retard MATEL 3 j ») and reads its earliest date from the current délai.
// The Tricobot Délais skill writing a later date files the report itself, due to
// the sous-traitant, its motif quoting the mail (lib/agents/flux-ennoblisseur).

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { joursOuvresEntre, type Periode } from './jours-ouvres.js'
import type { Imputable } from './delai-sst.js'

export const IMPUTABLES_DELAI: readonly Imputable[] = ['sous_traitant', 'malterre']

const ymd = (v: unknown): string => {
  const s = typeof v === 'string' ? v.replace(/-/g, '').slice(0, 8) : ''
  return /^\d{8}$/.test(s) ? s : ''
}

/** The date a new one is compared with: the current date, else the engagement
 *  (a line whose date was cleared keeps its engagement). YYYYMMDD or ''. */
export function dateDeReference(dateLivraison: unknown, dateDelai: unknown): string {
  return ymd(dateLivraison) || ymd(dateDelai)
}

/** True when writing `nouvelle` is a report: a date was already given and the
 *  new one is later. Clearing the date or bringing it earlier is not. */
export function estUnReportDelai(dateLivraison: unknown, dateDelai: unknown, nouvelle: unknown): boolean {
  const avant = dateDeReference(dateLivraison, dateDelai)
  const apres = ymd(nouvelle)
  return !!avant && !!apres && apres > avant
}

/** Working days the current délai is behind the engagement (0 when on time or
 *  earlier, null without both dates). In the sous-traitant's calendar. */
export function retardDelai(engagement: unknown, actuel: unknown, fermetures: readonly Periode[] = []): number | null {
  const e = ymd(engagement)
  const a = ymd(actuel)
  if (!e || !a) return null
  return a > e ? joursOuvresEntre(e, a, fermetures) : 0
}

export interface ReportDelai {
  motif: string
  imputable: Imputable
}

/** Reads the `report` object of a request body; null when absent or incomplete. */
export function lireReport(v: unknown): ReportDelai | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const motif = typeof r.motif === 'string' ? r.motif.trim().slice(0, 1000) : ''
  const imputable = IMPUTABLES_DELAI.find((i) => i === r.imputable)
  return motif && imputable ? { motif, imputable } : null
}

/** Records one report. Call after the line's UPDATE. Throws: the caller decides
 *  whether the write it follows is the person's (route) or the agent's. */
export async function enregistrerReportDelai(p: {
  idligne: number
  ancien: string
  nouveau: string
  motif: string
  imputable: Imputable
  par: { id: number; nom: string | null } | null
}, sql: Sql = mpsPg()): Promise<void> {
  const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  const [l] = await sql<{ cmd: number }[]>`
    SELECT idcommande_sous_traitant AS cmd FROM ligne_commande_sous_traitant WHERE idligne_commande_sous_traitant = ${p.idligne}`
  if (!l) return
  await sql`
    INSERT INTO delai_sst_evenement (idcommande_sous_traitant, idligne_commande_sous_traitant, type, ancien_delai, delai_donne, motif, imputable, par_id, par)
    VALUES (${Number(l.cmd)}, ${p.idligne}, 'report_delai', ${iso(p.ancien)}::date, ${iso(p.nouveau)}::date, ${p.motif}, ${p.imputable}, ${p.par?.id ?? 0}, ${p.par?.nom ?? null})`
}

export interface ReportDelaiLigne {
  le: string
  /** YYYYMMDD */
  ancien: string
  nouveau: string
  motif: string
  imputable: Imputable
  par: string | null
}

/** Every report per line, oldest first. */
export async function reportsDelaiParLigne(ids: readonly number[], sql: Sql = mpsPg()): Promise<Map<number, ReportDelaiLigne[]>> {
  const out = new Map<number, ReportDelaiLigne[]>()
  const ok = [...new Set(ids.filter((x) => x > 0))]
  if (ok.length === 0) return out
  const rows = await sql<{ idl: number; le: Date; a: string; n: string; motif: string; imputable: Imputable; par: string | null }[]>`
    SELECT idligne_commande_sous_traitant AS idl, le, to_char(ancien_delai, 'YYYYMMDD') AS a, to_char(delai_donne, 'YYYYMMDD') AS n,
           motif, imputable, par
      FROM delai_sst_evenement
     WHERE type = 'report_delai' AND idligne_commande_sous_traitant = ANY(${ok as any})
     ORDER BY le, id`
  for (const r of rows) {
    const arr = out.get(Number(r.idl)) ?? []
    arr.push({ le: new Date(r.le).toISOString(), ancien: r.a, nouveau: r.n, motif: r.motif, imputable: r.imputable, par: r.par })
    out.set(Number(r.idl), arr)
  }
  return out
}
