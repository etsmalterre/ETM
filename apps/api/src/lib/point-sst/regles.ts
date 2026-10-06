// Point sous-traitant — the rules that turn ETM's data into the six sections
// of the daily « Point du JJ/MM » Pierre-Emmanuel sends to MATEL (since 2015,
// a Word file written by hand every evening). Pure: lecture.ts reads the
// facts, this decides; tested in regles.test.ts.
//
// ⚠️ v1 rules are ESTIMATES (Vincent 2026-10-05: « start with your best
// estimate, iterate with the users »), read off 8 of Pierre-Emmanuel's points
// (22/09 → 05/10/2026) against the database. Each line carries its `pourquoi`
// so the person checking the point sees which rule put it there, and every
// correction (edit, removal, added line, Tricobot button) is what the next
// version is written from. Bump VERSION in the automate with any change here.

export const SECTIONS = [
  { n: 1, titre: 'Pour mémoire, sont prévues en sortie dans les prochains jours les commandes suivantes :', court: 'Sorties prévues' },
  { n: 2, titre: 'Puis-je avoir vos contrôles des lots suivants :', court: 'Contrôles' },
  { n: 3, titre: 'Puis-je soumettre ce jour les commandes suivantes :', court: 'Soumissions' },
  { n: 4, titre: 'Puis-je avoir les métrages des commandes suivantes :', court: 'Métrages' },
  { n: 5, titre: 'Pouvez-vous me confirmer les délais pour les commandes suivantes :', court: 'Délais' },
  { n: 6, titre: 'Avez-vous des études ?', court: 'Études' },
] as const

export type Section = 1 | 2 | 3 | 4 | 5 | 6

/** Days ahead a planned exit is announced (§1). PE's points reach 7 to 15
 *  days; 9 matches the latest ones (05/10 → up to 14/10). */
export const HORIZON_SORTIES_J = 9
/** §3: a soumission is asked when the line is due within this many days (or late). */
export const HORIZON_SOUMISSION_J = 3
/** §3: no new question while a soumission went out less than this many days ago. */
export const SOUMISSION_RECENTE_J = 7
/** A line counts as fully received from this share of its ordered metrage. */
export const PART_RECUE_COMPLETE = 0.95

/** One open dyer line, as lecture.ts reads it. Dates are 'YYYY-MM-DD'. */
export interface LigneFait {
  idcommande: number
  idligne: number
  reference: string
  coloris: string
  sstatut: string
  dateLivraison: string | null
  /** Ordered quantity (Ml for a dyer line); 0 = not given (écru/écru lines). */
  quantite: number
  nbRecus: number
  metrageRecu: number
  dernierRecu: string | null
  /** Last soumission email sent for this order (envoi_email type 15). */
  dernierSoumis: string | null
  /** The client asks for soumissions (a contact with envoi_soumission, or the order already had one). */
  clientSoumission: boolean
  /** Lots received whose dyer measures (laize / poids) are still missing, not yet validated (not in reprise). */
  lotsSansControle: string[]
  /** Lots « En reprise » (suivilot état 2): the dyer reworks them — PE asks their délai (§5 « reprise »). */
  lotsEnReprise: string[]
  /** The order's relance date (commande_sous_traitant.date_notif, bon de commande + 3 working days). */
  relance: string | null
}

export interface EtudeFait {
  idetude: number
  libelle: string
  reference: string
  client: string
}

export interface LignePoint {
  section: Section
  /** Stable key: « Actualiser » merges on it. */
  cle: string
  idcommande: number
  idligne: number
  commande: string
  reference: string
  coloris: string
  datePrevue: string | null
  commentaire: string
  pourquoi: string
}

const DAY_MS = 86_400_000
const ms = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
export const plusJours = (iso: string, n: number) => new Date(ms(iso) + n * DAY_MS).toISOString().slice(0, 10)
const ecart = (a: string, b: string) => Math.round((ms(a) - ms(b)) / DAY_MS)
export const jjmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/** MATEL's lots are stored « MA109366 »; PE writes « 109366 ». */
export const lotCourt = (lot: string) => lot.replace(/^MA/i, '').trim()

/** Without an ordered quantity (écru/écru lines carry 0) a line with rolls
 *  back is complete once its date has passed, a « solde » before (9013, 05/10). */
function recueComplete(l: LigneFait, jour: string): boolean {
  if (l.quantite > 0) return l.metrageRecu >= PART_RECUE_COMPLETE * l.quantite
  return l.nbRecus > 0 && (!l.dateLivraison || l.dateLivraison < jour)
}

const base = (l: LigneFait) => ({
  idcommande: l.idcommande,
  idligne: l.idligne,
  commande: String(l.idcommande),
  reference: l.reference,
  coloris: l.coloris,
})

