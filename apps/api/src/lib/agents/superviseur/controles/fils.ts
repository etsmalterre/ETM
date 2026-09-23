// Agent « Superviseur » — yarn checks:
//   - fil_a_commander: a (fil, coloris) whose disponible (en stock + commandé −
//     besoin) is negative, computed by lib/fil-etat.ts — the SAME numbers as
//     the « État des stocks de fil » widget. The pairs checked are the ones in
//     use by open knitting orders (asso_fil_lignecmdsst, and OFs through
//     asso_fil_of since #1159). Limit: the need only covers knitting orders
//     already created, not client lines not yet launched (Fils › Prévisions).
//   - fil_affectation: an open Tricotage Malterre knitting line whose TRM
//     mirror has no OF yet and whose écru composition has a yarn not affected
//     on the ETM line — TRM cannot launch the OF (409 fil_non_affecte, #1159).

import { query } from '../../../hfsql-auto.js'
import { calculerEtatFil } from '../../../fil-etat.js'
import { missingAffectations } from '../../../affectation-fil-trm.js'
import { TRICOTAGE_MALTERRE_ID } from '../../../../routes/commandes-sous-traitant.js'
import type { Constat, Controle } from '../types.js'
import { evaluerAffectationFil, evaluerFil, fmt } from './regles.js'
import { noms } from './noms.js'

const libelleFil = (ref: string | undefined, coloris: string | undefined, rf: number) =>
  [ref || `Fil #${rf}`, coloris].filter(Boolean).join(' ')

export const controleFilACommander: Controle = {
  id: 'fil_a_commander',
  domaine: 'fils',
  libelle: 'Fil à commander',
  description:
    'Fil (référence + coloris) utilisé par une commande de tricotage en cours dont le stock plus ce qui est en commande ne couvre pas le besoin restant (même calcul que le widget « État des stocks de fil »). Tolérance 5 kg, urgent à partir de 50 kg manquants.',
  async executer() {
    // All-ASCII columns, no CONVERT: the same JOIN shapes as lib/fil-etat.ts.
    const [p1, p2] = await Promise.all([
      query<{ rf: number; cf: number }>(
        `SELECT DISTINCT sf.IDref_fil AS rf, sf.IDcolori_fil AS cf
         FROM asso_fil_lignecmdsst a
         JOIN stock_fil sf ON a.IDstock_fil = sf.IDstock_fil
         JOIN ligne_commande_sous_traitant lcs ON a.IDligne_commande_sous_traitant = lcs.IDligne_commande_sous_traitant
         JOIN commande_sous_traitant cst ON lcs.IDcommande_sous_traitant = cst.IDcommande_sous_traitant
         WHERE cst.est_soldee = 0`,
      ),
      query<{ rf: number; cf: number }>(
        `SELECT DISTINCT sf.IDref_fil AS rf, sf.IDcolori_fil AS cf
         FROM asso_fil_of a
         JOIN stock_fil sf ON a.IDstock_fil = sf.IDstock_fil
         JOIN ordre_fabrication o ON a.IDordre_fabrication = o.IDordre_fabrication
         JOIN ligne_commande_client l ON o.IDligne_commande_client = l.IDligne_commande_client
         JOIN ligne_commande_sous_traitant lcs ON l.IDligne_commande_ETM = lcs.IDligne_commande_sous_traitant
         JOIN commande_sous_traitant cst ON lcs.IDcommande_sous_traitant = cst.IDcommande_sous_traitant
         WHERE cst.est_soldee = 0`,
      ),
    ])
    const paires = new Map<string, [number, number]>()
    for (const r of [...p1, ...p2]) {
      const rf = Number(r.rf) || 0
      const cf = Number(r.cf) || 0
      if (rf > 0) paires.set(`${rf}:${cf}`, [rf, cf])
    }
    const manques: Array<{ rf: number; cf: number; etat: Awaited<ReturnType<typeof calculerEtatFil>>; r: NonNullable<ReturnType<typeof evaluerFil>> }> = []
    for (const [rf, cf] of paires.values()) {
      const etat = await calculerEtatFil(rf, cf)
      const r = evaluerFil(etat.disponible)
      if (r) manques.push({ rf, cf, etat, r })
    }
    if (!manques.length) return []
    const [refs, coloris] = await Promise.all([noms('ref_fil', manques.map((m) => m.rf)), noms('colori_fil', manques.map((m) => m.cf))])
    return manques.map((m): Constat => ({
      cle: `fil_a_commander:${m.rf}:${m.cf}`,
      controle: 'fil_a_commander',
      domaine: 'fils',
      gravite: m.r.gravite,
      titre: `Fil ${libelleFil(refs.get(m.rf), coloris.get(m.cf), m.rf)}`,
      message: `Besoin restant ${fmt(m.etat.besoin)} kg pour les commandes de tricotage en cours, ${fmt(m.etat.en_stock)} kg en stock et ${fmt(m.etat.commande)} kg en commande : il manque ${fmt(m.r.manque)} kg. Fil à commander.`,
      lien: '/fils/commandes',
    }))
  },
}

