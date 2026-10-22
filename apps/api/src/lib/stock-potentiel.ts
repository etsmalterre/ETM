// Finis › Stock potentiel — what Malterre can deliver from the stock it holds
// and nobody is waiting for (Vincent, 2026-10-22: « écouler les stocks
// morts »). One line = a quantity of a fini reference, three statuses:
//
//   dispo       fini rolls in stock, VALIDÉ (état 3 — the only shippable
//               state, #1235), not affected to a client line, not given
//   a_valider   the same rolls still en contrôle / en reprise / en attente de
//               décision: sellable once the check is done, never promised as
//               ready (Vincent, 2026-10-22)
//   a_ennoblir  free écru (tombé de métier) × the fini's rendement
//   a_tricoter  free yarn through the écru's composition × the rendement
//
// Every quantity is « jusqu'à » — the same écru or yarn feeds several fini
// references, so the lines are NOT additive (decided 2026-10-22) and the
// screen shows no total over the potential ones. Only stock on hand counts:
// yarn on order is by definition not dead stock (Vincent, same day).
//
// Which écru coloris feeds a fini follows the client-line Ennoblir/Tricotage
// panels (routes/commandes-client.ts `ennoInputColoriIds`): a dyed fini
// (avec_teinture 1/2) takes the natural « ecru » base and can become any
// coloris (one « Tous coloris » line); a wash-only fini (0) keeps its écru's
// coloris (one line per écru coloris). Écru kg → Ml = kg × ref_fini.rendement,
// as everywhere else in ETM. Pure — the loader is in routes/stock-potentiel.ts.

export type StatutPotentiel = 'dispo' | 'a_valider' | 'a_ennoblir' | 'a_tricoter'

/** stock_fini.IDetat_stock_fini of a shippable roll. */
export const ETAT_VALIDE = 3
const LIBELLE_ETAT: Record<number, string> = { 1: 'en contrôle', 2: 'en reprise', 5: 'attente de décision' }

export interface RefFiniPotentiel {
  idref_fini: number
  reference: string
  designation: string | null
  idref_ecru: number
  /** Ml per kg; 0 = unknown, the line then carries kg only. */
  rendement: number
  avec_teinture: number
  /** g/m² (ref_fini.poids_moy, the Grammage of Finis › Stock); null = unknown. */
  grammage: number | null
  /** The écru's contexture (« jersey vanisé »), as Finis › Stock shows it. */
  contexture: string | null
  /** ref_ecru.bio / ref_ecru.recycle — the écru's certification, which the
   *  fini made from it carries. */
  bio: boolean
  recycle: boolean
}

export interface ColorisEcru {
  idcolori_ecru: number
  idref_ecru: number
  reference: string
}

/** One fini roll in stock and free (filters applied by the loader). */
export interface FiniLibre {
  idref_fini: number
  idcoloris: number
  poids: number
  metrage: number
  etat: number
  second_choix: boolean
}

/** One écru piece in stock and free. */
export interface EcruLibre {
  idref_ecru: number
  idcolori_ecru: number
  poids: number
  second_choix: boolean
}

export interface CompositionRow {
  idref_ecru: number
  idcolori_ecru: number
  idref_fil: number
  idcolori_fil: number
  pourcentage: number
}

export interface LignePotentiel {
  key: string
  statut: StatutPotentiel
  idref_fini: number
  reference: string
  designation: string | null
  grammage: number | null
  contexture: string | null
  bio: boolean
  recycle: boolean
  /** The fini coloris; null on a « Tous coloris » line. */
  coloris: string | null
  /** Its id in the fini's coloris catalog (ref_fini_colori, or colori_ecru
   *  for a wash-only fini) — what the price is computed for; null = any. */
  idcoloris: number | null
  tous_coloris: boolean
  /** dispo / a_valider: the rolls are 2nd choice (a separate line). */
  second_choix: boolean
  /** « 029 · ecru » — the écru the line is (or would be) made from. */
  ecru: string | null
  /** Ml; null when the reference has no rendement. */
  metrage: number | null
  /** Fini kg (dispo) or écru kg (potential lines). */
  poids: number
  /** Rolls (dispo) or écru pieces (a_ennoblir); null for a_tricoter. */
  pieces: number | null
  /** a_tricoter: the yarn that runs out first. */
  limite: string | null
  /** a_valider: rolls per état (« en contrôle » → 3). a_ennoblir: écru
   *  pieces in 2nd choice under « 2e choix ». Empty otherwise. */
  repartition: Record<string, number>
}

export interface StockPotentielInput {
  refsFini: RefFiniPotentiel[]
  refsEcru: Map<number, string>
  colorisEcru: ColorisEcru[]
  /** ref_fini_colori id → reference (coloris of dyed finis). */
  colorisFini: Map<number, string>
  finisLibres: FiniLibre[]
  ecruLibre: EcruLibre[]
  compositions: CompositionRow[]
  /** `${idref_fil}:${idcolori_fil}` → free kg (stock − réservé, ≥ 0). */
  filLibre: Map<string, number>
  /** Same key → « coton bio 30/1 ecru ». */
  filLabel: Map<string, string>
}

