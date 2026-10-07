// Agent « Rapport d'activité » — the pure rules: the period a report covers,
// which app an action belongs to, how it reads in French, and the signals
// raised by code (never by the model, so they cannot be invented nor missed).

import { msHeureParis, partiesParis } from '../../pointage-etat.js'
import type { LigneJournal } from '../../journal-activite.js'

/** The report goes out at these hours (Paris)… (decision Vincent 2026-10-07) */
export const HEURES_RAPPORT: readonly number[] = [9, 10, 11, 12, 15, 16, 17, 18]
/** …on working days (ISO, 1 = Monday): Monday 9:00 covers the weekend. */
export const JOURS_RAPPORT: readonly number[] = [1, 2, 3, 4, 5]
export const HEURES_TEXTE = `${HEURES_RAPPORT.slice(0, -1).join(', ')} et ${HEURES_RAPPORT[HEURES_RAPPORT.length - 1]} h`

/** The report slots at or before `nowMs`, latest first (two are enough). */
function creneauxAvant(nowMs: number, n: number): number[] {
  const out: number[] = []
  const t = partiesParis(nowMs)
  for (let i = 0; i < 10 && out.length < n; i++) {
    const j = partiesParis(msHeureParis(t.y, t.mo, t.d, 12) - i * 86_400_000)
    if (!JOURS_RAPPORT.includes(new Date(Date.UTC(j.y, j.mo - 1, j.d)).getUTCDay() || 7)) continue
    for (const h of [...HEURES_RAPPORT].reverse()) {
      const ms = msHeureParis(j.y, j.mo, j.d, h)
      if (ms <= nowMs && out.length < n) out.push(ms)
    }
  }
  return out
}

/** Since the previous report, so nothing falls between two reports. A
 *  scheduled run (made at its slot, or caught up later) covers from the slot
 *  before its own; a manual launch covers from the last scheduled slot. */
export function periode(nowMs: number, planifie: boolean): { du: number; au: number } {
  const [dernier, precedent] = creneauxAvant(nowMs, 2)
  return { du: planifie ? precedent : dernier, au: nowMs }
}

export type AppActivite = 'ETM' | 'TRM'

/** TRM when the page was a TRM app (host trm./atelier./trs., dev ports 517x)
 *  or the route is a TRM one (`-trm`, pointage, atelier); ETM otherwise. */
export function appDe(l: Pick<LigneJournal, 'origine' | 'chemin'>): AppActivite {
  const o = (l.origine ?? '').toLowerCase()
  if (/^(trm|atelier|trs|pointage)\./.test(o) || /:517\d$/.test(o)) return 'TRM'
  if (/^\/api\/[a-z-]*-trm(\/|$)|^\/api\/(pointage|pointage-admin|atelier|trs|planning-atelier|of-trm)(\/|$)/.test(l.chemin)) return 'TRM'
  return 'ETM'
}

/** API prefix → the menu it serves, as the person sees it. */
const MENUS: Record<string, string> = {
  'actions-qualite': 'Qualité › Actions',
  'agents-ia': 'Agents IA',
  'agents-ia-trm': 'Agents IA',
  atelier: 'Atelier',
  automates: 'Agents IA › Automates',
  'automates-trm': 'Agents IA › Automates',
  clients: 'Clients › Gestion',
  'clients-trm': 'Clients › Gestion',
  'commandes-client': 'Clients › Commandes',
  'commandes-fil': 'Fils › Commandes',
  'commandes-sous-traitant': 'Sous-traitants › Commandes',
  'commandes-trm': 'Commandes',
  devis: 'Clients › Devis',
  'dossiers-qualite': 'Qualité › Dossiers',
  entreprises: 'Réseau › Entreprises',
  'espace-client': 'Clients › Espace client',
  'etiquettes-sp': 'Clients › Étiquettes',
  'etudes-coloris': 'Finis › Études coloris',
  expeditions: 'Clients › Expéditions',
  'expeditions-trm': 'Expéditions',
  factures: 'Clients › Facturation',
  'factures-sst': 'Sous-traitants › Factures',
  'factures-trm': 'Facturation',
  fournisseurs: 'Fils › Gestion',
  'maintenance-trm': 'Maintenance',
  notifications: 'Notifications',
  'of-trm': 'Ordres de fabrication',
  outils: 'Paramètres › Outils',
  'outils-trm': 'Paramètres › Outils',
  permissions: 'Paramètres › Utilisateurs',
  'permissions-trm': 'Paramètres › Utilisateurs',
  'planning-atelier': 'Planning atelier',
  'planning-prod-trm': 'Planning production',
  pointage: 'Pointage',
  'pointage-admin': 'Pointage',
  'points-sst': 'Sous-traitants › Point',
  'prime-trm': 'Prime',
  prospects: 'Prospects',
  rapports: 'Rapports',
  'rapports-trm': 'Rapports',
  'references-divers': 'Divers › Références',
  'references-ecru': 'Tombé Métier › Références',
  'references-fil': 'Fils › Références',
  'references-fini': 'Finis › Références',
  'references-rectiligne': 'Tombé Métier › Références',
  'retours-client-trm': 'Retours client',
  'sous-traitants': 'Sous-traitants › Gestion',
  stock: 'Stock',
  'stock-divers': 'Divers › Stock',
  'suivi-lots': 'Qualité › Suivi lots',
  'tarifs-fini': 'Finis › Tarifs',
  tickets: 'Tickets',
  'tickets-trm': 'Tickets',
  transferts: 'Transferts',
  tricobot: 'Tricobot',
  'user-emails': 'Paramètres › Utilisateurs',
  'visitage-trm': 'Visitage',
  comptes: 'Paramètres › Utilisateurs',
  auth: 'Connexion',
}