export const controleAffectationFil: Controle = {
  id: 'fil_affectation',
  domaine: 'sous_traitants',
  libelle: 'Fil à affecter (Tricotage Malterre)',
  description:
    'Ligne de tricotage ouverte chez Tricotage Malterre, sans OF lancé, dont un fil de la composition n’est affecté sur la ligne ETM : TRM ne peut pas lancer l’OF tant qu’il ne l’est pas (onglet Stock fil). Signalé à partir du lendemain de la commande.',
  async executer(ctx) {
    const today = new Date(ctx.nowMs)
    const cmds = await query<{ IDcommande_sous_traitant: number; date_commande: string | null }>(
      `SELECT IDcommande_sous_traitant, date_commande FROM commande_sous_traitant
       WHERE IDsous_traitant = ${TRICOTAGE_MALTERRE_ID} AND est_soldee = 0`,
    )
    if (!cmds.length) return []
    const dateCmd = new Map(cmds.map((c) => [Number(c.IDcommande_sous_traitant), typeof c.date_commande === 'string' ? c.date_commande.slice(0, 8) : '']))
    const lignes = (await query<Record<string, unknown>>(
      `SELECT IDligne_commande_sous_traitant AS id, IDcommande_sous_traitant AS cmd, TYPE AS type_kind,
              IDreference, IDColoris AS coloris, sstatut
       FROM ligne_commande_sous_traitant WHERE IDcommande_sous_traitant IN (${[...dateCmd.keys()].join(',')})`,
    )).filter((l) => [0, 1].includes(Number(l.type_kind)) && !String(l.sstatut ?? '').startsWith('Termin'))
    if (!lignes.length) return []
    const lids = lignes.map((l) => Number(l.id))
    const mirrors = await query<{ IDligne_commande_client: number; IDligne_commande_ETM: number }>(
      `SELECT IDligne_commande_client, IDligne_commande_ETM FROM ligne_commande_client WHERE IDligne_commande_ETM IN (${lids.join(',')})`,
    )
    const trmParSst = new Map(mirrors.map((m) => [Number(m.IDligne_commande_ETM), Number(m.IDligne_commande_client)]))
    const trmIds = [...trmParSst.values()].filter((x) => x > 0)
    const avecOf = new Set(
      trmIds.length
        ? (await query<{ IDligne_commande_client: number }>(
          `SELECT IDligne_commande_client FROM ordre_fabrication WHERE IDligne_commande_client IN (${trmIds.join(',')})`,
        )).map((o) => Number(o.IDligne_commande_client))
        : [],
    )
    const asso = await query<{ l: number; rf: number; cf: number }>(
      `SELECT a.IDligne_commande_sous_traitant AS l, sf.IDref_fil AS rf, sf.IDcolori_fil AS cf
       FROM asso_fil_lignecmdsst a JOIN stock_fil sf ON a.IDstock_fil = sf.IDstock_fil
       WHERE a.IDligne_commande_sous_traitant IN (${lids.join(',')})`,
    )
    const trouves: Array<{ ligne: number; cmd: number; manquants: Array<{ IDref_fil: number; IDcolori_fil: number }> }> = []
    for (const l of lignes) {
      const trm = trmParSst.get(Number(l.id))
      if (trm && avecOf.has(trm)) continue // OF launched: the lots were chosen
      // Composition: coloris-scoped first, every variant of the écru as fallback
      // (same rule as the OF creation dialog, of-trm.ts).
      let comp = await query<{ IDref_fil: number; IDcolori_fil: number }>(
        `SELECT IDref_fil, IDcolori_fil FROM composition_ecru
         WHERE IDref_ecru = ${Number(l.IDreference) || 0} AND IDcolori_ecru = ${Number(l.coloris) || 0} AND IDref_fil > 0`,
      )
      if (!comp.length) {
        comp = await query<{ IDref_fil: number; IDcolori_fil: number }>(
          `SELECT IDref_fil, IDcolori_fil FROM composition_ecru WHERE IDref_ecru = ${Number(l.IDreference) || 0} AND IDref_fil > 0`,
        )
      }
      const lots = asso.filter((a) => Number(a.l) === Number(l.id)).map((a) => ({
        IDstock_fil: 0, IDref_fil: Number(a.rf) || 0, IDcolori_fil: Number(a.cf) || 0, lot: '', quantite: 0,
      }))
      const manquants = missingAffectations(comp.map((c) => ({ IDref_fil: Number(c.IDref_fil) || 0, IDcolori_fil: Number(c.IDcolori_fil) || 0 })), lots)
      if (evaluerAffectationFil(manquants.length, dateCmd.get(Number(l.cmd)) ?? '', today)) {
        trouves.push({ ligne: Number(l.id), cmd: Number(l.cmd), manquants })
      }
    }
    if (!trouves.length) return []
    const tous = trouves.flatMap((t) => t.manquants)
    const [refs, coloris] = await Promise.all([noms('ref_fil', tous.map((m) => m.IDref_fil)), noms('colori_fil', tous.map((m) => m.IDcolori_fil))])
    return trouves.map((t): Constat => ({
      cle: `fil_affectation:${t.ligne}`,
      controle: 'fil_affectation',
      domaine: 'sous_traitants',
      gravite: 'attention',
      titre: `Commande sous-traitant N°${t.cmd} — Tricotage Malterre`,
      message: `Fil non affecté : ${t.manquants.map((m) => libelleFil(refs.get(m.IDref_fil), coloris.get(m.IDcolori_fil), m.IDref_fil)).join(', ')}. TRM ne peut pas lancer l’OF tant qu’il n’est pas affecté (onglet Stock fil).`,
      lien: `/sous-traitants/commandes?commande=${t.cmd}`,
    }))
  },
}
