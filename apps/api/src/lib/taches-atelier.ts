// Tâches d'atelier — the general jobs of the factory the bonnetiers do when few
// métiers run (cobwebs in the stock, the workshop floors…). Decision Vincent
// 2026-11-05. Tables: migration 0061 (`tache_atelier`, `…_realisation`,
// `…_participant`); routes: routes/atelier-taches.ts (`/api/atelier/taches`).
//
// The rules, all here:
//   - a task is a STANDING item: « Fait » adds a dated réalisation, the task
//     stays on the list — they recur, and a list that empties itself would be
//     re-typed every week;
//   - the list is sorted red, amber, then the OLDEST last réalisation first
//     (never done = top), so the neglected job rises by itself;
//   - a réalisation = the server's hour + its team: whoever declares it is in
//     the team by right, plus the coéquipiers he ticks (any live bonnetier,
//     régleurs included);
//   - only the declarer may cancel it, within DELAI_ANNULATION_MS (a wrong tap),
//     then it is history;
//   - only a régleur creates / edits / removes a task; « Supprimer » archives,
//     the réalisations stay;
//   - hour only, no duration. In-app only, no ERP screen yet;
//   - an optional frequency in days (régleur, migration 0062) colours the
//     « il y a N j » tag: red from F, amber from F − 10 %, green below
//     (`niveauTache`, Vincent 2026-11-05); without one the tag stays grey.

export const DELAI_ANNULATION_MS = 10 * 60 * 1000
export const LIBELLE_MAX = 120
export const DESCRIPTION_MAX = 1000
export const EQUIPE_MAX = 12

/** The team of a réalisation: the declarer first, then each coéquipier once.
 *  Unknown or archived ids are dropped by the caller (it holds the directory);
 *  returns null when the team is larger than any real job. */
export function equipeRealisation(declarant: number, coequipiers: number[]): number[] | null {
  const out = [declarant]
  for (const id of coequipiers) if (Number.isInteger(id) && id > 0 && !out.includes(id)) out.push(id)
  return out.length > EQUIPE_MAX ? null : out
}

export function annulableJusqua(faitLeMs: number): number {
  return faitLeMs + DELAI_ANNULATION_MS
}

export function peutAnnuler(r: { declare_par: number; fait_le_ms: number }, idBonnetier: number, nowMs: number): boolean {
  return r.declare_par === idBonnetier && nowMs < annulableJusqua(r.fait_le_ms)
}

export const FREQUENCE_MAX = 365
const JOUR_MS = 24 * 60 * 60 * 1000

/** Whole days since the last réalisation (24 h periods, like the phone's
 *  « il y a N j »); null when never done. */
export function ageJours(derniereMs: number | null, nowMs: number): number | null {
  return derniereMs === null ? null : Math.max(0, Math.floor((nowMs - derniereMs) / JOUR_MS))
}

/** First day of amber: the frequency minus 10 %, at least one day before it
 *  (30 → 27, 7 → 6). */
export function seuilAmbre(frequence: number): number {
  return frequence - Math.max(1, Math.ceil(frequence * 0.1))
}

export type NiveauTache = 'rouge' | 'ambre' | 'vert'

/** The tag colour (decision Vincent 2026-11-05). Red = due: to do now. Amber =
 *  due within 10 % of the frequency: can be done now, ahead. Green = done
 *  recently enough. No frequency = no colour (null). A task with a frequency
 *  that was never done is due. */
export function niveauTache(frequence: number | null, derniereMs: number | null, nowMs: number): NiveauTache | null {
  if (!frequence || frequence <= 0) return null
  const age = ageJours(derniereMs, nowMs)
  if (age === null || age >= frequence) return 'rouge'
  if (age >= seuilAmbre(frequence)) return 'ambre'
  return 'vert'
}

const RANG: Record<NiveauTache, number> = { rouge: 0, ambre: 1, vert: 2 }

/** Red, then amber, then everything else; inside a group never done first (by
 *  name), then the oldest last réalisation first. */