/** The point of day `jour` ('YYYY-MM-DD'), sections 1 to 6, in display order. */
export function construirePoint(jour: string, lignes: readonly LigneFait[], etudes: readonly EtudeFait[]): LignePoint[] {
  const out: LignePoint[] = []
  for (const l of lignes) {
    const statut = l.sstatut ?? ''
    if (statut === 'Non_Envoye') continue // the bon de commande has not left: nothing to ask yet
    if (statut === 'Attente_Delai') {
      // v2 (point du 06/10): PE asks once the relance is due, not the day after the bon de commande.
      if (l.relance && l.relance > jour) continue
      out.push({ ...base(l), section: 5, cle: `delai:${l.idligne}`, datePrevue: null, commentaire: '', pourquoi: `Bon de commande envoyé, délai pas encore donné${l.relance ? ` (relance prévue le ${jjmm(l.relance)})` : ''}.` })
      continue
    }
    if (l.lotsEnReprise.length > 0) {
      // v2 (point du 06/10: 8929 lot 109102): a lot in reprise is a délai question, not a control one.
      out.push({ ...base(l), section: 5, cle: `reprise:${l.idligne}`, datePrevue: null, commentaire: 'reprise', pourquoi: `Lot${l.lotsEnReprise.length > 1 ? 's' : ''} ${l.lotsEnReprise.map(lotCourt).join(' et ')} en reprise chez le teinturier : quand revient-il ?` })
    }
    const complete = recueComplete(l, jour)
    const partielle = l.nbRecus > 0 && !complete

    if (l.lotsSansControle.length > 0) {
      out.push({
        ...base(l),
        section: 2,
        cle: `controle:${l.idligne}`,
        datePrevue: null,
        commentaire: l.lotsSansControle.map(lotCourt).join(' et '),
        pourquoi: `Lot${l.lotsSansControle.length > 1 ? 's' : ''} reçu${l.lotsSansControle.length > 1 ? 's' : ''} sans les mesures du teinturier (laize, poids), pas encore validé${l.lotsSansControle.length > 1 ? 's' : ''}.`,
      })
    }
    if (complete || !l.dateLivraison) continue

    const retard = ecart(jour, l.dateLivraison) // > 0 = late
    const soumisRecent = !!l.dernierSoumis && ecart(jour, l.dernierSoumis) < SOUMISSION_RECENTE_J

    // §4 (métrages) is NOT generated since v2 (point du 06/10: 9023, 9013, 8936 all wrong).
    // PE asks for métrages once the client approved the soumission (« ok à ramer ») or
    // the dyer announced the lot finished — both arrive by email, ETM records neither
    // (reponse_soumission is unused since 2025). The person adds them; reading Perrine's
    // replies (phase 2) is what will fill this section.
    if (l.clientSoumission && !soumisRecent && retard >= -HORIZON_SOUMISSION_J && retard <= HORIZON_SOUMISSION_J) {
      out.push({ ...base(l), section: 3, cle: `soumission:${l.idligne}`, datePrevue: null, commentaire: partielle ? 'solde' : '', pourquoi: `Le client demande des soumissions ; sortie prévue le ${jjmm(l.dateLivraison)}, pas de soumission envoyée depuis ${SOUMISSION_RECENTE_J} jours.` })
      continue
    }
    // Late lines are no longer « prévues en sortie »: nothing generated (see §4 above).
    if (retard > 0) continue
    if (-retard <= HORIZON_SORTIES_J) {
      out.push({ ...base(l), section: 1, cle: `sortie:${l.idligne}`, datePrevue: l.dateLivraison, commentaire: partielle ? 'solde' : '', pourquoi: `Sortie prévue le ${jjmm(l.dateLivraison)} (dans les ${HORIZON_SORTIES_J} jours)${partielle ? ', déjà reçue en partie' : ''}.` })
    }
  }
  for (const e of etudes) {
    out.push({
      section: 6,
      cle: `etude:${e.idetude}`,
      idcommande: 0,
      idligne: 0,
      commande: '',
      reference: e.reference,
      coloris: e.libelle,
      datePrevue: null,
      commentaire: e.client,
      pourquoi: 'Étude coloris « Attente labo » chez ce teinturier.',
    })
  }
  return trier(out)
}

/** Section order; §1 by exit date then most recent order first (PE's order),
 *  the others most recent order first. */
export function trier<T extends Pick<LignePoint, 'section' | 'datePrevue' | 'idcommande' | 'cle'>>(lignes: T[]): T[] {
  return [...lignes].sort((a, b) =>
    a.section - b.section
    || (a.section === 1 ? (a.datePrevue ?? '').localeCompare(b.datePrevue ?? '') : 0)
    || b.idcommande - a.idcommande
    || a.cle.localeCompare(b.cle),
  )
}

/** The working day a point prepared on `jour` is for (Friday → Monday). */
export function jourSuivantOuvre(jour: string): string {
  let j = plusJours(jour, 1)
  while ([0, 6].includes(new Date(ms(j)).getUTCDay())) j = plusJours(j, 1)
  return j
}
