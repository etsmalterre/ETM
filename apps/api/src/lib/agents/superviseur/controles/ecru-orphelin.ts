// Agent « Superviseur » — « every piece knitted for a client has a use ».
// Écru in ETM stock that came from an sst order launched for a client line,
// and that nobody uses: not reserved to a client line, not sent to a dyer, not
// dyed (own fini child or component of a merged roll), not donated, not sold
// as écru. Reported ONCE PER SOURCE ORDER (the extra pieces of one order are
// one story), ORPHELIN_JOURS after the newest piece was knitted, unless a
// sentence in the order's journal says why (rule given to Pierrot and Nico on
// 2026-10-08: any non-standard quantity is written there). The order's
// COMMENT does not count: it is the instruction printed for the knitter
// (« urgent - merci »), measured empty of explanations on prod.
// Thresholds and texts: regles.ts (evaluerOrphelins).

import { query } from '../../../hfsql-auto.js'
import { consumedEcruIds } from '../../../fini-sources.js'
import { parseDtMs } from '../../../production-trm.js'
import { stripRtf } from '../../../rtf-utils.js'
import type { Constat, Controle } from '../types.js'
import { evaluerOrphelins, fmt, ORPHELIN_DEPUIS, ORPHELIN_JOURS, raisonOrphelins } from './regles.js'
import { noms } from './noms.js'

const CHUNK = 300
const jjmmaaaa = (d: string) => `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`

interface Piece { id: number; numero: string; poids: number; saisieMs: number | null; source: number }

