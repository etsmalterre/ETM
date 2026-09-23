// Agent « Superviseur » — checks on open ETM client orders (IDsociete 1, not
// the TRM mirrors, not donations):
//   - couverture: a line due within 21 days is not covered by rolls or planned
//     knitting → pièces à affecter / production à lancer;
//   - ennoblissement: écru reserved to a fini line is not at a dyer while the
//     délai approaches → ennoblissement à lancer.
// Both read the same open lines once per run (chargerLignes, memoised on the
// run's nowMs). The reservation gauge is the screen's own
// (lineReservationAggregates: donations and dyed écru excluded, planned
// knitting included), so a finding matches what Clients › Commandes shows.

import { query } from '../../../hfsql-auto.js'
import { consumedEcruIds } from '../../../fini-sources.js'
import { lineReservationAggregates } from '../../../../routes/commandes-client.js'
import type { Constat, ContexteControle, Controle } from '../types.js'
import { delaiTexte, evaluerCouverture, evaluerEnnoblissement, fmt } from './regles.js'
import { noms } from './noms.js'

interface LigneOuverte {
  id: number
  commandeId: number
  numero: number
  client: string
  typeKind: number
  refId: number
  reference: string
  quantite: number
  unite: number
  dateLivraison: string
  affecte: number
  expedie: number
}

const CHUNK = 300

async function lire(): Promise<LigneOuverte[]> {
  const cmds = await query<{ IDcommande_client: number; numero: number; IDclient: number; donation: number | null }>(
    `SELECT IDcommande_client, numero, IDclient, donation FROM commande_client
     WHERE IDsociete = 1 AND IDcommande_ETM = 0 AND est_soldee = 0`,
  )
  const ouvertes = cmds.filter((c) => Number(c.donation) !== 1)
  const parId = new Map(ouvertes.map((c) => [Number(c.IDcommande_client), c]))
  const ids = [...parId.keys()]
  const lignes: Array<Record<string, unknown>> = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    // TYPE is a reserved word → alias; never name the accented delai_annoncé.
    lignes.push(...(await query<Record<string, unknown>>(
      `SELECT IDligne_commande_client, IDcommande_client, TYPE AS type_kind, IDreference, quantite, unite, date_livraison
       FROM ligne_commande_client WHERE IDcommande_client IN (${ids.slice(i, i + CHUNK).join(',')})`,
    )))
  }
  const rouleaux = lignes.filter((l) => [1, 2].includes(Number(l.type_kind)))
  const agg = new Map<number, { total_metrage: number; total_poids: number; exp_metrage: number; exp_poids: number }>()
  for (let i = 0; i < rouleaux.length; i += CHUNK) {
    const m = await lineReservationAggregates(rouleaux.slice(i, i + CHUNK).map((l) => ({
      id: Number(l.IDligne_commande_client), typeKind: Number(l.type_kind), refId: Number(l.IDreference),
    })))
    for (const [k, v] of m) agg.set(k, v)
  }
  const [clients, finis, ecrus] = await Promise.all([
    noms('client', ouvertes.map((c) => Number(c.IDclient))),
    noms('ref_fini', rouleaux.filter((l) => Number(l.type_kind) === 2).map((l) => Number(l.IDreference))),
    noms('ref_ecru', rouleaux.filter((l) => Number(l.type_kind) === 1).map((l) => Number(l.IDreference))),
  ])
  return rouleaux.map((l) => {
    const id = Number(l.IDligne_commande_client)
    const c = parId.get(Number(l.IDcommande_client))!
    const typeKind = Number(l.type_kind)
    const unite = Number(l.unite) || 0
    const a = agg.get(id)
    const refId = Number(l.IDreference) || 0
    return {
      id,
      commandeId: Number(c.IDcommande_client),
      numero: Number(c.numero) || 0,
      client: clients.get(Number(c.IDclient)) || `Client #${c.IDclient}`,
      typeKind,
      refId,
      reference: (typeKind === 2 ? finis : ecrus).get(refId) || '',
      quantite: Number(l.quantite) || 0,
      unite,
      dateLivraison: typeof l.date_livraison === 'string' ? l.date_livraison : '',
      affecte: a ? (unite === 3 ? a.total_metrage : a.total_poids) : 0,
      expedie: a ? (unite === 3 ? a.exp_metrage : a.exp_poids) : 0,
    }
  })
}

