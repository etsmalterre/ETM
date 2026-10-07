// Agent « Superviseur » — « offer the next roll band ». When a line is entered
// within 15 % of the next (cheaper) tariff band, the line form shows Tricobot's
// « À proposer au client ? » (pricing-ligne-client.ts nearNextTranche). It is
// sometimes not offered (Vincent, 2026-10-07): this check reports every fresh
// line (order of the last PALIER_FENETRE_J days) still in that zone, priced
// by the SAME engine, so the office can call the client before production.
//
// Measured on prod 2026-10-07 over 2026: ~1 line a month within reach; lines
// already priced at the next band's price (the employee gave it anyway) are
// not reported — regles.ts evaluerPalierSuivant.

import { query } from '../../../hfsql-auto.js'
import { calcLignePriceClient } from '../../../pricing-ligne-client.js'
import type { Constat, Controle } from '../types.js'
import { evaluerPalierSuivant, fmt, joursAvant, PALIER_FENETRE_J, raisonPalierSuivant } from './regles.js'
import { noms } from './noms.js'

/** A quantity: up to 2 decimals, none when whole (« 0,63 », « 816 »). */
const qte = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 2 }).replace(/\s/g, ' ')
const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

export const controlePalierSuivant: Controle = {
  id: 'palier_suivant',
  domaine: 'commandes_client',
  libelle: 'Palier suivant à proposer',
  description:
    `Ligne d’une commande client des ${PALIER_FENETRE_J} derniers jours dont la quantité est à moins de 15 % du palier de rouleaux suivant, moins cher — le même calcul que Tricobot à la saisie (« À proposer au client ? »). Pas signalée quand le prix saisi est déjà celui du palier suivant, quand la baisse est sous 3 %, ni pour les sociétés du groupe.`,
  raisonAbsent: `Commande de plus de ${PALIER_FENETRE_J} jours, soldée, ou ligne supprimée.`,
  async executer(ctx) {
    const today = new Date(ctx.nowMs)
    const depuis = new Date(today)
    depuis.setDate(depuis.getDate() - PALIER_FENETRE_J)
    const cmds = await query<{ IDcommande_client: number; numero: number; IDclient: number; date_commande: string | null; donation: number | null }>(
      `SELECT IDcommande_client, numero, IDclient, date_commande, donation FROM commande_client
       WHERE IDsociete = 1 AND IDcommande_ETM = 0 AND est_soldee = 0 AND date_commande >= '${ymd(depuis)}' AND date_commande <= '${ymd(today)}'`,
    )
    // The group's own companies (client_interne — Malterre Fencing…) are not sold to.
    const internes = new Set((await query<{ IDclient: number }>(`SELECT IDclient FROM client WHERE client_interne = 1`)).map((c) => Number(c.IDclient)))
    const fraiches = cmds.filter((c) => Number(c.donation) !== 1 && !internes.has(Number(c.IDclient)))
    if (!fraiches.length) return []
    const parId = new Map(fraiches.map((c) => [Number(c.IDcommande_client), c]))
    // TYPE is a reserved word → alias. Rolls only: divers are not priced by band.
    const lignes = await query<{ id: number; cid: number; type_kind: number; IDreference: number; IDcolori: number; quantite: number | null; unite: number | null; prix: number | null }>(
      `SELECT IDligne_commande_client AS id, IDcommande_client AS cid, TYPE AS type_kind, IDreference, IDcolori, quantite, unite, prix
       FROM ligne_commande_client WHERE IDcommande_client IN (${[...parId.keys()].join(',')}) AND TYPE IN (1, 2)`,
    )
    const [clients, finis, ecrus] = await Promise.all([
      noms('client', fraiches.map((c) => Number(c.IDclient))),
      noms('ref_fini', lignes.filter((l) => Number(l.type_kind) === 2).map((l) => Number(l.IDreference))),
      noms('ref_ecru', lignes.filter((l) => Number(l.type_kind) === 1).map((l) => Number(l.IDreference))),
    ])
    const out: Constat[] = []
    for (const l of lignes) {
      const c = parId.get(Number(l.cid))!
      const cle = `palier_suivant:${Number(l.id)}`
      const quantite = Number(l.quantite) || 0
      const unite = Number(l.unite) || 0
      const r = await calcLignePriceClient({
        type: Number(l.type_kind), IDreference: Number(l.IDreference) || 0, IDcolori: Number(l.IDcolori) || 0,
        quantite, unite, IDclient: Number(c.IDclient) || 0, IDcommande_client: Number(c.IDcommande_client), IDligne_commande_client: Number(l.id),
      })
      if (!r.priceable) { ctx.raison(cle, 'Ligne sans tarif par rouleaux (prix saisi à la main).'); continue }
      const u = unite === 3 ? 'Ml' : 'kg'
      const ligne = { ...r, quantite, prixSaisi: Number(l.prix) || 0 }
      const p = evaluerPalierSuivant(ligne)
      if (!p) { ctx.raison(cle, raisonPalierSuivant(ligne, u)); continue }
      const ref = (Number(l.type_kind) === 2 ? finis : ecrus).get(Number(l.IDreference)) ?? ''
      const age = -(joursAvant(c.date_commande, today) ?? 0)
      out.push({
        cle,
        // A new quantity is a new question.
        empreinte: String(quantite),
        controle: 'palier_suivant',
        domaine: 'commandes_client',
        gravite: 'attention',
        titre: `Commande N°${Number(c.numero) || 0} — ${clients.get(Number(c.IDclient)) || `Client #${c.IDclient}`}${ref ? ` · ${ref}` : ''}`,
        message:
          `Commandé ${qte(quantite)} ${u} à ${fmt(p.prixActuel, 2)} €/${u} (${fmt(p.totalActuel)} €). ` +
          `Avec ${qte(r.nextTrancheGapQty)} ${u} de plus — ${r.nextTrancheRolls} rouleaux, ${qte(r.nextTrancheQty)} ${u} — le prix passe à ${fmt(r.nextTranchePrix!, 2)} €/${u} (−${fmt(p.baisse * 100)} %) : ${fmt(p.totalPalier)} € en tout. ` +
          `Commande saisie ${age > 0 ? `il y a ${age} jour${age > 1 ? 's' : ''}` : 'aujourd’hui'}, Tricobot le suggère à la saisie : le client a-t-il eu la proposition ?`,
        lien: `/clients/commandes?commande=${Number(c.IDcommande_client)}`,
      })
    }
    return out
  },
}
