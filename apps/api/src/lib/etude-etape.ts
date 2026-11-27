// Finis › Études coloris: where an étude stands, as its own screen shows it (Vincent 2026-11-27: « le code
// couleur rouge quand nous avons quelque chose à faire, et la section qui permet de comprendre l'étape en cours »).
//
// Nothing is decided here that is not already decided for the client line waiting for its étude
// (lib/etude-ligne-client.ts `etatEtude`, reused as is): who holds the étude — the ennoblisseur's lab or the
// client — since when, and the day Malterre chases (17 days for the lab, 21 for the client, a relance restarting
// the clock). This file only turns that state into what the screen prints:
//   - the list card's red (mps_designer §41): the relance is due → « Relancer l'ennoblisseur » / « Relancer le
//     client ». Never amber (chasing early improves nothing), neutral while the holder is in time;
//   - the « Prochaines étapes » card: the holder, what started its wait, its clock in working days — the same
//     window the lab reads in the espace partenaire (`fenetre`), so both sides count the same days.
// The gesture is the relance mail of the header's « @ » button (routes/etudes-coloris.ts …/:id/relance).

import { etatEtude, type AttenteEtude, type EtatEtude, type RelanceEtude, type SoumissionEtude } from './etude-ligne-client.js'
import { fenetre, type Fenetre } from './espace-partenaire-commandes.js'

export interface UrgenceEtude { niveau: 'rouge'; raison: string }

const iso = (ymd: string | null) => (ymd && /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null)

/** The étude's red: its relance is due (today or past). `today` YYYY-MM-DD. Pure. */
export function urgenceEtude(etat: Pick<EtatEtude, 'attente' | 'relanceLe'>, today: string): UrgenceEtude | null {
  if (etat.attente !== 'labo' && etat.attente !== 'client') return null
  const due = iso(etat.relanceLe)
  if (!due || today < due) return null
  return { niveau: 'rouge', raison: etat.attente === 'labo' ? 'Relancer l’ennoblisseur' : 'Relancer le client' }
}

export interface EtapeEtude {
  attente: AttenteEtude
  /** What started the holder's wait: the type received, the client's refusal of the last soumission (the lab
   *  works on the next one), or the soumission sent to the client. Null when nobody is waited for. */
  origine: 'reception' | 'refus' | 'soumission' | null
  /** YYYY-MM-DD: the day of that event (relances aside). */
  depuis: string | null
  /** Our relances of the current holder since then, and the latest. */
  relances: number
  derniereRelance: string | null
  /** The holder's clock in working days, from `depuis` (or our last relance) to the day we chase. */
  fenetre: Fenetre | null
  urgence: UrgenceEtude | null
  /** Accepted: the day of the client's yes. */
  accepteeLe: string | null
}

/** The étude's step for its screen. Dates in: YYYYMMDD (`etatEtude`'s); `today` and dates out: YYYY-MM-DD. Pure. */
export function etapeEtude(
  e: { statut: number; dateReception: string | null; derniereAction?: string | null },
  soumissions: readonly SoumissionEtude[],
  relances: readonly RelanceEtude[],
  today: string,
): EtapeEtude {
  const etat = etatEtude(e, soumissions, relances)
  const rien = { origine: null, depuis: null, relances: 0, derniereRelance: null, fenetre: null, urgence: null, accepteeLe: null }
  if (etat.attente === 'annulee') return { attente: 'annulee', ...rien }
  const triees = [...soumissions].sort((a, b) => (a.dateSoum ?? '').localeCompare(b.dateSoum ?? '') || a.id - b.id)
  if (etat.attente === 'acceptee') {
    const oui = [...triees].reverse().find((s) => s.accepte === 1)
    return { attente: 'acceptee', ...rien, accepteeLe: iso(oui?.dateReponse ?? null) ?? iso(e.derniereAction ?? null) }
  }
  const derniere = triees[triees.length - 1]
  const depuis = iso(etat.depuis)
  const echeance = iso(etat.relanceLe)
  return {
    attente: etat.attente,
    origine: etat.attente === 'client' ? 'soumission' : derniere ? 'refus' : etat.attenteDepuis ? 'reception' : null,
    depuis: iso(etat.attenteDepuis),
    relances: relances.filter((r) => r.cible === etat.attente && (!etat.attenteDepuis || r.le >= etat.attenteDepuis)).length,
    derniereRelance: iso(etat.derniereRelance),
    fenetre: depuis && echeance ? fenetre(depuis, echeance, today, true) : null,
    urgence: urgenceEtude(etat, today),
    accepteeLe: null,
  }
}

export function aujourdhuiIso(): string {
  const t = new Date()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}