let memo: { nowMs: number; lignes: Promise<LigneOuverte[]> } | null = null
function chargerLignes(ctx: ContexteControle): Promise<LigneOuverte[]> {
  if (!memo || memo.nowMs !== ctx.nowMs) memo = { nowMs: ctx.nowMs, lignes: lire() }
  return memo.lignes
}

const unite = (u: number) => (u === 3 ? 'Ml' : 'kg')
const titre = (l: LigneOuverte) => `Commande N°${l.numero} — ${l.client}${l.reference ? ` · ${l.reference}` : ''}`
const lien = (l: LigneOuverte) => `/clients/commandes?commande=${l.commandeId}`

export const controleCouverture: Controle = {
  id: 'couverture',
  domaine: 'commandes_client',
  libelle: 'Pièces à affecter / production à lancer',
  description:
    'Ligne de commande client dont le délai tombe dans les 21 jours (ou est dépassé depuis moins de 30 jours) et qui n’est pas couverte à 90 % par des pièces affectées ou du tricotage prévu. Urgent à 7 jours.',
  async executer(ctx) {
    const today = new Date(ctx.nowMs)
    const out: Constat[] = []
    for (const l of await chargerLignes(ctx)) {
      const r = evaluerCouverture(l, today)
      if (!r) continue
      const u = unite(l.unite)
      out.push({
        cle: `couverture:${l.id}`,
        controle: 'couverture',
        domaine: 'commandes_client',
        gravite: r.gravite,
        titre: titre(l),
        message: `Délai ${delaiTexte(l.dateLivraison, r.jours)} : ${fmt(l.affecte)} ${u} affectés sur ${fmt(l.quantite)} ${u} commandés, il manque ${fmt(r.manque)} ${u}. Pièces à affecter ou production à lancer.`,
        lien: lien(l),
      })
    }
    return out
  },
}

export const controleEnnoblissement: Controle = {
  id: 'ennoblissement',
  domaine: 'commandes_client',
  libelle: 'Ennoblissement à lancer',
  description:
    'Ligne fini dont le délai tombe dans les 30 jours alors que de l’écru lui est réservé sans être parti chez le teinturier (ni teint, ni donné). Urgent à 14 jours.',
  async executer(ctx) {
    const today = new Date(ctx.nowMs)
    const finis = (await chargerLignes(ctx)).filter((l) => l.typeKind === 2)
    const ids = finis.map((l) => l.id)
    const rows: Array<{ IDstock_ecru: number; IDligne_commande_client: number; poids: number | null }> = []
    for (let i = 0; i < ids.length; i += CHUNK) {
      rows.push(...(await query<{ IDstock_ecru: number; IDligne_commande_client: number; poids: number | null }>(
        `SELECT IDstock_ecru, IDligne_commande_client, poids FROM stock_ecru
         WHERE IDligne_commande_client IN (${ids.slice(i, i + CHUNK).join(',')})
           AND IDref_commande_affectation = 0
           AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)`,
      )))
    }
    // Dyed écru (own fini child, or component of a merged roll) is represented
    // by its fini roll — never "not sent" (#1188).
    const consomme = await consumedEcruIds(rows.map((r) => Number(r.IDstock_ecru)))
    const kg = new Map<number, number>()
    for (const r of rows) {
      if (consomme.has(Number(r.IDstock_ecru))) continue
      const lid = Number(r.IDligne_commande_client)
      kg.set(lid, (kg.get(lid) ?? 0) + (Number(r.poids) || 0))
    }
    const out: Constat[] = []
    for (const l of finis) {
      const k = kg.get(l.id) ?? 0
      const r = evaluerEnnoblissement(k, l.dateLivraison, today)
      if (!r) continue
      out.push({
        cle: `ennoblissement:${l.id}`,
        controle: 'ennoblissement',
        domaine: 'commandes_client',
        gravite: r.gravite,
        titre: titre(l),
        message: `Délai ${delaiTexte(l.dateLivraison, r.jours)} : ${fmt(k, 1)} kg d’écru réservés à la ligne ne sont pas partis en teinture. Ennoblissement à lancer.`,
        lien: lien(l),
      })
    }
    return out
  },
}