const round1 = (n: number) => Math.round(n * 10) / 10
const pairKey = (rf: number, cf: number) => `${rf}:${cf}`

/** The natural undyed base a dyed fini is made from (legacy `reference = 'ecru'`). */
export function estColorisNaturel(reference: string): boolean {
  return reference.trim().toLowerCase() === 'ecru'
}

/** Écru kg the free yarn can still knit for one écru coloris, and the yarn
 *  that limits it. The coloris recipe wins (#1205); the reference's own
 *  recipe only when the coloris has none AND it names yarn colours. Positions
 *  sharing a yarn are summed. null = no usable recipe. */
export function kgTricotable(
  recette: CompositionRow[],
  filLibre: Map<string, number>,
): { kg: number; limite: string } | null {
  const parPaire = new Map<string, number>()
  for (const r of recette) {
    if (r.idref_fil <= 0 || !(r.pourcentage > 0)) continue
    const k = pairKey(r.idref_fil, r.idcolori_fil)
    parPaire.set(k, (parPaire.get(k) ?? 0) + r.pourcentage)
  }
  if (parPaire.size === 0) return null
  let kg = Infinity
  let limite = ''
  for (const [k, pct] of parPaire) {
    const possible = Math.max(0, filLibre.get(k) ?? 0) / (pct / 100)
    if (possible < kg) {
      kg = possible
      limite = k
    }
  }
  return { kg, limite }
}

/** The recipe to knit one écru coloris with (see kgTricotable). */
export function recetteColoris(compositions: CompositionRow[], idrefEcru: number, idcoloriEcru: number): CompositionRow[] {
  const duColoris = compositions.filter((c) => c.idref_ecru === idrefEcru && c.idcolori_ecru === idcoloriEcru && c.idref_fil > 0)
  if (duColoris.length > 0) return duColoris
  const deLaRef = compositions.filter((c) => c.idref_ecru === idrefEcru && c.idcolori_ecru === 0 && c.idref_fil > 0)
  // The reference's recipe usually names no yarn colour: no lot can match it.
  return deLaRef.every((c) => c.idcolori_fil > 0) ? deLaRef : []
}

