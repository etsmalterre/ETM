// Agent « Superviseur » — what ETM already knows about a waiting client mail
// (v2, 2026-09-25: « tu aurais dû vérifier dans ETM », Isabelle, three times).
// SELECT only, IDsociete 1 only, ASCII column names confirmed on prod:
//   - envoi_email: every document ETM emailed (DATE, adresse = recipient,
//     IDtype_doc, IDreference) — a credit note re-sent from ETM IS an answer
//     the mailboxes cannot see as one (Idylle avoir N°9240, 2026-09-21);
//   - adresse: the client's addresses, for an announced address change
//     (Seenel's Tourcoing addresses were entered before the report said so).
// Every id interpolated here is a parsed integer (HFSQL takes no parameters).

import { query } from '../../hfsql-auto.js'
import { parseDtMs } from '../../production-trm.js'
import type { EnvoiEtm } from './controles/regles.js'

/** envoi_email.IDtype_doc → IDreference: 7 commande_client (confirmation, or
 *  proforma when notes = 'proforma'), 14 expedition, 16 expedition divers,
 *  19 facture (définitive or avoir), 27 étude soumission. */
const TYPES_CLIENT = [7, 14, 16, 19, 27]

const ids = (xs: Iterable<number>) => [...new Set([...xs].filter((x) => Number.isInteger(x) && x > 0))]
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '')

interface LigneEnvoi { d: unknown; adresse: string | null; IDtype_doc: number; IDreference: number; notes: string | null }

async function libelles(rows: LigneEnvoi[]): Promise<EnvoiEtm[]> {
  const fact = ids(rows.filter((r) => Number(r.IDtype_doc) === 19).map((r) => Number(r.IDreference)))
  const cmd = ids(rows.filter((r) => Number(r.IDtype_doc) === 7).map((r) => Number(r.IDreference)))
  const [f, c] = await Promise.all([
    fact.length ? query<{ IDfacture: number; numero: number; tf: number }>(`SELECT IDfacture, numero, TYPE AS tf FROM facture WHERE IDfacture IN (${fact.join(',')})`) : [],
    cmd.length ? query<{ IDcommande_client: number; numero: number }>(`SELECT IDcommande_client, numero FROM commande_client WHERE IDcommande_client IN (${cmd.join(',')})`) : [],
  ])
  const facture = new Map(f.map((x) => [Number(x.IDfacture), `${Number(x.tf) === 2 ? 'Avoir' : 'Facture'} N°${x.numero}`]))
  const commande = new Map(c.map((x) => [Number(x.IDcommande_client), Number(x.numero)]))
  const out: EnvoiEtm[] = []
  for (const r of rows) {
    const date = parseDtMs(r.d)
    if (date === null) continue
    const t = Number(r.IDtype_doc)
    const ref = Number(r.IDreference)
    const libelle =
      t === 19 ? facture.get(ref) ?? 'Facture'
      : t === 7 ? `${String(r.notes ?? '').trim() === 'proforma' ? 'Proforma' : 'Confirmation'} de commande${commande.get(ref) ? ` N°${commande.get(ref)}` : ''}`
      : t === 27 ? 'Soumission'
      : 'Avis d’expédition'
    out.push({ date, adresse: String(r.adresse ?? '').trim().toLowerCase(), libelle })
  }
  return out
}

let memo: { nowMs: number; envois: Promise<EnvoiEtm[]> } | null = null

/** Every client document ETM emailed since `depuisMs` — once per run. */
export function envoisDuRun(nowMs: number, depuisMs: number): Promise<EnvoiEtm[]> {
  if (!memo || memo.nowMs !== nowMs) {
    memo = {
      nowMs,
      envois: (async () => libelles(await query<LigneEnvoi>(
        `SELECT DATE AS d, adresse, IDtype_doc, IDreference, notes FROM envoi_email
         WHERE DATE >= '${ymd(depuisMs)}' AND IDtype_doc IN (${TYPES_CLIENT.join(',')})`,
      )))(),
    }
  }
  return memo.envois
}

export type TypeDocument = 'facture' | 'avoir' | 'proforma' | 'confirmation' | 'bl' | 'devis' | 'autre'

/** Every ETM send of the documents a client names (« avoir N°9240 »), at any
 *  date. Factures / avoirs by their numero, proformas and confirmations by the
 *  order numero; other kinds are not logged in a way we can match. */
export async function envoisDesDocuments(docs: ReadonlyArray<{ type: TypeDocument; numero: string }>): Promise<EnvoiEtm[]> {
  const num = (s: string) => parseInt(String(s).replace(/\D/g, ''), 10)
  const factNums = ids(docs.filter((d) => d.type === 'facture' || d.type === 'avoir').map((d) => num(d.numero)))
  const cmdNums = ids(docs.filter((d) => d.type === 'proforma' || d.type === 'confirmation').map((d) => num(d.numero)))
  const [f, c] = await Promise.all([
    factNums.length ? query<{ IDfacture: number }>(`SELECT IDfacture FROM facture WHERE IDsociete = 1 AND numero IN (${factNums.join(',')})`) : [],
    cmdNums.length ? query<{ IDcommande_client: number }>(`SELECT IDcommande_client FROM commande_client WHERE IDsociete = 1 AND numero IN (${cmdNums.join(',')})`) : [],
  ])
  const fid = ids(f.map((x) => Number(x.IDfacture)))
  const cid = ids(c.map((x) => Number(x.IDcommande_client)))
  const [ef, ec] = await Promise.all([
    fid.length ? query<LigneEnvoi>(`SELECT DATE AS d, adresse, IDtype_doc, IDreference, notes FROM envoi_email WHERE IDtype_doc = 19 AND IDreference IN (${fid.join(',')})`) : [],
    cid.length ? query<LigneEnvoi>(`SELECT DATE AS d, adresse, IDtype_doc, IDreference, notes FROM envoi_email WHERE IDtype_doc = 7 AND IDreference IN (${cid.join(',')})`) : [],
  ])
  const voulus = new Set(docs.map((d) => d.type))
  // A proforma request is not answered by the plain confirmation, and vice versa.
  return (await libelles([...ef, ...ec])).filter((e) =>
    !e.libelle.startsWith('Proforma') && !e.libelle.startsWith('Confirmation') ? true
    : e.libelle.startsWith('Proforma') ? voulus.has('proforma') : voulus.has('confirmation'))
}

/** The client's visible addresses (cp / ville may carry a lost byte). */
export function adressesClient(idClient: number): Promise<Array<{ nom: string | null; cp: string | null; ville: string | null }>> {
  const id = Number.isInteger(idClient) && idClient > 0 ? idClient : 0
  return query(`SELECT nom, cp, ville FROM adresse WHERE IDclient = ${id} AND est_visible = 1`)
}