export function trierTaches<T extends { libelle: string; derniere_ms: number | null; niveau?: NiveauTache | null }>(
  taches: T[],
): T[] {
  const rang = (t: T) => (t.niveau === 'rouge' || t.niveau === 'ambre' ? RANG[t.niveau] : 2)
  return [...taches].sort((a, b) => {
    const r = rang(a) - rang(b)
    if (r !== 0) return r
    if (a.derniere_ms === null && b.derniere_ms === null) return a.libelle.localeCompare(b.libelle, 'fr')
    if (a.derniere_ms === null) return -1
    if (b.derniere_ms === null) return 1
    return a.derniere_ms - b.derniere_ms || a.libelle.localeCompare(b.libelle, 'fr')
  })
}

// ── Tâches ponctuelles (decision Vincent 2026-11-10) ──────────────────────
//
// A second category beside the standing (« récurrente ») tasks: a one-off
// request addressed to a GROUP, never to a person — « bonnetiers » or
// « régleurs » — which any member of that group handles, and which leaves the
// list once done or abandoned.
//
//   - who creates what: a bonnetier for the bonnetiers (with a due date) or for
//     the régleurs (WITHOUT one: it arrives red and the first régleur dates
//     it); a régleur for either group, always with a due date;
//   - the card is neutral until its due date has passed, then red — red only
//     for the group it is addressed to (the creator waiting on the other group
//     sees it neutral: waiting is never red, CLAUDE.md colour rule);
//   - red must be handled: Fait, Repousser (new date + motif) or Abandonner
//     (motif). Every dating, postponement and abandonment is an event row
//     (`tache_atelier_evenement`), kept to improve the system later;
//   - the creator keeps seeing his request, read-only, and what became of it
//     for VUE_CLOTUREE_JOURS after it closed (otherwise a refused request
//     vanishes and gets typed again).

export type Groupe = 'bonnetiers' | 'regleurs'
export type Categorie = 'recurrente' | 'ponctuelle'

/** Latest due date offered, in days after today. */
export const ECHEANCE_MAX_JOURS = 30
/** A closed request stays on its creator's list this many days. */
export const VUE_CLOTUREE_JOURS = 7
export const MOTIF_MAX = 500

export const MOTIFS_REPORT = {
  temps: 'Pas eu le temps',
  piece: 'En attente de matériel',
  personne: 'En attente de quelqu’un',
  autre: 'Autre',
} as const
export const MOTIFS_ABANDON = {
  inutile: 'Plus besoin',
  deja: 'Déjà réglé autrement',
  impossible: 'Pas faisable',
  autre: 'Autre',
} as const
export type MotifReport = keyof typeof MOTIFS_REPORT
export type MotifAbandon = keyof typeof MOTIFS_ABANDON

/** Today in Europe/Paris, ISO date (YYYY-MM-DD). */
export function aujourdhuiParis(nowMs: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(new Date(nowMs))
}