export const controleEcruOrphelin: Controle = {
  id: 'ecru_orphelin',
  domaine: 'stock',
  libelle: 'Pièces écru faites pour un client, sans emploi',
  description:
    `Pièces écru en stock ETM venues d’une commande sous-traitant lancée pour une commande client, et que rien n’utilise (ni affectées, ni en teinture, ni teintes, ni données, ni vendues) ${ORPHELIN_JOURS} jours après leur tricotage, sans une phrase au journal de la commande sous-traitant pour dire pourquoi. Un point par commande sous-traitant. Le stock tricoté exprès (commande sans client) n’est jamais signalé ; commandes depuis le ${jjmmaaaa(ORPHELIN_DEPUIS)}.`,
  raisonAbsent: 'Les pièces ont trouvé un emploi : affectées, envoyées en teinture, teintes, données ou vendues.',
  async executer(ctx) {
    const rows = await query<{ IDstock_ecru: number; numero: string | null; poids: number | null; date_saisie: string | null; IDref_commande_source: number }>(
      `SELECT IDstock_ecru, numero, poids, date_saisie, IDref_commande_source FROM stock_ecru
       WHERE IDsociete = 1 AND IDref_commande_source > 0
         AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0)
         AND (IDref_commande_affectation IS NULL OR IDref_commande_affectation = 0)
         AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)
         AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0)`,
    )
    const consommees = await consumedEcruIds(rows.map((r) => Number(r.IDstock_ecru)))
    const pieces: Piece[] = rows
      .filter((r) => !consommees.has(Number(r.IDstock_ecru)))
      .map((r) => ({ id: Number(r.IDstock_ecru), numero: String(r.numero ?? '').trim(), poids: Number(r.poids) || 0, saisieMs: parseDtMs(r.date_saisie), source: Number(r.IDref_commande_source) }))
    if (!pieces.length) return []

    // Source sst line → its order.
    const lignes: Array<{ IDligne_commande_sous_traitant: number; IDcommande_sous_traitant: number }> = []
    const srcIds = [...new Set(pieces.map((p) => p.source))]
    for (let i = 0; i < srcIds.length; i += CHUNK) {
      lignes.push(...(await query<{ IDligne_commande_sous_traitant: number; IDcommande_sous_traitant: number }>(
        `SELECT IDligne_commande_sous_traitant, IDcommande_sous_traitant FROM ligne_commande_sous_traitant
         WHERE IDligne_commande_sous_traitant IN (${srcIds.slice(i, i + CHUNK).join(',')})`,
      )))
    }
    const cmdDeLigne = new Map(lignes.map((l) => [Number(l.IDligne_commande_sous_traitant), Number(l.IDcommande_sous_traitant)]))
    const cmdIds = [...new Set(cmdDeLigne.values())]
    type Entete = { IDcommande_sous_traitant: number; date_commande: string | null; IDcommande_client: number | null; IDligne_commande_client: number | null; journal: string | null }
    const entetes: Entete[] = []
    for (let i = 0; i < cmdIds.length; i += CHUNK) {
      entetes.push(...(await query<Entete>(
        `SELECT IDcommande_sous_traitant, date_commande, IDcommande_client, IDligne_commande_client, journal FROM commande_sous_traitant
         WHERE IDcommande_sous_traitant IN (${cmdIds.slice(i, i + CHUNK).join(',')})`,
      )))
    }
    // Launched for a client: a client order on the header (the header link is
    // set exactly when the order was launched from a client line, #1249).
    const pourClient = entetes.filter((e) => Number(e.IDcommande_client) > 0 || Number(e.IDligne_commande_client) > 0)
    const clientCmdIds = [...new Set(pourClient.map((e) => Number(e.IDcommande_client)).filter((x) => x > 0))]
    const cmdClients = clientCmdIds.length
      ? await query<{ IDcommande_client: number; numero: number | string; IDclient: number }>(
        `SELECT IDcommande_client, numero, IDclient FROM commande_client WHERE IDcommande_client IN (${clientCmdIds.join(',')})`)
      : []
    const cmdClient = new Map(cmdClients.map((c) => [Number(c.IDcommande_client), c]))
    const clients = await noms('client', cmdClients.map((c) => Number(c.IDclient)))

    const parCmd = new Map<number, Piece[]>()
    for (const p of pieces) {
      const cmd = cmdDeLigne.get(p.source)
      if (cmd === undefined) continue
      const l = parCmd.get(cmd) ?? []
      l.push(p)
      parCmd.set(cmd, l)
    }

    const out: Constat[] = []
    for (const e of pourClient) {
      const id = Number(e.IDcommande_sous_traitant)
      const ps = parCmd.get(id)
      if (!ps?.length) continue
      const cle = `ecru_orphelin:${id}`
      const recente = Math.max(...ps.map((p) => p.saisieMs ?? 0))
      const c = {
        dateCommande: String(e.date_commande ?? '').replace(/[^0-9]/g, '').slice(0, 8),
        ageJours: recente ? Math.floor((ctx.nowMs - recente) / 86_400_000) : 0,
        journal: stripRtf(e.journal ?? ''),
      }
      const r = evaluerOrphelins(c)
      if (!r) { ctx.raison(cle, raisonOrphelins(c)); continue }
      const cc = cmdClient.get(Number(e.IDcommande_client))
      const pourQui = cc
        ? ` faites pour la commande N°${String(cc.numero)} (${clients.get(Number(cc.IDclient)) || `client #${cc.IDclient}`})`
        : ' faites pour une commande client'
      const kg = ps.reduce((s, p) => s + p.poids, 0)
      const numeros = ps.map((p) => p.numero).filter(Boolean).sort()
      out.push({
        cle,
        controle: 'ecru_orphelin',
        domaine: 'stock',
        gravite: r.gravite,
        titre: `Commande sous-traitant N°${id} · ${ps.length} pièce${ps.length > 1 ? 's' : ''} écru sans emploi`,
        message: `${ps.length} pièce${ps.length > 1 ? 's' : ''} (${fmt(kg)} kg : ${numeros.slice(0, 8).join(', ')}${numeros.length > 8 ? '…' : ''})${pourQui}, en stock sans affectation depuis ${c.ageJours} j, et rien d’écrit au journal de la commande. À faire : les affecter, ou écrire au journal de la commande sous-traitant pourquoi elles existent (pièces d’avance, accord avec le client…).`,
        lien: `/sous-traitants/commandes?commande=${id}`,
      })
    }
    return out
  },
}
