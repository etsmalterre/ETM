// Clients › Gestion › Statistiques (LIVA #1306): what a client ordered, per
// reference and per year — quantity, number of orders, average order size —
// so the commercial side can propose grouped purchases against a better price.
//
// Pure aggregation over the client's order lines; the route reads them.
// Rules:
//   - one row per reference AND selling unit: a fini sells in Ml, a tombé de
//     métier in Kg, a divers per unit — quantities are never summed across units;
//   - « commandes » counts distinct orders, so two coloris of the same ref on one
//     order are ONE order (the size the client buys at once);
//   - a line without a readable order date is left out (no year to file it under).

export interface StatsLigne {
  IDcommande_client: number
  /** Raw order date — HFSQL-shaped `YYYYMMDD…` or ISO `YYYY-MM-DD…`. */
  date_commande: string | null
  type_kind: number
  IDreference: number
  ref: string
  quantite: number
  unite: number
}

export interface StatsCellule {
  quantite: number
  commandes: number
}

export interface StatsReference {
  /** Stable key: type, reference id and unit. */
  key: string
  type_kind: number
  ref: string
  unite: number
  parAnnee: Record<number, StatsCellule>
  total: StatsCellule
}

export interface StatsClient {
  /** Every year from the first order to the last one, ascending, gaps included. */
  annees: number[]
  references: StatsReference[]
}

/** Year of an order date, or null when it cannot be read. */
export function anneeDe(date: string | null): number | null {
  if (!date) return null
  const m = /^(\d{4})/.exec(date.trim())
  // A Date that went through String() ("Wed Jan 15 2025 …") still has a year.
  const y = m ? Number(m[1]) : new Date(date).getFullYear()
  return y >= 1990 && y <= 2100 ? y : null
}

export function statsClient(lignes: StatsLigne[]): StatsClient {
  const refs = new Map<string, StatsReference & { cmdParAnnee: Map<number, Set<number>>; cmdTotal: Set<number> }>()
  let min = Infinity
  let max = -Infinity
  for (const l of lignes) {
    const y = anneeDe(l.date_commande)
    if (y === null) continue
    min = Math.min(min, y)
    max = Math.max(max, y)
    const key = `${l.type_kind}:${l.IDreference}:${l.unite}`
    let r = refs.get(key)
    if (!r) {
      r = {
        key, type_kind: l.type_kind, ref: l.ref, unite: l.unite,
        parAnnee: {}, total: { quantite: 0, commandes: 0 },
        cmdParAnnee: new Map(), cmdTotal: new Set(),
      }
      refs.set(key, r)
    }
    const cell = (r.parAnnee[y] ??= { quantite: 0, commandes: 0 })
    cell.quantite += l.quantite
    r.total.quantite += l.quantite
    let set = r.cmdParAnnee.get(y)
    if (!set) { set = new Set(); r.cmdParAnnee.set(y, set) }
    set.add(l.IDcommande_client)
    r.cmdTotal.add(l.IDcommande_client)
  }
  const annees: number[] = []
  if (Number.isFinite(min)) for (let y = min; y <= max; y++) annees.push(y)

  const references: StatsReference[] = [...refs.values()].map(({ cmdParAnnee, cmdTotal, ...r }) => {
    for (const [y, set] of cmdParAnnee) r.parAnnee[y].commandes = set.size
    r.total.commandes = cmdTotal.size
    r.total.quantite = round1(r.total.quantite)
    for (const c of Object.values(r.parAnnee)) c.quantite = round1(c.quantite)
    return r
  })
  // What the client buys NOW first: last year with activity, then volume.
  const derniere = (r: StatsReference) => Math.max(...Object.keys(r.parAnnee).map(Number))
  references.sort((a, b) =>
    derniere(b) - derniere(a)
    || (b.parAnnee[derniere(b)]?.quantite ?? 0) - (a.parAnnee[derniere(a)]?.quantite ?? 0)
    || b.total.quantite - a.total.quantite
    || a.ref.localeCompare(b.ref, 'fr'))
  return { annees, references }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
