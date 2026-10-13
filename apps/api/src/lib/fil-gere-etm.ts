// Which yarn lots ETM sees (LIVA #1293, decision Vincent 2026-10-13).
//
// `stock_fil` is not partitioned: it is every lot stored at TRM, and
// `IDclient` names the owner. ETM's own yarn is client 1 « Ets Malterre » (the
// TRM client record of ETM; 0 = no owner written, kept for safety). The rest is
// consigned yarn of TRM's clients — none of ETM's business, EXCEPT for the few
// clients who consign yarn that TRM knits on ETM orders: Sigvaris' PA66 for
// 180102, every yarn of La Gentle Factory, Gant Maille's thermosoie. ETM must
// see those lots, because only what ETM affects on the sst line may be knitted
// on the mirror (#1159).
//
// The decision lives ON THE LOT (`stock_fil.gere_par_etm`, migration 0022), set
// when TRM enters it from the client's list (`fil_gere_par_etm`, idref_fil 0 =
// every yarn of that client) and editable on the lot. Frozen per lot on
// purpose: editing the list later never moves history from one app to the other.
//
// Every ETM screen that LISTS yarn lots goes through filEtmSql() — Fils › Stock,
// Fils › Références (stock + « À commander »), the sst affectation picker, the
// client-line Tricotage dialog, Transferts, the yarn notifications. Lookups by
// id (traceability of a roll back to its yarn) stay unfiltered.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'

/** `client.IDclient` of Ets Malterre in TRM's client ledger. */
export const ID_CLIENT_ETS_MALTERRE = 1

/** SQL predicate « this lot is ETM's to see ». ASCII columns only, so it is
 *  safe in every legacy query (HFSQL shape through lib/pg-backend.ts). */
export function filEtmSql(alias = ''): string {
  const a = alias ? `${alias}.` : ''
  return `(${a}IDclient IN (0, ${ID_CLIENT_ETS_MALTERRE}) OR ${a}gere_par_etm = 1)`
}

/** Same rule on a row already read (keys in either case). */
export function estFilEtm(row: Record<string, unknown>): boolean {
  const client = Number(row.IDclient ?? row.idclient) || 0
  if (client === 0 || client === ID_CLIENT_ETS_MALTERRE) return true
  return Number(row.gere_par_etm) === 1
}

/** A client's list: every yarn, or these refs. */
export interface RegleFilsEtm {
  tous: boolean
  refs: number[]
}

const AUCUNE: RegleFilsEtm = { tous: false, refs: [] }

/** Lists of the given clients (all clients with a list when omitted). */
export async function reglesFilsEtm(clientIds?: number[]): Promise<Map<number, RegleFilsEtm>> {
  const rows = clientIds
    ? clientIds.length === 0
      ? []
      : await mpsPg()<{ idclient: number; idref_fil: number }[]>`
          SELECT idclient, idref_fil FROM fil_gere_par_etm WHERE idclient = ANY(${clientIds})`
    : await mpsPg()<{ idclient: number; idref_fil: number }[]>`
        SELECT idclient, idref_fil FROM fil_gere_par_etm`
  const out = new Map<number, RegleFilsEtm>()
  for (const r of rows) {
    const cur = out.get(r.idclient) ?? { tous: false, refs: [] }
    if (r.idref_fil === 0) cur.tous = true
    else cur.refs.push(r.idref_fil)
    out.set(r.idclient, cur)
  }
  return out
}

export async function regleFilsEtm(idclient: number): Promise<RegleFilsEtm> {
  return (await reglesFilsEtm([idclient])).get(idclient) ?? AUCUNE
}

/** The value a NEW lot of this client and yarn takes. Ets Malterre's own lots
 *  are always ETM's, the flag is moot there and stays 0. */
export function gereParEtmParDefaut(idclient: number, idrefFil: number, regle: RegleFilsEtm): boolean {
  if (idclient === 0 || idclient === ID_CLIENT_ETS_MALTERRE) return false
  return regle.tous || regle.refs.includes(idrefFil)
}

/** Replaces a client's list. Existing lots keep their own flag. */
export async function remplacerRegleFilsEtm(idclient: number, regle: RegleFilsEtm, par: string): Promise<RegleFilsEtm> {
  const refs = regle.tous ? [0] : Array.from(new Set(regle.refs.filter((r) => Number.isInteger(r) && r > 0)))
  await mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    await tx`DELETE FROM fil_gere_par_etm WHERE idclient = ${idclient}`
    for (const ref of refs) {
      await tx`INSERT INTO fil_gere_par_etm (idclient, idref_fil, cree_par) VALUES (${idclient}, ${ref}, ${par})`
    }
  })
  return regleFilsEtm(idclient)
}