export function menuDe(chemin: string): string {
  const seg = chemin.replace(/^\/api\//, '').split('/')[0] ?? ''
  return MENUS[seg] ?? seg
}

const VERBES: Record<string, string> = { POST: 'Action / création', PUT: 'Modification', PATCH: 'Modification', DELETE: 'Suppression' }

/** « Modification — commandes-client 1234 › lignes 55 ». */
export function libelleAction(l: Pick<LigneJournal, 'methode' | 'chemin'>): string {
  const objet = l.chemin.replace(/^\/api\//, '').split('/').filter(Boolean).join(' › ')
  return `${VERBES[l.methode] ?? `Lecture`} — ${objet}`
}

export type Resultat = 'ok' | 'refus' | 'erreur'

/** 2xx/3xx = done, 4xx = refused by a rule or a right, 5xx = technical error. */
export function resultatDe(statut: number): Resultat {
  return statut >= 500 ? 'erreur' : statut >= 400 ? 'refus' : 'ok'
}

export interface Signal {
  gravite: 'haute' | 'moyenne' | 'basse'
  nature: 'technique' | 'comportement'
  titre: string
  detail: string
}

export interface ConnexionJour {
  le: Date
  succes: boolean
  motif: string | null
}

const hhmm = (d: Date) => {
  const p = partiesParis(d.getTime())
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`
}

/** The signals code can stand behind: server errors, refusals, failed logins,
 *  deletions, actions as someone else, and the same write repeated in a burst. */
export function signaux(journal: readonly LigneJournal[], connexions: readonly ConnexionJour[]): Signal[] {
  const out: Signal[] = []
  const erreurs = journal.filter((l) => resultatDe(l.statut) === 'erreur')
  if (erreurs.length) {
    out.push({
      gravite: 'haute',
      nature: 'technique',
      titre: `${erreurs.length} erreur${erreurs.length > 1 ? 's' : ''} serveur rencontrée${erreurs.length > 1 ? 's' : ''}`,
      detail: erreurs.slice(0, 8).map((l) => `${hhmm(l.le)} ${menuDe(l.chemin)} (${l.statut}${l.erreur ? ` : ${l.erreur}` : ''})`).join(' ; '),
    })
  }
  const refus = journal.filter((l) => resultatDe(l.statut) === 'refus')
  if (refus.length) {
    out.push({
      gravite: refus.length >= 5 ? 'moyenne' : 'basse',
      nature: 'technique',
      titre: `${refus.length} action${refus.length > 1 ? 's' : ''} refusée${refus.length > 1 ? 's' : ''} par ETM/TRM`,
      detail: refus.slice(0, 8).map((l) => `${hhmm(l.le)} ${menuDe(l.chemin)}${l.erreur ? ` : ${l.erreur}` : ` (${l.statut})`}`).join(' ; '),
    })
  }
  const echecs = connexions.filter((c) => !c.succes)
  if (echecs.length >= 3) {
    out.push({
      gravite: 'moyenne',
      nature: 'technique',
      titre: `${echecs.length} connexions échouées`,
      detail: echecs.slice(0, 8).map((c) => `${hhmm(c.le)}${c.motif ? ` (${c.motif})` : ''}`).join(', '),
    })
  }
  const suppressions = journal.filter((l) => l.methode === 'DELETE' && resultatDe(l.statut) === 'ok')
  if (suppressions.length) {
    out.push({
      gravite: suppressions.length >= 5 ? 'moyenne' : 'basse',
      nature: 'comportement',
      titre: `${suppressions.length} suppression${suppressions.length > 1 ? 's' : ''}`,
      detail: suppressions.slice(0, 10).map((l) => `${hhmm(l.le)} ${libelleAction(l)}`).join(' ; '),
    })
  }
  const voirComme = journal.filter((l) => l.voir_comme !== null)
  if (voirComme.length) {
    out.push({
      gravite: 'basse',
      nature: 'comportement',
      titre: `${voirComme.length} action${voirComme.length > 1 ? 's' : ''} faite${voirComme.length > 1 ? 's' : ''} en « Voir comme » un autre compte`,
      detail: voirComme.slice(0, 5).map((l) => `${hhmm(l.le)} ${libelleAction(l)}`).join(' ; '),
    })
  }
  // The same write on the same object 4+ times within 2 minutes: a stuck
  // screen, a double click storm, or trial and error.
  const rafales = new Map<string, number[]>()
  for (const l of journal) {
    if (l.methode === 'GET') continue
    const cle = `${l.methode} ${l.chemin}`
    rafales.set(cle, [...(rafales.get(cle) ?? []), l.le.getTime()])
  }
  for (const [cle, temps] of rafales) {
    for (let i = 0; i + 3 < temps.length; i++) {
      if (temps[i + 3] - temps[i] <= 120_000) {
        out.push({
          gravite: 'basse',
          nature: 'technique',
          titre: 'Même action répétée en rafale',
          detail: `${cle.replace(/^\w+ \/api\//, '')} : ${temps.length} fois, dont 4 en moins de 2 minutes vers ${hhmm(new Date(temps[i]))}.`,
        })
        break
      }
    }
  }
  return out
}

/** A mail its author marked personal: listed, never read. */
export const estPersonnel = (sujet: string) => /\b(perso|personnel|personnelle|priv[ée]e?)\b/i.test(sujet)
