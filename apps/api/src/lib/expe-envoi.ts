// Expe: what a member writes on a transport (repo expe, screen « Transports »,
// button Modifier). docs/plan.md §5 and step 1 of that repo.
//
//   - THE CARRIER is written on the avis themselves (expedition /
//     expedition_divers.idtransporteur): one carrier per avis, read by ETM's BL
//     and demande de transport alike. Nothing else of an avis is touched here.
//     Unlike ETM's own PUT, an invoiced avis stays writable: the goods of an
//     avis invoiced early have often not left yet, the carrier is chosen when
//     the pickup is organised, and no invoice reads it (same reasoning as the
//     delivery address, LIVA #1179).
//   - THE TRACKING NUMBER belongs to the physical shipment, which no ETM table
//     knows: tables `envoi` and `envoi_document` (migration 0086_expe_envoi).
//     An envoi is created the first time a tracking number is saved, with the
//     avis the transport shows at that moment. From then on those avis ARE that
//     transport, whatever the computed grouping would say
//     (lib/expe-transports.ts cleGroupe): recording a tracking number records
//     what left together. A document leaves in one envoi only.
//
// No status is stored (docs/plan.md §3): the dated facts (pickup asked, left,
// delivered) will be `envoi_evenement`, not built yet.

import type { Sql } from 'postgres'
import { z } from 'zod'
import { mpsPg } from './mps-pg.js'

export type TypeDocEnvoi = 'avis' | 'avis_divers'

export interface DocumentAvis {
  kind: 'formelle' | 'divers'
  id: number
}

export interface ModifTransport {
  avis: DocumentAvis[]
  /** 0 = no carrier. Absent = left as it is. */
  idtransporteur?: number
  /** '' = no tracking number. Absent = left as it is. */
  numero_suivi?: string
}

export interface Auteur { id: number; nom: string }

export const NUMERO_SUIVI_MAX = 200

const corps = z.object({
  avis: z.array(z.object({
    kind: z.enum(['formelle', 'divers']),
    id: z.number().int().positive(),
  })).min(1).max(100),
  idtransporteur: z.number().int().nonnegative().optional(),
  numero_suivi: z.string().max(NUMERO_SUIVI_MAX * 2).optional(),
})

/** The body of PUT /api/expe/transports, or null when it is not one. The
 *  tracking number is trimmed and its inner blanks collapsed; an avis named
 *  twice counts once. A body that changes nothing is not a modification. */
export function lireModifTransport(body: unknown): ModifTransport | null {
  const p = corps.safeParse(body)
  if (!p.success) return null
  const d = p.data
  if (d.idtransporteur === undefined && d.numero_suivi === undefined) return null
  const vus = new Set<string>()
  const avis = d.avis.filter((a) => {
    const cle = `${a.kind}-${a.id}`
    if (vus.has(cle)) return false
    vus.add(cle)
    return true
  })
  const out: ModifTransport = { avis }
  if (d.idtransporteur !== undefined) out.idtransporteur = d.idtransporteur
  if (d.numero_suivi !== undefined) {
    const suivi = d.numero_suivi.replace(/\s+/g, ' ').trim()
    if (suivi.length > NUMERO_SUIVI_MAX) return null
    out.numero_suivi = suivi
  }
  return out
}

export function typeDoc(kind: DocumentAvis['kind']): TypeDocEnvoi {
  return kind === 'divers' ? 'avis_divers' : 'avis'
}

/** What to do with the tracking number, from the envois the avis already
 *  belong to. Pure: the caller reads the links and applies the decision. */
export type DecisionSuivi =
  | { action: 'rien' }
  | { action: 'creer' }
  | { action: 'modifier'; idenvoi: number }
  | { action: 'refuser' }

export function deciderSuivi(envoisDesAvis: readonly number[], numeroSuivi: string): DecisionSuivi {
  const envois = Array.from(new Set(envoisDesAvis))
  // Avis of two shipments cannot share one tracking number: they did not leave together.
  if (envois.length > 1) return { action: 'refuser' }
  if (envois.length === 1) return { action: 'modifier', idenvoi: envois[0] }
  // No shipment yet: an empty number records nothing.
  return numeroSuivi === '' ? { action: 'rien' } : { action: 'creer' }
}

/** A refusal the route turns into an HTTP status and a French message. */
export class RefusTransport extends Error {
  constructor(public code: 'avis_introuvable' | 'transporteur_introuvable' | 'envois_differents', message: string) {
    super(message)
  }
}

const idsDe = (m: ModifTransport, kind: DocumentAvis['kind']) => m.avis.filter((a) => a.kind === kind).map((a) => a.id)

