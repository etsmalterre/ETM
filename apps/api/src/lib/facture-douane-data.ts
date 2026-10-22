// Loader of the « Facturation douanière » blocks (rules: lib/facture-douane.ts).
// facture line → ligne_expedition (the avis) → the pieces shipped on it
// (stock_fini.IDligne_expedition / stock_ecru.IDligne_expedition_ETM, the same
// two roads as the avis totals in routes/expeditions.ts) → the client line's
// reference + coloris → finish and matière composition → HS code.

import { query, fixEncoding } from './hfsql-auto.js'
import { pickVal } from './accented-keys.js'
import { chooseCompositionRows, composeMatieres, repairMatiereLibelle, type MatiereShare } from './composition-matieres.js'
import { blocsDouane, codeHs, finitionDe, type BlocDouane, type PieceDouane } from './facture-douane.js'

const inList = (ids: Iterable<number>) => Array.from(new Set(ids)).filter((x) => x > 0)

/** Does this client get the customs blocks on its invoices? */
export async function clientFacturationDouaniere(IDclient: number): Promise<boolean> {
  if (!(IDclient > 0)) return false
  const rows = await query<{ facturation_douaniere: number | null }>(
    `SELECT facturation_douaniere FROM client WHERE IDclient = ${IDclient}`,
  )
  return (Number(rows[0]?.facturation_douaniere) || 0) === 1
}

/** Matière shares of each (écru, écru coloris) asked, batched. */
async function loadMatieres(keys: Array<{ IDref_ecru: number; IDcolori_ecru: number }>): Promise<Map<string, MatiereShare[]>> {
  const out = new Map<string, MatiereShare[]>()
  const ecruIds = inList(keys.map((k) => k.IDref_ecru))
  if (ecruIds.length === 0) return out
  const comp = await query<{ IDref_ecru: number; IDcolori_ecru: number; IDref_fil: number; pourcentage: number | null }>(
    `SELECT IDref_ecru, IDcolori_ecru, IDref_fil, pourcentage FROM composition_ecru WHERE IDref_ecru IN (${ecruIds.join(',')})`,
  )
  const filIds = inList(comp.map((c) => Number(c.IDref_fil) || 0))
  // asso_fil_matiere / matiere_premiere have accented column NAMES: SELECT *,
  // keys read by prefix (same as routes/references-fini.ts).
  const assoByFil = new Map<number, Array<{ matiereId: number; frac: number }>>()
  if (filIds.length > 0) {
    const asso = await query<Record<string, unknown>>(`SELECT * FROM asso_fil_matiere WHERE IDRef_fil IN (${filIds.join(',')})`)
    for (const a of asso) {
      const filId = Number(pickVal(a, /^idref_fil/i)) || 0
      const matiereId = Number(pickVal(a, /^idmati/i)) || 0
      const frac = Number(a.pourcentage) || 0
      if (filId <= 0 || matiereId <= 0 || frac <= 0) continue
      const arr = assoByFil.get(filId) ?? []
      arr.push({ matiereId, frac })
      assoByFil.set(filId, arr)
    }
  }
  const libelleById = new Map<number, string>()
  if (assoByFil.size > 0) {
    for (const m of await query<Record<string, unknown>>(`SELECT * FROM matiere_premiere`)) {
      const id = Number(pickVal(m, /^idmati/i)) || 0
      const lib = repairMatiereLibelle(m.libelle)
      if (id > 0 && lib) libelleById.set(id, lib)
    }
  }
  for (const k of keys) {
    const key = `${k.IDref_ecru}:${k.IDcolori_ecru}`
    if (out.has(key)) continue
    const rows = comp
      .filter((c) => Number(c.IDref_ecru) === k.IDref_ecru)
      .map((c) => ({ IDcolori_ecru: Number(c.IDcolori_ecru) || 0, IDref_fil: Number(c.IDref_fil) || 0, pourcentage: c.pourcentage }))
    out.set(key, composeMatieres(chooseCompositionRows(rows, k.IDcolori_ecru), assoByFil, libelleById))
  }
  return out
}

/** The customs blocks of an invoice, from the IDligne_expedition of its lines
 *  (manual lines carry 0 and add nothing). */
