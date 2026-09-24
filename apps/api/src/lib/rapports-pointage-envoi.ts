/**
 * The two scheduled pointage reports (TRM notifications) — reads, recipients,
 * sending and the in-process timer. Replaces the n8n workflows « pointage »
 * and « Bilan des Heures Annualisées » (retired 2026-09-22), which read the
 * WebDev localapi (get_pointage / get_planning / get_bilan_horaire).
 *
 * Schedule (the n8n one): the daily report Monday to Friday at 09:00, the
 * weekly balance on Tuesday at 09:00, Paris time.
 *
 * The timer lives in the API process — no cron, no systemd unit, it ships with
 * /etm_deploy like any route. A journal (data/rapports-pointage-envois.json)
 * records the day each report went out, written BEFORE sending, so:
 *   - a restart never sends twice (at most once per day);
 *   - an API that was down at 09:00 sends as soon as it is back the same day
 *     (the tick checks « due and not yet sent today », not « it is 09:00 »).
 * It never catches up a previous day.
 *
 * ⚠️ Only the production API runs the timer (NODE_ENV=production), so a dev or
 * worktree API never mails real people. RAPPORTS_POINTAGE=off disables it in
 * production too; RAPPORTS_POINTAGE=on forces it anywhere (tests only).
 * The admin « Envoyer un test » route sends to the caller alone, in any env.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from './hfsql-auto.js'
import { lignesPeriode, listerSalaries, soldeHeures, tousLesSalaries } from './pointage.js'
import { jourParis, msHeureParis, partiesParis, semaineDeReference, type LigneHoraire } from './pointage-etat.js'
import { lundiIso } from './pointage-admin.js'
import { analyserJournee, horaireDe, joursCouverts, ordreRapport, prenomAffiche, type Plage, type SalarieRapport } from './rapport-pointage.js'
import { contenuBilanHeures, contenuRapportPointage, type JourRapport } from './rapport-pointage-email.js'
import { renderNotificationEmail, renderNotificationEmailPreview, type NotificationEmailContent } from './notification-email.js'
import { sendMail } from './gmail.js'
import { getAllUserEmails } from './user-emails.js'
import { trmNotifications } from './notifications-trm.js'
import { trmNotificationDef, type TrmNotificationKey } from './notification-keys-trm.js'
import { getTrmUserPermissions } from './permissions-trm.js'
import { isAdminUtilisateur } from './auth.js'

/** The mailbox the reports come from — the one n8n used, so recipients keep
 *  their filters. Impersonated through the Gmail domain-wide delegation. */
const EXPEDITEUR = process.env.RAPPORTS_POINTAGE_FROM?.trim() || 'tricotbot@etsmalterre.com'
const EXPEDITEUR_NOM = 'TRM - Pointage'

export interface Rapport {
  subject: string
  content: NotificationEmailContent
}

// ── Reads ────────────────────────────────────────────────

const ymd = (y: number, mo: number, d: number) => `${y}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}`
const plusJours = (jour: string, n: number) => {
  const t = new Date(Date.UTC(+jour.slice(0, 4), +jour.slice(4, 6) - 1, +jour.slice(6, 8)) + n * 86_400_000)
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/** planning_bonnetier rows starting on the given days, as epoch ms (Paris),
 *  keyed `YYYYMMDD|IDbonnetier`. */
async function planningJours(du: string, au: string): Promise<Map<string, Plage>> {
  const rows = await query<Record<string, unknown>>(
    `SELECT IDbonnetier, date_debut, date_fin FROM planning_bonnetier
     WHERE date_debut >= '${du}000000' AND date_debut < '${plusJours(au, 1)}000000'`,
  )
  const dt = (v: unknown) => {
    const m = /^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2})/.exec(String(v ?? ''))
    return m ? { jour: `${m[1]}${m[2]}${m[3]}`, ms: msHeureParis(+m[1], +m[2], +m[3], +m[4], +m[5]) } : null
  }
  const out = new Map<string, Plage>()
  for (const r of rows) {
    const d = dt(r.date_debut), f = dt(r.date_fin)
    if (d && f && f.ms > d.ms) out.set(`${d.jour}|${Number(r.IDbonnetier)}`, { debut: d.ms, fin: f.ms })
  }
  return out
}

/**
 * The report rules run over `jours` (YYYYMMDD, Paris, consecutive): one
 * JourRapport per day, listing the salariés who clocked in or were planned.
 * Shared by the daily email and Pointage › Salariés (« 7 derniers jours »,
 * `idSalarie` set) so the two can never judge a day differently.
 */
