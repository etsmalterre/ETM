// Agent « Superviseur » — « every order is confirmed to the client ». A client
// order with no order confirmation emailed from ETM (envoi_email type 7, a
// proforma excluded) CONFIRMATION_ATTENTION_JO working days after its date.
// The confirmation is also the document that carries the CGV acceptance
// mention (lib/cgv.ts): a confirmation given another way leaves no trace of it.
//
// Measured on prod 2026-10-07: 3 of the 7 orders entered since the WinDev
// cutover (29/09) had none (N°3895, 3898, 3899).

import { query } from '../../../hfsql-auto.js'
import { TYPE_DOC_COMMANDE_CLIENT } from '../../../../routes/commandes-client.js'
import type { Constat, Controle } from '../types.js'
import { CONFIRMATION_ATTENTION_JO, CONFIRMATION_DEPUIS, CONFIRMATION_URGENT_JO, evaluerConfirmation, joursOuvresDepuis } from './regles.js'
import { noms } from './noms.js'

const jjmm = (d: string) => `${d.slice(6, 8)}/${d.slice(4, 6)}`

export const controleConfirmation: Controle = {
  id: 'confirmation',
  domaine: 'commandes_client',
  libelle: 'Confirmation de commande non envoyée',
  description:
    `Commande client sans confirmation envoyée depuis ETM (bouton « Envoyer » de la confirmation ; une proforma ne compte pas) ${CONFIRMATION_ATTENTION_JO} jours ouvrés après sa date, urgent à ${CONFIRMATION_URGENT_JO}. La confirmation porte la mention d’acceptation des CGV. Hors sociétés du groupe et donations ; commandes depuis le ${jjmm(CONFIRMATION_DEPUIS)} (avant, WinDev).`,
  raisonAbsent: 'Commande soldée ou supprimée.',
  async executer(ctx) {
    const today = new Date(ctx.nowMs)
    const cmds = await query<{ IDcommande_client: number; numero: number; IDclient: number; date_commande: string | null; donation: number | null }>(
      `SELECT IDcommande_client, numero, IDclient, date_commande, donation FROM commande_client
       WHERE IDsociete = 1 AND IDcommande_ETM = 0 AND est_soldee = 0 AND date_commande >= '${CONFIRMATION_DEPUIS}'`,
    )
    const internes = new Set((await query<{ IDclient: number }>(`SELECT IDclient FROM client WHERE client_interne = 1`)).map((c) => Number(c.IDclient)))
    const aVoir = cmds.filter((c) => Number(c.donation) !== 1 && !internes.has(Number(c.IDclient)))
    if (!aVoir.length) return []
    const ids = aVoir.map((c) => Number(c.IDcommande_client))
    // A proforma send is logged under the same type with notes = 'proforma'.
    const envois = await query<{ IDreference: number; notes: string | null }>(
      `SELECT IDreference, notes FROM envoi_email WHERE IDtype_doc = ${TYPE_DOC_COMMANDE_CLIENT} AND IDreference IN (${ids.join(',')})`,
    )
    const confirmees = new Set(envois.filter((e) => String(e.notes ?? '').trim().toLowerCase() !== 'proforma').map((e) => Number(e.IDreference)))
    const clients = await noms('client', aVoir.map((c) => Number(c.IDclient)))
    const out: Constat[] = []
    for (const c of aVoir) {
      const id = Number(c.IDcommande_client)
      const cle = `confirmation:${id}`
      if (confirmees.has(id)) { ctx.raison(cle, 'Confirmation envoyée depuis ETM.'); continue }
      const r = evaluerConfirmation(c.date_commande, today)
      if (!r) {
        const j = joursOuvresDepuis(c.date_commande, today) ?? 0
        ctx.raison(cle, `Commande d’il y a ${j} jour${j > 1 ? 's' : ''} ouvré${j > 1 ? 's' : ''} : la confirmation a encore le temps.`)
        continue
      }
      out.push({
        cle,
        controle: 'confirmation',
        domaine: 'commandes_client',
        gravite: r.gravite,
        titre: `Commande N°${Number(c.numero) || 0} — ${clients.get(Number(c.IDclient)) || `Client #${c.IDclient}`}`,
        message: `Commande du ${jjmm(String(c.date_commande).slice(0, 8))} : aucune confirmation envoyée au client depuis ETM après ${r.jours} jours ouvrés. Envoyer la confirmation (elle porte l’acceptation des CGV) ; si le client l’a eue autrement, la renvoyer depuis ETM pour en garder la trace.`,
        lien: `/clients/commandes?commande=${id}`,
      })
    }
    return out
  },
}