/** Apply a modification in one transaction. Returns the envoi the avis belong
 *  to afterwards (null: none recorded). */
export async function modifierTransport(m: ModifTransport, par: Auteur, sql: Sql = mpsPg()): Promise<{ idenvoi: number | null }> {
  const formelles = idsDe(m, 'formelle')
  const divers = idsDe(m, 'divers')
  return sql.begin(async (t) => {
    const tx = t as unknown as Sql

    // Every avis must exist (an avis d'expédition of ETM: idsociete = 1).
    const [{ n: nbFormelles }] = formelles.length === 0 ? [{ n: 0 }] : await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM expedition WHERE idsociete = 1 AND idexpedition IN ${tx(formelles)}`
    const [{ n: nbDivers }] = divers.length === 0 ? [{ n: 0 }] : await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM expedition_divers WHERE idexpedition_divers IN ${tx(divers)}`
    if (nbFormelles !== formelles.length || nbDivers !== divers.length) {
      throw new RefusTransport('avis_introuvable', 'Un avis de ce transport n’existe plus. Actualisez la liste.')
    }

    if (m.idtransporteur !== undefined) {
      if (m.idtransporteur > 0) {
        const connu = await tx`SELECT 1 FROM transporteur WHERE idtransporteur = ${m.idtransporteur}`
        if (connu.length === 0) throw new RefusTransport('transporteur_introuvable', 'Ce transporteur n’existe plus.')
      }
      if (formelles.length > 0) {
        await tx`UPDATE expedition SET idtransporteur = ${m.idtransporteur} WHERE idsociete = 1 AND idexpedition IN ${tx(formelles)}`
      }
      if (divers.length > 0) {
        await tx`UPDATE expedition_divers SET idtransporteur = ${m.idtransporteur} WHERE idexpedition_divers IN ${tx(divers)}`
      }
    }

    // The envois these avis already belong to.
    const liens = [
      ...(formelles.length === 0 ? [] : await tx<{ idenvoi: number }[]>`
        SELECT idenvoi FROM envoi_document WHERE type_doc = 'avis' AND iddocument IN ${tx(formelles)}`),
      ...(divers.length === 0 ? [] : await tx<{ idenvoi: number }[]>`
        SELECT idenvoi FROM envoi_document WHERE type_doc = 'avis_divers' AND iddocument IN ${tx(divers)}`),
    ].map((l) => Number(l.idenvoi))
    const dejaLa = Array.from(new Set(liens))
    if (m.numero_suivi === undefined) return { idenvoi: dejaLa.length === 1 ? dejaLa[0] : null }

    const decision = deciderSuivi(liens, m.numero_suivi)
    if (decision.action === 'refuser') {
      throw new RefusTransport('envois_differents', 'Ces avis sont déjà enregistrés dans des envois différents : ils ne peuvent pas porter le même numéro de suivi.')
    }
    if (decision.action === 'rien') return { idenvoi: null }

    let idenvoi: number
    if (decision.action === 'creer') {
      const [cree] = await tx<{ id: number }[]>`
        INSERT INTO envoi (numero_suivi, cree_par_id, cree_par, modifie_par_id, modifie_par)
        VALUES (${m.numero_suivi}, ${par.id}, ${par.nom}, ${par.id}, ${par.nom})
        RETURNING id`
      idenvoi = Number(cree.id)
    } else {
      idenvoi = decision.idenvoi
      await tx`
        UPDATE envoi SET numero_suivi = ${m.numero_suivi}, modifie_le = now(), modifie_par_id = ${par.id}, modifie_par = ${par.nom}
         WHERE id = ${idenvoi}`
    }
    // The avis shown with the transport join its envoi (those already in it stay).
    for (const a of m.avis) {
      await tx`
        INSERT INTO envoi_document (idenvoi, type_doc, iddocument) VALUES (${idenvoi}, ${typeDoc(a.kind)}, ${a.id})
        ON CONFLICT (type_doc, iddocument) DO NOTHING`
    }
    return { idenvoi }
  }) as Promise<{ idenvoi: number | null }>
}

export interface TransporteurChoix { id: number; nom: string }

/** The carriers a transport can be given: the visible ones, as ETM's avis. */
export async function listerTransporteurs(sql: Sql = mpsPg()): Promise<TransporteurChoix[]> {
  const rows = await sql<{ id: number; nom: string | null }[]>`
    SELECT idtransporteur AS id, nom::text AS nom FROM transporteur WHERE est_visible = 1`
  return rows
    .map((r) => ({ id: Number(r.id), nom: (r.nom ?? '').trim() }))
    .filter((r) => r.nom !== '')
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' }))
}