export async function analyserJours(jours: readonly string[], idSalarie = 0): Promise<JourRapport[]> {
  if (!jours.length) return []
  const du = jours[0], au = jours[jours.length - 1]

  const [salaries, lignes, planning] = await Promise.all([tousLesSalaries(), lignesPeriode(du, au, idSalarie), planningJours(du, au)])
  const parId = new Map(salaries.map((s) => [s.id, s]))
  // A bonnetier is a salarié through lst_salarie.id_mps (0 = no link).
  const parBonnetier = new Map(
    salaries.filter((s) => !s.supprime && s.idMps > 0 && (!idSalarie || s.id === idSalarie)).map((s) => [s.idMps, s]),
  )

  return jours.map((jour) => {
    const heure = (hm: string) => msHeureParis(+jour.slice(0, 4), +jour.slice(4, 6), +jour.slice(6, 8), +hm.slice(0, 2), +hm.slice(3, 5))
    const duJour = new Map<number, LigneHoraire[]>()
    for (const l of lignes) if (l.jour === jour) duJour.set(l.idSalarie, [...(duJour.get(l.idSalarie) ?? []), l])
    // Planned but never clocked: listed too, the report flags it.
    for (const [cle] of planning) {
      const [j, idB] = cle.split('|')
      const s = j === jour ? parBonnetier.get(Number(idB)) : undefined
      if (s && !duJour.has(s.id)) duJour.set(s.id, [])
    }
    const out = [...duJour].map(([idSalarie, ls]) => {
      const s = parId.get(idSalarie)
      const salarie: SalarieRapport = { id: idSalarie, prenom: prenomAffiche(s?.prenom || s?.nom || `Salarié ${idSalarie}`), nom: s?.nom ?? '' }
      const prevu = s && s.idMps > 0 ? planning.get(`${jour}|${s.idMps}`) ?? null : null
      return analyserJournee(salarie, ls, prevu, heure, horaireDe(idSalarie))
    })
    return { jour, lignes: out.sort(ordreRapport) }
  })
}

/** The daily report sent on `jourEnvoi` (YYYYMMDD, Paris). Null when nobody
 *  clocked in on the covered days. */
export async function construireRapportPointage(jourEnvoi: string): Promise<Rapport | null> {
  const y = +jourEnvoi.slice(0, 4), mo = +jourEnvoi.slice(4, 6), d = +jourEnvoi.slice(6, 8)
  const jourSemaine = new Date(Date.UTC(y, mo - 1, d)).getUTCDay() || 7
  return contenuRapportPointage(await analyserJours(joursCouverts(jourEnvoi, jourSemaine)))
}

/** The weekly balance as of `nowMs`: the week FEN_PointageSalarié reports
 *  (last week), one balance per salarié that has a lissage row for it. */
export async function construireBilanHeures(nowMs: number): Promise<Rapport | null> {
  const semaine = semaineDeReference(nowMs)
  if (!semaine) return null
  const salaries = await listerSalaries()
  const soldes = (
    await Promise.all(
      salaries.map(async (s) => {
        const solde = await soldeHeures(s.id, semaine)
        return solde ? { prenom: prenomAffiche(s.prenom || s.nom), soldeMin: solde.cumulMin } : null
      }),
    )
  ).filter((s): s is { prenom: string; soldeMin: number } => s !== null)
  const lundi = lundiIso(semaine.annee, semaine.numero)
  return contenuBilanHeures(soldes, { numero: semaine.numero, lundi, samedi: plusJours(lundi, 5) })
}

export async function construireRapport(key: TrmNotificationKey, nowMs: number): Promise<Rapport | null> {
  return key === 'notif_rapport_pointage' ? construireRapportPointage(jourParis(nowMs)) : construireBilanHeures(nowMs)
}

export function apercuHtml(r: Rapport): string {
  return renderNotificationEmailPreview(r.content)
}

// ── Recipients + sending ─────────────────────────────────

/** Whether a user may receive `key`: holds its required TRM permission, or is the admin. */
export async function peutRecevoir(userId: number, key: TrmNotificationKey): Promise<boolean> {
  const requis = trmNotificationDef(key).requires
  if (!requis) return true
  if ((await getTrmUserPermissions(userId)).includes(requis)) return true
  const [u] = await query<{ prenom: string | null; nom: string | null }>(
    `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${Math.trunc(userId)}`,
  )
  return !!u && isAdminUtilisateur(u)
}

