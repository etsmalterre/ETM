// Agent « Superviseur » — v4: « the shipment reaches the client » for the
// clients whose orders do not follow the standard flow (PROCESS_NON_STANDARD).
// Isabelle on Unicycle (2026-10-08): the order comes on paper and is entered
// when the cartons leave, so no confirmation is sent; « ce qu'il faut plutôt
// vérifier, c'est que les expéditions soient bien transmises au client ». A
// shipment of theirs (expedition or expedition_divers) never emailed from ETM
// (envoi_email 14 / 16) TRANSMISSION_EXPEDITION_JO working day after its date.
//
// Measured on prod 2026-10-30: 1 of Unicycle's 5 shipments since the cutover
// (N°3899, 05/10) was never sent.
//
// Not checked (the paper order is in no system): that the order entered
// matches the client's paper order.

import { query } from '../../../hfsql-auto.js'
import type { Constat, Controle } from '../types.js'
import { CONFIRMATION_DEPUIS, joursOuvresDepuis, PROCESS_NON_STANDARD, TRANSMISSION_EXPEDITION_JO } from './regles.js'
import { noms } from './noms.js'

const jjmm = (d: string) => `${d.slice(6, 8)}/${d.slice(4, 6)}`

interface Expe { id: number; type: 14 | 16; commande: number; date: string }

export const controleTransmissionExpedition: Controle = {
  id: 'transmission_expedition',
  domaine: 'commandes_client',
  libelle: 'Expédition non envoyée au client',
  description:
    `Pour les clients au fonctionnement non standard (Unicycle : commande papier saisie à l’expédition, sans confirmation), expédition jamais envoyée au client depuis ETM ${TRANSMISSION_EXPEDITION_JO} jour ouvré après sa date ; expéditions depuis le ${jjmm(CONFIRMATION_DEPUIS)}.`,
  raisonAbsent: 'Expédition supprimée.',
  async executer(ctx) {
    const today = new Date(ctx.nowMs)
    const clients = [...PROCESS_NON_STANDARD.keys()]
    if (!clients.length) return []
    const cmds = await query<{ IDcommande_client: number; numero: number; IDclient: number }>(
      `SELECT IDcommande_client, numero, IDclient FROM commande_client
       WHERE IDsociete = 1 AND IDcommande_ETM = 0 AND IDclient IN (${clients.join(',')}) AND date_commande >= '${CONFIRMATION_DEPUIS}'`,
    )
    if (!cmds.length) return []
    const parId = new Map(cmds.map((c) => [Number(c.IDcommande_client), c]))
    const ids = [...parId.keys()].join(',')
    const [rouleaux, divers] = await Promise.all([
      query<{ id: number; c: number; d: string | null }>(`SELECT IDexpedition AS id, IDcommande_client AS c, DATE AS d FROM expedition WHERE IDcommande_client IN (${ids})`),
      query<{ id: number; c: number; d: string | null }>(`SELECT IDexpedition_divers AS id, IDcommande_client AS c, DATE AS d FROM expedition_divers WHERE IDcommande_client IN (${ids})`),
    ])
    const expes: Expe[] = [
      ...rouleaux.map((e) => ({ id: Number(e.id), type: 14 as const, commande: Number(e.c), date: String(e.d ?? '').slice(0, 8) })),
      ...divers.map((e) => ({ id: Number(e.id), type: 16 as const, commande: Number(e.c), date: String(e.d ?? '').slice(0, 8) })),
    ].filter((e) => e.date >= CONFIRMATION_DEPUIS)
    if (!expes.length) return []
    const envoyees = new Set<string>()
    for (const t of [14, 16] as const) {
      const de = expes.filter((e) => e.type === t).map((e) => e.id)
      if (!de.length) continue
      const rows = await query<{ IDreference: number }>(`SELECT IDreference FROM envoi_email WHERE IDtype_doc = ${t} AND IDreference IN (${de.join(',')})`)
      for (const r of rows) envoyees.add(`${t}:${Number(r.IDreference)}`)
    }
    const nomsClients = await noms('client', cmds.map((c) => Number(c.IDclient)))
    const out: Constat[] = []
    for (const e of expes) {
      const cle = `transmission_expedition:${e.type}:${e.id}`
      if (envoyees.has(`${e.type}:${e.id}`)) { ctx.raison(cle, 'Expédition envoyée au client depuis ETM.'); continue }
      const j = joursOuvresDepuis(e.date, today) ?? 0
      if (j < TRANSMISSION_EXPEDITION_JO) { ctx.raison(cle, 'Expédition du jour : l’envoi au client a encore le temps.'); continue }
      const c = parId.get(e.commande)!
      out.push({
        cle,
        controle: 'transmission_expedition',
        domaine: 'commandes_client',
        gravite: 'attention',
        titre: `Commande N°${Number(c.numero) || 0} · ${nomsClients.get(Number(c.IDclient)) || `Client #${c.IDclient}`}`,
        message: `Expédition du ${jjmm(e.date)} jamais envoyée au client depuis ETM (${PROCESS_NON_STANDARD.get(Number(c.IDclient))} : c’est le seul document qu’il reçoit). À faire : envoyer l’expédition au client depuis ETM.`,
        lien: `/clients/commandes?commande=${e.commande}`,
      })
    }
    return out
  },
}