/** ISO date + n days (calendar arithmetic, no timezone involved). */
export function plusJours(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export interface Lecteur {
  id: number
  regleur: boolean
}

export function groupeDe(l: Lecteur): Groupe {
  return l.regleur ? 'regleurs' : 'bonnetiers'
}

export interface Ponctuelle {
  groupe: Groupe
  cree_par: number
  /** ISO date, null = not dated yet (a bonnetier's request to the régleurs). */
  echeance: string | null
  cloture: 'faite' | 'abandonnee' | null
}

/** The viewer is in the group the request is addressed to. */
export function estDestinataire(t: Pick<Ponctuelle, 'groupe'>, l: Lecteur): boolean {
  return t.groupe === groupeDe(l)
}

/** Shown to the group (and to its creator) while open. Once DONE it leaves
 *  every list at once — an empty list is the goal (Vincent 2026-11-10; a
 *  wrong « Fait » is undone from the phone's 8-second strip, not from a card
 *  left behind). Once ABANDONED it stays VUE_CLOTUREE_JOURS on its creator's
 *  « Mes demandes », with its motif: a refused request must not vanish
 *  silently, or it gets typed again. */
export function ponctuelleVisible(
  t: Ponctuelle & { cloturee_le_ms: number | null },
  l: Lecteur,
  nowMs: number,
): boolean {
  if (t.cloture === null) return estDestinataire(t, l) || t.cree_par === l.id
  if (t.cloture === 'faite' || t.cloturee_le_ms === null) return false
  return t.cree_par === l.id && nowMs - t.cloturee_le_ms < VUE_CLOTUREE_JOURS * JOUR_MS
}

/** Red = the viewer's group must act now: an undated request, or one whose
 *  due date has passed (red the day AFTER it — the date reads « au plus tard
 *  le »). Neutral otherwise, and always neutral for a creator outside the
 *  group (he is waiting) and for a closed request. */
export function niveauPonctuelle(t: Ponctuelle, l: Lecteur, aujourdhui: string): 'rouge' | null {
  if (t.cloture !== null || !estDestinataire(t, l)) return null
  if (t.echeance === null) return 'rouge'
  return aujourdhui > t.echeance ? 'rouge' : null
}

export type ActionPonctuelle = 'fait' | 'echeance' | 'reporter' | 'abandonner' | 'modifier'

/** What the viewer may do on an open request (Vincent 2026-11-10).
 *
 *  The rule: WHOEVER SETS THE DATE IS THE ONLY ONE WHO MOVES IT.
 *   - a request to the bonnetiers: its creator (bonnetier or régleur) dated
 *     it, so only he may Repousser or Abandonner; the other bonnetiers do it
 *     (Fait);
 *   - a request to the régleurs: the régleurs dated it, so they Repousser /
 *     Abandonner (and put its first date); the bonnetier who sent it can do
 *     nothing more — he only follows the date they chose.
 *  « Fait » belongs to the group (and to a régleur on what he sent the
 *  bonnetiers); « Modifier » (the wording) to the creator who still has a
 *  hand on it. */
export function actionsPonctuelle(t: Ponctuelle, l: Lecteur): ActionPonctuelle[] {
  if (t.cloture !== null) return []
  const membre = estDestinataire(t, l)
  const createur = t.cree_par === l.id
  const maitre = t.groupe === 'regleurs' ? membre : createur
  if (!membre && !maitre) return []
  const out: ActionPonctuelle[] = []
  if (t.echeance === null && membre) out.push('echeance')
  if (membre || (createur && l.regleur)) out.push('fait')
  if (t.echeance !== null && maitre) out.push('reporter')
  if (maitre) out.push('abandonner')
  if (createur && (membre || l.regleur)) out.push('modifier')
  return out
}

/** Red must be handled by someone who can move it (Repousser / Abandonner, or
 *  date it): only he gets the imposed sheet. The others see the red card and
 *  may still do it. */
export function doitTraiterRouge(actions: ActionPonctuelle[]): boolean {
  return actions.includes('reporter') || actions.includes('echeance')
}

/** Whether a new request carries a due date: 'interdite' for a bonnetier's
 *  request to the régleurs (they date it), 'requise' otherwise. Everyone may
 *  address either group. */
export function echeanceACreation(createur: Lecteur, groupe: Groupe): 'requise' | 'interdite' {
  return !createur.regleur && groupe === 'regleurs' ? 'interdite' : 'requise'
}

/** A due date is a real ISO date between today and today + ECHEANCE_MAX_JOURS. */
export function echeanceValide(iso: string, aujourdhui: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return false
  return iso >= aujourdhui && iso <= plusJours(aujourdhui, ECHEANCE_MAX_JOURS)
}

/** A motif is a known code, with a text when the code is « autre ». */
export function motifValide(code: string, texte: string, codes: Record<string, string>): boolean {
  if (!Object.prototype.hasOwnProperty.call(codes, code)) return false
  return code !== 'autre' || texte.trim().length > 0
}