/** Subscribers of `key` who may receive it and have an address. */
export async function destinataires(key: TrmNotificationKey): Promise<string[]> {
  const ids = await trmNotifications.subscribersOf(key)
  const emails = await getAllUserEmails()
  const out: string[] = []
  for (const id of ids) {
    if (!emails[id]) {
      console.warn(`[rapports-pointage] ${key}: subscriber ${id} has no email address`)
      continue
    }
    if (!(await peutRecevoir(id, key))) {
      console.warn(`[rapports-pointage] ${key}: subscriber ${id} lacks ${trmNotificationDef(key).requires}, skipped`)
      continue
    }
    out.push(emails[id])
  }
  return [...new Set(out)]
}

/** One send per recipient (like notify()). Returns how many went out. */
export async function envoyerRapport(r: Rapport, a: string[]): Promise<number> {
  const rendered = renderNotificationEmail(r.content)
  let ok = 0
  for (const to of a) {
    try {
      await sendMail({
        from: EXPEDITEUR,
        fromName: EXPEDITEUR_NOM,
        to: [to],
        subject: r.subject,
        body: rendered.text,
        bodyHtml: rendered.html,
        inlineImages: rendered.inlineImages,
        signatureHtml: null,
      })
      ok++
    } catch (err) {
      console.error(`[rapports-pointage] send to ${to} failed:`, err)
    }
  }
  return ok
}

// ── Schedule + journal ───────────────────────────────────

interface Planif {
  key: TrmNotificationKey
  /** ISO weekdays, 1 = Monday. */
  jours: readonly number[]
  heure: number
}

export const PLANIFICATION: readonly Planif[] = [
  { key: 'notif_rapport_pointage', jours: [1, 2, 3, 4, 5], heure: 9 },
  { key: 'notif_bilan_heures', jours: [2], heure: 9 },
]

/** Is `p` due at `nowMs` (Paris) given the day it last went out? */
export function estDu(p: Planif, nowMs: number, dernierEnvoi: string | undefined): boolean {
  const t = partiesParis(nowMs)
  const jourSemaine = new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay() || 7
  return p.jours.includes(jourSemaine) && t.h >= p.heure && dernierEnvoi !== ymd(t.y, t.mo, t.d)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const JOURNAL = path.resolve(__dirname, '../../data/rapports-pointage-envois.json')

async function lireJournal(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(JOURNAL, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

async function ecrireJournal(j: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(JOURNAL), { recursive: true })
  await fs.writeFile(`${JOURNAL}.tmp`, JSON.stringify(j, null, 2), 'utf8')
  await fs.rename(`${JOURNAL}.tmp`, JOURNAL)
}

let enCours = false

async function tick(): Promise<void> {
  if (enCours) return
  enCours = true
  try {
    const now = Date.now()
    const journal = await lireJournal()
    for (const p of PLANIFICATION) {
      if (!estDu(p, now, journal[p.key])) continue
      // Journal first: at most once a day, even if the process dies mid-send.
      journal[p.key] = jourParis(now)
      await ecrireJournal(journal)
      try {
        const a = await destinataires(p.key)
        if (!a.length) {
          console.log(`[rapports-pointage] ${p.key}: no recipient`)
          continue
        }
        const r = await construireRapport(p.key, now)
        if (!r) {
          console.log(`[rapports-pointage] ${p.key}: nothing to report`)
          continue
        }
        const ok = await envoyerRapport(r, a)
        console.log(`[rapports-pointage] ${p.key}: sent ${ok}/${a.length}`)
      } catch (err) {
        console.error(`[rapports-pointage] ${p.key} failed:`, err)
      }
    }
  } catch (err) {
    console.error('[rapports-pointage] tick failed:', err)
  } finally {
    enCours = false
  }
}

export function planificateurActif(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.RAPPORTS_POINTAGE?.trim().toLowerCase()
  if (v === 'off') return false
  if (v === 'on') return true
  return env.NODE_ENV === 'production'
}

/** Start the once-a-minute tick. Called once from index.ts. */
export function demarrerRapportsPointage(): void {
  if (!planificateurActif()) {
    console.log('[rapports-pointage] scheduler off (not production)')
    return
  }
  console.log(`[rapports-pointage] scheduler on, sending as ${EXPEDITEUR}`)
  setTimeout(() => void tick(), 30_000)
  setInterval(() => void tick(), 60_000).unref()
}
