// Matière composition of an écru ("62 % coton recyclé, 38 % polyester …"),
// shared by the fiche technique (routes/references-fini.ts) and the website
// catalogue (lib/webservice-site-data.ts) so both print the same breakdown.
//
// composition_ecru gives the yarn mix (per écru, optionally per colori_ecru);
// asso_fil_matiere gives each yarn's matières as 0-1 fractions. A matière's
// share = Σ yarnShare × matièreFrac, merged by label. The legacy website query
// (REQ_Compo_Ecru_Detail) listed one line per yarn × matière and repeated a
// matière once per yarn (« coton recyclé 31, …, coton recyclé 19 »); merging is
// deliberate.

export interface CompositionRow {
  IDcolori_ecru: number
  IDref_fil: number
  pourcentage: number | null
}

export interface MatiereShare {
  matiere: string
  pourcentage: number
}

/** The composition rows that describe a reference: those scoped to its écru
 *  coloris, else the generic ones (IDcolori_ecru = 0), else whatever exists. */
export function chooseCompositionRows<T extends CompositionRow>(comp: readonly T[], IDcolori_ecru: number): T[] {
  let chosen = IDcolori_ecru > 0 ? comp.filter((r) => Number(r.IDcolori_ecru) === IDcolori_ecru) : []
  if (chosen.length === 0) chosen = comp.filter((r) => Number(r.IDcolori_ecru) === 0)
  if (chosen.length === 0) chosen = [...comp]
  return chosen
}

/** Merge the chosen rows into matière shares (percent, unrounded), largest
 *  first. `assoByFil` maps IDref_fil → its matières; `libelleById` maps a
 *  matière id to its (repaired) label. */
export function composeMatieres(
  chosen: readonly CompositionRow[],
  assoByFil: ReadonlyMap<number, readonly { matiereId: number; frac: number }[]>,
  libelleById: ReadonlyMap<number, string>,
): MatiereShare[] {
  const totalPct = chosen.reduce((s, r) => s + (Number(r.pourcentage) || 0), 0)
  if (!(totalPct > 0)) return []
  const pctByMatiere = new Map<string, number>()
  for (const row of chosen) {
    const share = (Number(row.pourcentage) || 0) / totalPct
    for (const a of assoByFil.get(Number(row.IDref_fil)) ?? []) {
      const lib = libelleById.get(a.matiereId)
      if (!lib) continue
      pctByMatiere.set(lib, (pctByMatiere.get(lib) ?? 0) + share * a.frac * 100)
    }
  }
  const out: MatiereShare[] = []
  for (const [matiere, pourcentage] of pctByMatiere) out.push({ matiere, pourcentage })
  out.sort((a, b) => b.pourcentage - a.pourcentage)
  return out
}

/** matiere_premiere's PK is accented, so fixEncoding can't repair `libelle`;
 *  « é » is the only accent that occurs in matière names (élasthanne,
 *  recyclé, polyéthylène…), so U+FFFD → é. */
export function repairMatiereLibelle(v: unknown): string {
  return String(v ?? '').replace(/�/g, 'é').trim()
}
