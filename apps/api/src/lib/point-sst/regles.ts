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
//
// ⚠️ Generalise only what the DATA can tell. A removal whose reason lives
// outside ETM (« on attend la décision du client », a phone call…) is not a
// rule: db.ts carries it to the next points while the line's facts stay the
// same (`reprisesRetirees()`), it never becomes a filter here.

export const SECTIONS = [
  { n: 1, titre: 'Pour mémoire, sont prévues en sortie dans les prochains jours les commandes suivantes :', court: 'Sorties prévues' },
  { n: 2, titre: 'Puis-je avoir vos contrôles des lots suivants :', court: 'Contrôles' },
  { n: 3, titre: 'Puis-je soumettre ce jour les commandes suivantes :', court: 'Soumissions' },
  { n: 4, titre: 'Puis-je avoir les métrages des commandes suivantes :', court: 'Métrages' },
  { n: 5, titre: 'Pouvez-vous me confirmer les délais pour les commandes suivantes :', court: 'Délais' },
  { n: 6, titre: 'Avez-vous des études ?', court: 'Études' },
] as const

export type Section = 1 | 2 | 3 | 4 | 5 | 6

/** Hour (Paris) a scheduled point leaves on its day — 8:00, PE's habit (Vincent 2026-10-07; 9:00 before). */
export const HEURE_ENVOI = 8

/** Days ahead a planned exit is announced (§1). PE's points reach 7 to 15
 *  days; 9 matches the latest ones (05/10 → up to 14/10). */
export const HORIZON_SORTIES_J = 9
/** §3: a soumission is asked from the exit date up to this many days late. v4 (PE,
 *  08/10): never before the exit date in the point (he asks by mail when an order
 *  needs watching). */
export const HORIZON_SOUMISSION_J = 3
/** §3: no new question while a soumission went out less than this many days ago. */
export const SOUMISSION_RECENTE_J = 7

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
  /** Écru pieces handed to the dyer for this line (`stock_ecru.IDref_commande_affectation`). */
  ecruAffectes: number
  /** …of which already back dyed: own fini roll or component of a merged roll (lib/fini-sources.ts). */
  ecruRevenus: number
  dernierRecu: string | null
  /** Last soumission email sent for this order (envoi_email type 15). */
  dernierSoumis: string | null
  /** The client asks for soumissions (a contact with envoi_soumission, or the order already had one). */
  clientSoumission: boolean
  /** Lots received whose dyer control (laize, poids, stabilités) is incomplete, not yet validated (not in
   *  reprise). v8: a reference without « Contrôle ennoblisseur » never lands here (lib/controles-lot.ts). */
  lotsSansControle: string[]
  /** Lots « En reprise » (suivilot état 2 or an open reprise): the dyer reworks them — PE asks their délai (§5 « reprise »). */
  lotsEnReprise: string[]
  /** One of them is re-dyed, not only back on the stenter (reprise.nature, LIVA #1313). */
  repriseTeinture: boolean
  /** v7 (LIVA #1313) — the coloris soumission, before the stenter, from the Suivi lots
   *  cycle (etapeLot). Coloris submitted, the client has not answered: */
  lotsColorisSoumis: string[]
  /** …the client accepted the coloris, the lot is not received: MATEL rames it (« ok à ramer »). */
  lotsColorisValide: string[]
  /** …the client refused it before the stenter: MATEL dyes the lot again, same number. */
  lotsReteinture: string[]
  /** Lots received WITH the dyer measures, still open on our side (en contrôle / attente de décision):
   *  the dyer has answered, the next step is ours (v3, point du 07/10: 9029 « déjà contrôlée par
   *  Perrine, on attend le contrôle de Laëtitia »). */
  lotsAControler: string[]
  /** From when the délai is due (lib/delai-sst.ts echeanceDelai: latest « Repousser », else date_notif, else bon de commande + 3 working days, + 1 when the pieces were already at the dyer). */
  relance: string | null
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
  /** Set by db.ts when a person removed this very line (same facts) from the previous
   *  point: it is born removed, with who and why. */
  reprise?: RetraitRepris
}