export function calculerStockPotentiel(input: StockPotentielInput): LignePotentiel[] {
  const lignes: LignePotentiel[] = []
  const colorisEcruById = new Map(input.colorisEcru.map((c) => [c.idcolori_ecru, c]))
  const colorisParEcru = new Map<number, ColorisEcru[]>()
  for (const c of input.colorisEcru) {
    const list = colorisParEcru.get(c.idref_ecru) ?? []
    list.push(c)
    colorisParEcru.set(c.idref_ecru, list)
  }
  const refById = new Map(input.refsFini.map((r) => [r.idref_fini, r]))
  const ml = (kg: number, rendement: number) => (rendement > 0 ? round1(kg * rendement) : null)
  const ecruLabel = (idrefEcru: number, coloris: string | null) => {
    const ref = input.refsEcru.get(idrefEcru)
    if (!ref) return null
    return coloris ? `${ref} · ${coloris}` : ref
  }

  // ── Dispo: free fini rolls per (reference, coloris) ──
  type Groupe = {
    ref: RefFiniPotentiel; statut: StatutPotentiel; idcoloris: number; second_choix: boolean
    poids: number; metrage: number; pieces: number; repartition: Record<string, number>
  }
  const dispo = new Map<string, Groupe>()
  for (const f of input.finisLibres) {
    const ref = refById.get(f.idref_fini)
    if (!ref) continue
    const statut: StatutPotentiel = f.etat === ETAT_VALIDE ? 'dispo' : 'a_valider'
    const k = `${statut}:${f.idref_fini}:${f.idcoloris}:${f.second_choix ? 2 : 1}`
    const cur = dispo.get(k) ?? {
      ref, statut, idcoloris: f.idcoloris, second_choix: f.second_choix, poids: 0, metrage: 0, pieces: 0, repartition: {},
    }
    cur.poids += f.poids
    cur.metrage += f.metrage
    cur.pieces++
    if (statut === 'a_valider') {
      const lib = LIBELLE_ETAT[f.etat] ?? 'à valider'
      cur.repartition[lib] = (cur.repartition[lib] ?? 0) + 1
    }
    dispo.set(k, cur)
  }
  for (const [k, d] of dispo) {
    // Coloris catalog by avec_teinture (#1158): wash-only finis keep the écru's.
    const coloris = d.ref.avec_teinture === 0
      ? colorisEcruById.get(d.idcoloris)?.reference ?? null
      : input.colorisFini.get(d.idcoloris) ?? null
    lignes.push({
      key: k,
      statut: d.statut,
      idref_fini: d.ref.idref_fini,
      reference: d.ref.reference,
      designation: d.ref.designation,
      grammage: d.ref.grammage,
      contexture: d.ref.contexture,
      bio: d.ref.bio,
      recycle: d.ref.recycle,
      coloris,
      idcoloris: d.idcoloris > 0 ? d.idcoloris : null,
      tous_coloris: false,
      second_choix: d.second_choix,
      ecru: ecruLabel(d.ref.idref_ecru, null),
      metrage: round1(d.metrage),
      poids: round1(d.poids),
      pieces: d.pieces,
      limite: null,
      repartition: d.repartition,
    })
  }

  // Free écru per (ref écru, coloris).
  const ecru = new Map<string, { kg: number; pieces: number; secondChoix: number }>()
  for (const e of input.ecruLibre) {
    const k = `${e.idref_ecru}:${e.idcolori_ecru}`
    const cur = ecru.get(k) ?? { kg: 0, pieces: 0, secondChoix: 0 }
    cur.kg += e.poids
    cur.pieces++
    if (e.second_choix) cur.secondChoix++
    ecru.set(k, cur)
  }
  const deuxiemeChoix = (n: number): Record<string, number> => (n > 0 ? { '2e choix': n } : {})

  // Yarn → écru kg, memoised per écru coloris (many finis share one écru).
  const tricotable = new Map<number, { kg: number; limite: string } | null>()
  const tricoter = (c: ColorisEcru) => {
    if (!tricotable.has(c.idcolori_ecru)) {
      tricotable.set(c.idcolori_ecru, kgTricotable(recetteColoris(input.compositions, c.idref_ecru, c.idcolori_ecru), input.filLibre))
    }
    return tricotable.get(c.idcolori_ecru) ?? null
  }

  for (const ref of input.refsFini) {
    if (ref.idref_ecru <= 0) continue
    const tous = colorisParEcru.get(ref.idref_ecru) ?? []
    const base = {
      idref_fini: ref.idref_fini, reference: ref.reference, designation: ref.designation,
      grammage: ref.grammage, contexture: ref.contexture, bio: ref.bio, recycle: ref.recycle, second_choix: false,
    }

    if (ref.avec_teinture !== 0) {
      // Dyed: the natural base, any coloris — one line per status.
      const naturels = tous.filter((c) => estColorisNaturel(c.reference))
      let kg = 0
      let pieces = 0
      let secondChoix = 0
      for (const c of naturels) {
        const e = ecru.get(`${ref.idref_ecru}:${c.idcolori_ecru}`)
        if (e) { kg += e.kg; pieces += e.pieces; secondChoix += e.secondChoix }
      }
      if (kg > 0) {
        lignes.push({
          ...base, key: `a_ennoblir:${ref.idref_fini}:*`, statut: 'a_ennoblir', coloris: null, idcoloris: null, tous_coloris: true,
          ecru: ecruLabel(ref.idref_ecru, 'ecru'), metrage: ml(kg, ref.rendement), poids: round1(kg), pieces, limite: null,
          repartition: deuxiemeChoix(secondChoix),
        })
      }
      // Several natural coloris are alternatives, not a sum: keep the best.
      let best: { kg: number; limite: string } | null = null
      for (const c of naturels) {
        const t = tricoter(c)
        if (t && t.kg > 0 && (!best || t.kg > best.kg)) best = t
      }
      if (best) {
        lignes.push({
          ...base, key: `a_tricoter:${ref.idref_fini}:*`, statut: 'a_tricoter', coloris: null, idcoloris: null, tous_coloris: true,
          ecru: ecruLabel(ref.idref_ecru, 'ecru'), metrage: ml(best.kg, ref.rendement), poids: round1(best.kg), pieces: null,
          limite: input.filLabel.get(best.limite) ?? null, repartition: {},
        })
      }
      continue
    }

    // Wash-only: each écru coloris is a fini coloris of its own.
    for (const c of tous) {
      const e = ecru.get(`${ref.idref_ecru}:${c.idcolori_ecru}`)
      if (e && e.kg > 0) {
        lignes.push({
          ...base, key: `a_ennoblir:${ref.idref_fini}:${c.idcolori_ecru}`, statut: 'a_ennoblir', coloris: c.reference, idcoloris: c.idcolori_ecru, tous_coloris: false,
          ecru: ecruLabel(ref.idref_ecru, c.reference), metrage: ml(e.kg, ref.rendement), poids: round1(e.kg), pieces: e.pieces, limite: null,
          repartition: deuxiemeChoix(e.secondChoix),
        })
      }
      const t = tricoter(c)
      if (t && t.kg > 0) {
        lignes.push({
          ...base, key: `a_tricoter:${ref.idref_fini}:${c.idcolori_ecru}`, statut: 'a_tricoter', coloris: c.reference, idcoloris: c.idcolori_ecru, tous_coloris: false,
          ecru: ecruLabel(ref.idref_ecru, c.reference), metrage: ml(t.kg, ref.rendement), poids: round1(t.kg), pieces: null,
          limite: input.filLabel.get(t.limite) ?? null, repartition: {},
        })
      }
    }
  }

  // Lines rounding to nothing are noise (a few grams of yarn left on a lot).
  return lignes.filter((l) => l.poids >= 0.1)
}
