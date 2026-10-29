// Partner délai standards and closures (doctrine des délais §1-§2 and §4, Vincent 2026-10-29, migrations
// 0046-0047), in WORKING DAYS of the partner (doctrine §1). Set per sous-traitant in Sous-traitants › Gestion; a field left empty reads the doctrine's
// default below. They feed the earliest date of a client line (§5 ter): dyer = one standard (its queue,
// almost independent of the quantity), knitter = three bands by kg (machine time). The Malterre reserve is
// fixed in code (§4): 1.5 working weeks, never distributed.

import { mpsPg } from './mps-pg.js'

/** Doctrine §4, revised 2026-10-29: 1.5 working weeks, in working days. */
export const RESERVE_MALTERRE_JOURS = 7.5
/** Doctrine §4: the knitter gets the margin first, up to 4 working weeks. */
export const MARGE_TRICOTEUR_MAX_JOURS = 20

export interface StandardsSst {
  /** dyer: working days */
  ennoblissement_jours: number
  /** knitter bands: up to seuil1 kg → jours1, up to seuil2 → jours2, beyond → jours3 (working days) */
  tricot_seuil1_kg: number
  tricot_seuil2_kg: number
  tricot_jours1: number
  tricot_jours2: number
  tricot_jours3: number
}

/** Doctrine §2 (measured medians, decided as objectives). */
export const STANDARDS_DEFAUT: StandardsSst = {
  ennoblissement_jours: 15,
  tricot_seuil1_kg: 500,
  tricot_seuil2_kg: 1000,
  tricot_jours1: 5,
  tricot_jours2: 10,
  tricot_jours3: 15,
}

const CHAMPS = Object.keys(STANDARDS_DEFAUT) as (keyof StandardsSst)[]

export type StandardsStockes = { [K in keyof StandardsSst]: number | null }

export interface Fermeture { id: number; du: string; au: string; motif: string | null }

const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10)).replace(/-/g, '')

/** What is stored per partner (null = the default), for the settings screen. */
export async function standardsStockes(ids: readonly number[]): Promise<Map<number, StandardsStockes>> {
  const u = [...new Set(ids.filter((x) => x > 0))]
  const out = new Map<number, StandardsStockes>()
  if (u.length === 0) return out
  const rows = await mpsPg().unsafe<any[]>(
    `SELECT * FROM delai_standard_sst WHERE idsous_traitant = ANY($1::bigint[])`, [u as any])
  for (const r of rows) {
    const s = {} as StandardsStockes
    for (const k of CHAMPS) s[k] = r[k] == null ? null : Number(r[k])
    out.set(Number(r.idsous_traitant), s)
  }
  return out
}

/** The standards in force per partner: stored values, else the doctrine's. */
export async function standards(ids: readonly number[]): Promise<Map<number, StandardsSst>> {
  const stockes = await standardsStockes(ids)
  const out = new Map<number, StandardsSst>()
  for (const id of new Set(ids)) {
    const s = stockes.get(id)
    const eff = { ...STANDARDS_DEFAUT }
    if (s) for (const k of CHAMPS) if (s[k] != null) eff[k] = s[k] as number
    out.set(id, eff)
  }
  return out
}

/** Working days a knitter asks for `kg` (doctrine §2: three bands). */
export function tricotageJours(s: StandardsSst, kg: number): number {
  return kg <= s.tricot_seuil1_kg ? s.tricot_jours1 : kg <= s.tricot_seuil2_kg ? s.tricot_jours2 : s.tricot_jours3
}

/** Why a set of standards is refused (bands out of order, a non-positive figure), or null. */
export function refusStandards(s: StandardsSst): string | null {
  if (CHAMPS.some((k) => !(s[k] > 0))) return 'Chaque valeur doit être positive.'
  if (s.tricot_seuil2_kg <= s.tricot_seuil1_kg) return 'Le second seuil doit dépasser le premier.'
  return null
}

/** Writes a partner's standards; a null field goes back to the default (all null = the row is removed). */
export async function fixerStandards(id: number, s: StandardsStockes, par: string | null): Promise<void> {
  const sql = mpsPg()
  if (CHAMPS.every((k) => s[k] == null)) {
    await sql`DELETE FROM delai_standard_sst WHERE idsous_traitant = ${id}`
    return
  }
  await sql`
    INSERT INTO delai_standard_sst (idsous_traitant, ennoblissement_jours, tricot_seuil1_kg, tricot_seuil2_kg, tricot_jours1, tricot_jours2, tricot_jours3, modifie_par)
    VALUES (${id}, ${s.ennoblissement_jours}, ${s.tricot_seuil1_kg}, ${s.tricot_seuil2_kg}, ${s.tricot_jours1}, ${s.tricot_jours2}, ${s.tricot_jours3}, ${par})
    ON CONFLICT (idsous_traitant) DO UPDATE SET
      ennoblissement_jours = EXCLUDED.ennoblissement_jours, tricot_seuil1_kg = EXCLUDED.tricot_seuil1_kg,
      tricot_seuil2_kg = EXCLUDED.tricot_seuil2_kg, tricot_jours1 = EXCLUDED.tricot_jours1,
      tricot_jours2 = EXCLUDED.tricot_jours2, tricot_jours3 = EXCLUDED.tricot_jours3,
      modifie_le = now(), modifie_par = EXCLUDED.modifie_par`
}

/** Closures still to come or under way (au ≥ today unless `toutes`), oldest first. YYYYMMDD. */
export async function fermetures(ids: readonly number[], toutes = false): Promise<Map<number, Fermeture[]>> {
  const u = [...new Set(ids.filter((x) => x > 0))]
  const out = new Map<number, Fermeture[]>()
  if (u.length === 0) return out
  const rows = await mpsPg().unsafe<{ id: number; s: number; du: Date; au: Date; motif: string | null }[]>(
    `SELECT id, idsous_traitant AS s, du, au, motif FROM fermeture_sst
      WHERE idsous_traitant = ANY($1::bigint[]) ${toutes ? '' : 'AND au >= current_date'} ORDER BY du`, [u as any])
  for (const r of rows) {
    const arr = out.get(Number(r.s)) ?? []
    arr.push({ id: Number(r.id), du: ymd(r.du), au: ymd(r.au), motif: r.motif })
    out.set(Number(r.s), arr)
  }
  return out
}

const pg = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`

export async function ajouterFermeture(id: number, f: { du: string; au: string; motif: string | null }, par: string | null): Promise<void> {
  await mpsPg()`INSERT INTO fermeture_sst (idsous_traitant, du, au, motif, saisi_par) VALUES (${id}, ${pg(f.du)}::date, ${pg(f.au)}::date, ${f.motif}, ${par})`
}

export async function supprimerFermeture(id: number, fermetureId: number): Promise<boolean> {
  const r = await mpsPg()`DELETE FROM fermeture_sst WHERE id = ${fermetureId} AND idsous_traitant = ${id}`
  return r.count > 0
}
