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

/** A journal line with its French description (libelles.ts decrire). */
export type LigneDecrite = LigneJournal & { texte?: string; retrait?: boolean }

const texteDe = (l: LigneDecrite) => l.texte ?? libelleAction(l)

/** The signals code can stand behind: server errors on a write, refusals, failed logins,
 *  deletions (not a mere unlink: a released reservation, a piece taken off an
 *  order), actions as someone else, and the very same write sent again and
 *  again in a burst. */
export function signaux(journal: readonly LigneDecrite[], connexions: readonly ConnexionJour[]): Signal[] {
  const out: Signal[] = []
  // A read failing is the screen polling in the background (the tickets
  // widget every 5 min while the tracker was down: « 6 erreurs serveur »,
  // haute, 2026-10-08) — infrastructure, not something the person did.
  const erreurs = journal.filter((l) => resultatDe(l.statut) === 'erreur' && l.methode !== 'GET')
  if (erreurs.length) {
    out.push({
      gravite: 'haute',
      nature: 'technique',
      titre: `${erreurs.length} erreur${erreurs.length > 1 ? 's' : ''} serveur rencontrée${erreurs.length > 1 ? 's' : ''}`,
      detail: erreurs.slice(0, 8).map((l) => `${hhmm(l.le)} ${texteDe(l)} (${l.statut}${l.erreur ? ` : ${l.erreur}` : ''})`).join(' ; '),
    })
  }
  const refus = journal.filter((l) => resultatDe(l.statut) === 'refus')
  if (refus.length) {
    out.push({
      gravite: refus.length >= 5 ? 'moyenne' : 'basse',
      nature: 'technique',
      titre: `${refus.length} action${refus.length > 1 ? 's' : ''} refusée${refus.length > 1 ? 's' : ''} par ETM/TRM`,
      detail: refus.slice(0, 8).map((l) => `${hhmm(l.le)} ${texteDe(l)}${l.erreur ? ` : ${l.erreur}` : ` (${l.statut})`}`).join(' ; '),
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
  const suppressions = journal.filter((l) => l.methode === 'DELETE' && !l.retrait && resultatDe(l.statut) === 'ok')
  if (suppressions.length) {
    out.push({
      gravite: suppressions.length >= 5 ? 'moyenne' : 'basse',
      nature: 'comportement',
      titre: `${suppressions.length} suppression${suppressions.length > 1 ? 's' : ''}`,
      detail: suppressions.slice(0, 10).map((l) => `${hhmm(l.le)} ${texteDe(l)}`).join(' ; '),
    })
  }
  const voirComme = journal.filter((l) => l.voir_comme !== null)
  if (voirComme.length) {
    out.push({
      gravite: 'basse',
      nature: 'comportement',
      titre: `${voirComme.length} action${voirComme.length > 1 ? 's' : ''} faite${voirComme.length > 1 ? 's' : ''} en « Voir comme » un autre compte`,
      detail: voirComme.slice(0, 5).map((l) => `${hhmm(l.le)} ${texteDe(l)}`).join(' ; '),
    })
  }
  // The very same write (same object, same data) 4+ times within 2 minutes:
  // a stuck screen, a double-click storm, or trial and error. Twelve rolls
  // received one after the other share a path but not their data: not a burst.
  const rafales = new Map<string, LigneDecrite[]>()
  for (const l of journal) {
    if (l.methode === 'GET') continue
    const cle = `${l.methode} ${l.chemin} ${l.corps ?? ''}`
    rafales.set(cle, [...(rafales.get(cle) ?? []), l])
  }
  for (const lignes of rafales.values()) {
    for (let i = 0; i + 3 < lignes.length; i++) {
      if (lignes[i + 3].le.getTime() - lignes[i].le.getTime() <= 120_000) {
        out.push({
          gravite: 'basse',
          nature: 'technique',
          titre: 'Même action envoyée plusieurs fois de suite',
          detail: `${texteDe(lignes[0])} : ${lignes.length} fois à l’identique, dont 4 en moins de 2 minutes vers ${hhmm(lignes[i].le)}.`,
        })
        break
      }
    }
  }
  return out
}

/** A mail its author marked personal: listed, never read. */
export const estPersonnel = (sujet: string) => /\b(perso|personnel|personnelle|priv[ée]e?)\b/i.test(sujet)

// ── Actions per hour (2026-10-08) ────────────────────────
// Vincent is automating Pierrot's job and wants to see his pace fall. The
// journal holds one row per REQUEST, and one click can send many: receiving a
// BL of 12 rolls is 12 POSTs + the Tricobot check in the same second, putting
// 60 rolls on an avis or releasing 19 reservations is one request per roll,
// a transfer's « Enregistrer » sends its pieces then its header. Counted per
// row, a BL of 60 rolls weighed 60 times a hand-typed order line. On his first
// two days (453 writes) the gaps between rows are bimodal: 0-2 s (the screen
// chaining calls) or 5 s and more (a person reading, typing, clicking).

/** Rows closer than this belong to the same gesture (one click). */
export const GESTE_MS = 2_000

/** The journal cut into gestures: a run of writes each within GESTE_MS of
 *  the previous one. A failed request still counts (the person clicked). */
export function gestes<T extends Pick<LigneJournal, 'le' | 'methode'>>(journal: readonly T[]): T[][] {
  const out: T[][] = []
  let prec: number | null = null
  for (const l of journal) {
    if (l.methode === 'GET') continue // a 5xx on a read: not a gesture
    const t = l.le.getTime()
    if (prec !== null && t - prec <= GESTE_MS) out[out.length - 1].push(l)
    else out.push([l])
    prec = t
  }
  return out
}

export interface HeureActivite {
  /** Start of the clock hour (Paris), ms. */
  debut: number
  /** « 15 h ». */
  heure: string
  /** Gestures started in this hour: what the person actually did. */
  actions: number
  /** Journal rows behind them. */
  ecritures: number
  /** Menu → actions, most first: what the hour went on. */
  menus: Array<{ menu: string; actions: number }>
}

/** Actions per clock hour (Paris), only the hours with at least one. A
 *  gesture belongs to the hour it starts in and to the menu of its first row. */
export function actionsParHeure<T extends Pick<LigneJournal, 'le' | 'methode' | 'chemin'>>(journal: readonly T[]): HeureActivite[] {
  const parHeure = new Map<number, { actions: number; ecritures: number; menus: Map<string, number> }>()
  for (const g of gestes(journal)) {
    const p = partiesParis(g[0].le.getTime())
    const debut = msHeureParis(p.y, p.mo, p.d, p.h)
    const h = parHeure.get(debut) ?? { actions: 0, ecritures: 0, menus: new Map<string, number>() }
    h.actions++
    h.ecritures += g.length
    const menu = menuDe(g[0].chemin)
    h.menus.set(menu, (h.menus.get(menu) ?? 0) + 1)
    parHeure.set(debut, h)
  }
  return [...parHeure.entries()]
    .sort(([a], [b]) => a - b)
    .map(([debut, h]) => ({
      debut,
      heure: `${partiesParis(debut).h} h`,
      actions: h.actions,
      ecritures: h.ecritures,
      menus: [...h.menus.entries()].map(([menu, actions]) => ({ menu, actions })).sort((a, b) => b.actions - a.actions || a.menu.localeCompare(b.menu, 'fr')),
    }))
}

/** Average actions per worked hour (an hour with at least one action), the
 *  reference the current hours are read against. null without history. */
export function moyenneParHeure(heures: readonly Pick<HeureActivite, 'actions'>[]): number | null {
  return heures.length ? heures.reduce((t, h) => t + h.actions, 0) / heures.length : null
}
