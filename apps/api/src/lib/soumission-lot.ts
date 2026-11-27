// The two soumissions of a dyed lot (LIVA #1313, decision Vincent 2026-10-22).
//
//   coloris     after the dye, BEFORE the stenter: MATEL (Perrine) writes « on
//               peut soumettre le lot MAxxxxx » in her answer to the point (§3),
//               we send MATEL the soumission sheet, MATEL prints it, staples a
//               sample and ships it to the client. The client's « ok » is the
//               « coloris validé »: we mail MATEL to put the lot on the stenter. A
//               refusal sends the lot back to the dye — same lot number.
//               Empreinte, Simone Pérèle, Agape, Allande, Séduction Santoul.
//   stabilites  the received rolls, BEFORE shipping: the client checks the
//               dimensional stability himself. A refusal = « Reprendre » (the
//               lot goes back on the stenter). Le Slip Français, La Fabrique,
//               Lemahieu, Thuasne…
//
// A client may ask both, per reference: designation_client.soumettre is a bit
// set (SOUMETTRE). In prod (2025 → 2026-10) no client did both, and no client
// of the coloris kind ever submitted after the reception: the history (one
// envoi_email type 15 per send, which cannot tell the two apart) is classified
// by date against the lot's reception — natureInferee().
//
// The lot exists before its reception once its coloris is submitted: the
// soumission creates its suivilot row without a reception date, and the BL
// completes that row (upsertSuivilot in routes/commandes-sous-traitant.ts).

import { mpsPg } from './mps-pg.js'

export type NatureSoumission = 'coloris' | 'stabilites'

/** designation_client.soumettre bits. */
export const SOUMETTRE = { stabilites: 1, coloris: 2 } as const

export const NATURE_LIBELLE: Record<NatureSoumission, string> = {
  coloris: 'coloris',
  stabilites: 'stabilités',
}

/** What a designation_client.soumettre value asks. Pure. */
export function naturesDemandees(soumettre: unknown): NatureSoumission[] {
  const v = Number(soumettre) || 0
  const out: NatureSoumission[] = []
  if (v & SOUMETTRE.coloris) out.push('coloris')
  if (v & SOUMETTRE.stabilites) out.push('stabilites')
  return out
}

/** The bit set for the two switches. Pure. */
export function valeurSoumettre(coloris: boolean, stabilites: boolean): number {
  return (coloris ? SOUMETTRE.coloris : 0) | (stabilites ? SOUMETTRE.stabilites : 0)
}

/** A send logged only in envoi_email (before 2026-10-22): the one the
 *  reference asks when it asks only one; else sent before the lot came back
 *  from the dyer it was a coloris soumission, after it a stabilités one.
 *  `envoi` / `reception` 'YYYY-MM-DD'. Pure. */
export function natureInferee(envoi: string, reception: string | null, demandees: NatureSoumission[] = []): NatureSoumission {
  if (demandees.length === 1) return demandees[0]
  return !reception || envoi < reception ? 'coloris' : 'stabilites'
}

// ── « Relancer le client » (Vincent 2026-11-27) ──────────
//
// The client has RELANCE_J.soumis working days (5) to answer a soumission.
// Beyond, the lot is red on Suivi lots; the relance is an e-mail sent from
// there to the client's soumission contacts, recorded in relance_soumission.
// It moves OUR next chase only (lib/cycle-ennoblissement.ts `relanceClientDue`).

/** What the relance mail names. Dates 'YYYY-MM-DD'. */
export interface LotARelancer {
  lot: string
  nature: NatureSoumission
  /** The soumission's send. */
  soumisLe: string
  /** Our relances since, sorted. */
  relances: string[]
  /** The lot came back from the dyer. */
  recu: boolean
  reference: string
  coloris: string
  /** The client's own name for the reference (designation_client). */
  designation: string
  refCommandeClient: string
}

const jjmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** The relance mail as it opens: short, the person reads it before it leaves. Pure. */
export function mailRelanceClient(l: LotARelancer): { subject: string; body: string } {
  const coloris = l.nature === 'coloris'
  const article = [l.reference, l.coloris].filter(Boolean).join(' - ')
  const derniere = l.relances.at(-1)
  const quoi = coloris ? 'le coloris' : 'les stabilités'
  const nom = l.designation || l.reference
  const pour = nom ? ` pour la référence ${nom}${l.coloris ? ` (coloris ${l.coloris})` : ''}` : ''
  return {
    subject: `Relance - Soumission ${coloris ? 'coloris' : 'lot'} ${l.lot}${article ? ` - ${article}` : ''}${l.refCommandeClient ? ` · ${l.refCommandeClient}` : ''}`,
    body:
      `Bonjour,\n\n` +
      `Nous vous avons soumis ${quoi} du lot ${l.lot}${pour} le ${jjmmaaaa(l.soumisLe)}` +
      `${derniere ? ` et, malgré notre relance du ${jjmmaaaa(derniere)}, nous` : ' et'} n’avons pas encore reçu votre réponse.\n\n` +
      (l.refCommandeClient ? `Réf commande client : ${l.refCommandeClient}\n\n` : '') +
      `${coloris && !l.recu ? 'Le lot attend votre accord chez notre ennoblisseur pour être terminé' : 'Le lot attend votre accord pour être expédié'} : ` +
      `la livraison de votre commande dépend de votre réponse.\n\n` +
      `Pouvez-vous nous la donner ?\n\n` +
      `Cordialement,`,
  }
}

// ── Writes (native PostgreSQL) ───────────────────────────

export async function enregistrerSoumission(opts: {
  nature: NatureSoumission
  idcommande: number
  ligneId: number
  idsuivilot: number
  lot: string
  idcommandeClient: number
  par: { id: number; nom: string }
  destinataires: string[]
}): Promise<void> {
  await mpsPg()`
    INSERT INTO soumission_lot (nature, idcommande_sous_traitant, idligne_commande_sous_traitant, idsuivilot, lot,
                                idcommande_client, envoyee_par_id, envoyee_par, destinataires)
    VALUES (${opts.nature}, ${opts.idcommande}, ${opts.ligneId}, ${opts.idsuivilot}, ${opts.lot.trim()},
            ${opts.idcommandeClient}, ${opts.par.id}, ${opts.par.nom}, ${opts.destinataires.join(', ')})`
}

/** « Relancer le client » (Vincent 2026-11-27): the relance e-mail left for a
 *  soumission whose answer is waited. The fact the cycle reads to push OUR next
 *  chase 5 working days further (lib/cycle-ennoblissement.ts `relanceClientDue`);
 *  the client's own delay never restarts. Table `relance_soumission` (0087),
 *  append-only — and never an envoi_email row of type 15, which is a soumission. */
export async function enregistrerRelanceClient(opts: {
  nature: NatureSoumission
  idsuivilot: number
  idcommande: number
  lot: string
  par: { id: number; nom: string }
  destinataires: string[]
}): Promise<void> {
  await mpsPg()`
    INSERT INTO relance_soumission (nature, idsuivilot, idcommande_sous_traitant, lot, relance_par_id, relance_par, destinataires)
    VALUES (${opts.nature}, ${opts.idsuivilot}, ${opts.idcommande}, ${opts.lot.trim()}, ${opts.par.id}, ${opts.par.nom}, ${opts.destinataires.join(', ')})`
}

export async function enregistrerOkRamer(opts: {
  idsuivilot: number
  idcommande: number
  lot: string
  par: { id: number; nom: string }
  destinataires: string[]
}): Promise<void> {
  await mpsPg()`
    INSERT INTO ok_a_ramer_envoi (idsuivilot, idcommande_sous_traitant, lot, envoye_par_id, envoye_par, destinataires)
    VALUES (${opts.idsuivilot}, ${opts.idcommande}, ${opts.lot.trim()}, ${opts.par.id}, ${opts.par.nom}, ${opts.destinataires.join(', ')})`
}