export type RetraitRepris = { jour: string; par: string; texte: string }

const DAY_MS = 86_400_000
const ms = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
export const plusJours = (iso: string, n: number) => new Date(ms(iso) + n * DAY_MS).toISOString().slice(0, 10)
const ecart = (a: string, b: string) => Math.round((ms(a) - ms(b)) / DAY_MS)
export const jjmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/** MATEL's lots are stored « MA109366 »; PE writes « 109366 ». */
export const lotCourt = (lot: string) => lot.replace(/^MA/i, '').trim()

/** v5 (point du 12/10, 9003: « Pas de solde attendu : toutes les pièces ont été
 *  réceptionnées »): a line is complete when every écru piece handed to the dyer
 *  came back dyed, never by its metrage. The ordered Ml is a projection: 43 of
 *  43 pieces back made 94 % of it and v4 still asked for a « solde ». A metrage
 *  short of the client's order is a quality matter (charte ±5 %), not a question
 *  for the dyer (Vincent 2026-10-11). Without any écru handed over, rolls back
 *  make the line complete once its date has passed, a « solde » before (9013, 05/10). */
function recueComplete(l: LigneFait, jour: string): boolean {
  if (l.ecruAffectes > 0) return l.ecruRevenus >= l.ecruAffectes
  return l.nbRecus > 0 && (!l.dateLivraison || l.dateLivraison < jour)
}

const base = (l: LigneFait) => ({
  idcommande: l.idcommande,
  idligne: l.idligne,
  commande: String(l.idcommande),
  reference: l.reference,
  coloris: l.coloris,
})

/** §2: lots received without the dyer measures. */
function ligneControle(l: LigneFait): LignePoint {
  const s = l.lotsSansControle.length > 1 ? 's' : ''
  return {
    ...base(l),
    section: 2,
    cle: `controle:${l.idligne}`,
    datePrevue: null,
    commentaire: l.lotsSansControle.map(lotCourt).join(' et '),
    pourquoi: `Lot${s} reçu${s} sans toutes les mesures du teinturier (laize, poids, stabilités), pas encore validé${s}.`,
  }
}

/** The point of day `jour` ('YYYY-MM-DD'), in display order. §6 (« Avez-vous des
 *  études ? ») stays an open question without lines since v3 (point du 07/10,
 *  Pierre-Emmanuel: « je ne mets pas la liste des labos en attente »). */