export async function loadBlocsDouane(leIdsFacture: number[]): Promise<BlocDouane[]> {
  const leIds = inList(leIdsFacture)
  if (leIds.length === 0) return []
  const le = await query<{ IDligne_expedition: number; IDexpedition: number; IDligne_commande_client: number }>(
    `SELECT IDligne_expedition, IDexpedition, IDligne_commande_client FROM ligne_expedition WHERE IDligne_expedition IN (${leIds.join(',')})`,
  )
  const leById = new Map(le.map((r) => [Number(r.IDligne_expedition), { avis: Number(r.IDexpedition) || 0, lcc: Number(r.IDligne_commande_client) || 0 }]))
  const [fini, ecru] = await Promise.all([
    query<{ le: number; poids: number | null }>(`SELECT IDligne_expedition AS le, poids FROM stock_fini WHERE IDligne_expedition IN (${leIds.join(',')})`),
    query<{ le: number; poids: number | null }>(`SELECT IDligne_expedition_ETM AS le, poids FROM stock_ecru WHERE IDligne_expedition_ETM IN (${leIds.join(',')})`),
  ])

  // The client line says what was sold: TYPE 1 écru (ref_ecru + colori_ecru),
  // TYPE 2 fini (ref_fini; coloris catalog by avec_teinture — #1158).
  const lccIds = inList([...leById.values()].map((v) => v.lcc))
  const lccs = lccIds.length === 0 ? [] : await query<{ IDligne_commande_client: number; type_kind: number; IDreference: number; IDcolori: number }>(
    `SELECT IDligne_commande_client, TYPE AS type_kind, IDreference, IDcolori FROM ligne_commande_client WHERE IDligne_commande_client IN (${lccIds.join(',')})`,
  )
  const lccById = new Map(lccs.map((r) => [Number(r.IDligne_commande_client), {
    type: Number(r.type_kind) || 0, ref: Number(r.IDreference) || 0, colori: Number(r.IDcolori) || 0,
  }]))
  const finiRefIds = inList(lccs.filter((r) => Number(r.type_kind) === 2).map((r) => Number(r.IDreference) || 0))
  const finiRefs = new Map<number, { avecTeinture: number; IDref_ecru: number; IDcolori_ecru: number }>()
  if (finiRefIds.length > 0) {
    const rows = await query<{ IDref_fini: number; avec_teinture: number | null; IDref_ecru: number | null; IDcolori_ecru: number | null }>(
      `SELECT IDref_fini, avec_teinture, IDref_ecru, IDcolori_ecru FROM ref_fini WHERE IDref_fini IN (${finiRefIds.join(',')})`,
    )
    for (const r of rows) finiRefs.set(Number(r.IDref_fini), {
      avecTeinture: Number(r.avec_teinture) || 0, IDref_ecru: Number(r.IDref_ecru) || 0, IDcolori_ecru: Number(r.IDcolori_ecru) || 0,
    })
  }
  // Only a dyed fini's coloris matters (« Blanc »): ref_fini_colori.
  const dyedColoriIds = inList(lccs
    .filter((r) => Number(r.type_kind) === 2 && (finiRefs.get(Number(r.IDreference))?.avecTeinture ?? 0) !== 0)
    .map((r) => Number(r.IDcolori) || 0))
  const colorisFini = new Map<number, string>()
  if (dyedColoriIds.length > 0) {
    const rows = await query<{ IDref_fini_colori: number; reference: string | null }>(
      `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${dyedColoriIds.join(',')})`,
    )
    for (const r of await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))
      colorisFini.set(Number(r.IDref_fini_colori), String(r.reference ?? ''))
  }

  // Per client line: the écru whose composition applies, and the finish.
  const parLcc = new Map<number, { IDref_ecru: number; IDcolori_ecru: number; finition: ReturnType<typeof finitionDe> } | null>()
  for (const [id, l] of lccById) {
    if (l.type === 1) {
      parLcc.set(id, { IDref_ecru: l.ref, IDcolori_ecru: l.colori, finition: finitionDe({ kind: 'ecru', avecTeinture: 0, coloris: '' }) })
    } else if (l.type === 2 && finiRefs.has(l.ref)) {
      const f = finiRefs.get(l.ref)!
      // A washed fini keeps its écru coloris on the line (#1158); a dyed one
      // knits the fiche's écru coloris.
      const IDcolori_ecru = f.avecTeinture === 0 ? (l.colori || f.IDcolori_ecru) : f.IDcolori_ecru
      parLcc.set(id, {
        IDref_ecru: f.IDref_ecru, IDcolori_ecru,
        finition: finitionDe({ kind: 'fini', avecTeinture: f.avecTeinture, coloris: colorisFini.get(l.colori) ?? '' }),
      })
    } else parLcc.set(id, null)
  }
  const matieres = await loadMatieres([...parLcc.values()].filter((v): v is NonNullable<typeof v> => v !== null))

  const pieces: PieceDouane[] = []
  for (const r of [...fini, ...ecru]) {
    const l = leById.get(Number(r.le))
    if (!l || l.avis <= 0) continue
    const p = parLcc.get(l.lcc) ?? null
    const hs = p ? codeHs(matieres.get(`${p.IDref_ecru}:${p.IDcolori_ecru}`) ?? [], p.finition) : null
    pieces.push({ avis: l.avis, poids: Number(r.poids) || 0, hs })
  }
  return blocsDouane(pieces)
}
