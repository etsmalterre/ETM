// « Relancer le délai dépassé » of a sous-traitant order (Vincent 2026-11-27).
//
// A line's délai is the partner's engagement (lib/report-delai-sst.ts). Once it
// has passed with the goods not in, the order is red « Délai du … dépassé » and
// what we want is a NEW délai. The relance is an e-mail, sent from the order's
// mail button or in the sous-traitant's grouped relance (lib/relance-groupee-sst.ts),
// and recorded here (`relance_retard_sst`, migration 0089, append-only).
//
// ⚠️ A passed délai may be chased EVERY working day until a new délai is given
// (Vincent, same day): the relance calms the order for the day it is sent, and
// it is red again the next working day. A new délai (a report) or the reception
// ends it; a relance older than the délai now in place counts for nothing.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { plusOuvres } from './delai-sst.js'

/** True while a passed délai (`echeance`, the day the partner was expected) was chased and the next
 *  chase day has not come: the working day after our latest relance. `relances` sorted, 'YYYY-MM-DD'. Pure. */
export function retardCalme(relances: readonly string[] | undefined, echeance: string, today: string): boolean {
  const derniere = (relances ?? []).filter((r) => r >= echeance).at(-1)
  return !!derniere && plusOuvres(derniere, 1) > today
}

/** Our relances of a passed délai, per order, sorted ('YYYY-MM-DD', Paris). */
export async function lireRelancesRetard(ids: readonly number[], sql: Sql = mpsPg()): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  const cmdIds = [...new Set(ids.filter((x) => x > 0))]
  if (cmdIds.length === 0) return out
  const rows = await sql<{ cmd: number; jour: string }[]>`
    SELECT idcommande_sous_traitant AS cmd, to_char(relance_le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour
    FROM relance_retard_sst WHERE idcommande_sous_traitant = ANY(${cmdIds}) ORDER BY relance_le`
  for (const r of rows) out.set(Number(r.cmd), [...(out.get(Number(r.cmd)) ?? []), r.jour])
  return out
}

/** The relance e-mail left: the fact the cycle reads (retardCalme). Append-only. */
export async function enregistrerRelanceRetard(opts: {
  idcommande: number
  par: { id: number; nom: string | null }
  destinataires: readonly string[]
}, sql: Sql = mpsPg()): Promise<void> {
  await sql`
    INSERT INTO relance_retard_sst (idcommande_sous_traitant, relance_par_id, relance_par, destinataires)
    VALUES (${opts.idcommande}, ${opts.par.id}, ${opts.par.nom}, ${opts.destinataires.join(', ').slice(0, 2000)})`
}

const jjmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** The relance mail of one order as it opens: short, the person reads it before it leaves.
 *  `articles`: « REF - coloris » of the late lines; `delai` the passed délai ('YYYY-MM-DD'). Pure. */
export function mailRelanceRetard(p: { numero: number; articles: string | null; delai: string | null; derniereRelance: string | null }): { subject: string; body: string } {
  return {
    subject: `Relance — Délai dépassé de notre commande N°${p.numero} — ETS Malterre`,
    body: 'Bonjour,\n\n'
      + `Notre commande N°${p.numero}${p.articles ? ` (${p.articles})` : ''}`
      + `${p.delai ? ` était prévue pour le ${jjmmaaaa(p.delai)}` : ' a dépassé son délai'} et `
      + `${p.derniereRelance ? `malgré notre relance du ${jjmmaaaa(p.derniereRelance)}, ` : ''}nous ne l’avons pas reçue.`
      + '\n\nPouvez-vous nous donner un nouveau délai ?\n\nMerci d’avance.\n\nCordialement,',
  }
}