export function construirePoint(jour: string, lignes: readonly LigneFait[]): LignePoint[] {
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
      out.push({ ...base(l), section: 5, cle: `reprise:${l.idligne}`, datePrevue: null, commentaire: l.repriseTeinture ? 'reprise teinture' : 'reprise', pourquoi: `Lot${l.lotsEnReprise.length > 1 ? 's' : ''} ${l.lotsEnReprise.map(lotCourt).join(' et ')} en reprise chez le teinturier : quand revient-il ?` })
    }
    // v7 (LIVA #1313): a coloris refused before the stenter goes back to the dye — same
    // lot number, the dyer gives the date like a reprise.
    if (l.lotsReteinture.length > 0) {
      const lots = l.lotsReteinture.map(lotCourt).join(' et ')
      out.push({ ...base(l), section: 5, cle: `reteinture:${l.idligne}`, datePrevue: null, commentaire: `reteinture ${lots}`, pourquoi: `Coloris du lot ${lots} refusé par le client avant la rame : le teinturier le reteint, quand revient-il ?` })
    }
    // v7 (points du 16/10 au 21/10: six « lot … ok à ramer » typed by PE in §4, and 9023
    // removed from §3 « ok à ramer, soumission validée par le client »): the client
    // accepted the coloris, the lot is on the stenter — its métrages are claimed until
    // the BL comes, and nothing else is asked about the line.
    if (l.lotsColorisValide.length > 0) {
      const lots = l.lotsColorisValide.map(lotCourt).join(' et ')
      out.push({ ...base(l), section: 4, cle: `coloris-valide:${l.idligne}`, datePrevue: null, commentaire: `${lots} coloris validé`, pourquoi: `Le client a validé le coloris du lot ${lots}, pas encore reçu : on réclame les métrages.` })
    }
    // A coloris submitted, refused or validated: the line waits on the client or the
    // dyer's stenter — no « puis-je soumettre », no exit to remind, no other métrages.
    if (l.lotsColorisSoumis.length > 0 || l.lotsColorisValide.length > 0 || l.lotsReteinture.length > 0) {
      if (l.lotsSansControle.length > 0) out.push(ligneControle(l))
      continue
    }

    const complete = recueComplete(l, jour)
    const partielle = l.nbRecus > 0 && !complete

    if (l.lotsSansControle.length > 0) out.push(ligneControle(l))
    if (complete || !l.dateLivraison) continue

    const retard = ecart(jour, l.dateLivraison) // > 0 = late
    const soumisRecent = !!l.dernierSoumis && ecart(jour, l.dernierSoumis) < SOUMISSION_RECENTE_J

    // §4 (métrages): since v4 only on the exit day (below). Not before: v2 (point du 06/10:
    // 9023, 9013, 8936 all wrong). PE also asks for métrages once the client approved the coloris (« ok à ramer » —
    // generated since v7, above) or the dyer announced the lot finished — that one
    // arrives by email only: the person adds it; reading Perrine's replies (phase 2).
    // v3 (point du 07/10, 9029): a lot already measured by the dyer waits for OUR control —
    // « puis-je soumettre ? » would ask MATEL what only we can answer.
    const attenteChezNous = l.lotsAControler.length > 0
    // v4 (point du 09/10, 9017 due 12/10): from the exit date only; before it, the line is a §1 exit.
    // v9 (point du 02/11, 9081 « c'est une référence que l'on soumet (LSF), la demande doit
    // apparaître dans la rubrique 3 »): a « solde » is asked as a soumission even when the lots
    // already back were just submitted or wait for our control: the question is about the rest.
    if (l.clientSoumission && (partielle || (!soumisRecent && !attenteChezNous)) && retard >= 0 && retard <= HORIZON_SOUMISSION_J) {
      out.push({ ...base(l), section: 3, cle: `soumission:${l.idligne}`, datePrevue: null, commentaire: partielle ? 'solde' : '', pourquoi: `Le client demande des soumissions ; sortie prévue le ${jjmm(l.dateLivraison)}, pas de soumission envoyée depuis ${SOUMISSION_RECENTE_J} jours.` })
      continue
    }
    // Late lines are no longer « prévues en sortie »: nothing generated (see §4 above). PE moves
    // the exit date at each of Perrine's answers (08/10), so a late date is one MATEL did not renew.
    if (retard > 0) continue
    // v3 (point du 07/10, 9037): nothing back yet and a soumission just sent — the order is
    // finished at the dyer and waits for the client, no exit to remind. Only when NOTHING
    // came back: a partly received line stays a « solde » exit (9013, point du 06/10).
    if (soumisRecent && l.nbRecus === 0) continue
    if (retard === 0) {
      // v4 (point du 09/10, 8982): due on the point's day, it is no longer announced but claimed:
      // « la sortie est prévue pour demain, donc il faut réclamer cette commande dans la rubrique 4 ».
      out.push({ ...base(l), section: 4, cle: `metrages:${l.idligne}`, datePrevue: null, commentaire: partielle ? 'solde' : '', pourquoi: `Sortie prévue ce jour (${jjmm(l.dateLivraison)}) : on réclame les métrages.` })
      continue
    }
    if (-retard <= HORIZON_SORTIES_J) {
      out.push({ ...base(l), section: 1, cle: `sortie:${l.idligne}`, datePrevue: l.dateLivraison, commentaire: partielle ? 'solde' : '', pourquoi: `Sortie prévue le ${jjmm(l.dateLivraison)} (dans les ${HORIZON_SORTIES_J} jours)${partielle ? ', déjà reçue en partie' : ''}.` })
    }
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
