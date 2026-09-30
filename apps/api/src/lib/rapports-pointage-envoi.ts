/**
 * The two scheduled pointage reports (TRM notifications) — reads, recipients
 * and sending. Replaces the n8n workflows « pointage » and « Bilan des Heures
 * Annualisées » (retired 2026-09-22), which read the WebDev localapi
 * (get_pointage / get_planning / get_bilan_horaire).
 *
 * The schedule is NOT here: since 2026-09-30 both reports are automates
 * (Agents IA › Automates, lib/automates/rapports-pointage/) on the agents'
 * engine — daily report Monday to Friday at 09:00, weekly balance on Tuesday
 * at 09:00, Paris time, production only, at most once a day with same-day
 * catch-up. The admin « Envoyer un test » route (notifications-trm.ts) sends
 * to the caller alone, in any env.
 */
import { query } from './hfsql-auto.js'
import { lignesPeriode, listerSalaries, soldeHeures, tousLesSalaries } from './pointage.js'
import { jourParis, msHeureParis, semaineDeReference, type LigneHoraire } from './pointage-etat.js'
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

export interface Destinataires {
  /** Addresses the report goes to (deduplicated). */
  adresses: string[]
  /** Subscribers left out, with why — shown in the automate's run. */
  ecartes: Array<{ nom: string; raison: string }>
}

/** Subscribers of `key` who may receive it and have an address. */
export async function destinataires(key: TrmNotificationKey): Promise<Destinataires> {
  const ids = await trmNotifications.subscribersOf(key)
  const emails = await getAllUserEmails()
  const adresses: string[] = []
  const ecartes: Array<{ id: number; raison: string }> = []
  for (const id of ids) {
    if (!emails[id]) ecartes.push({ id, raison: 'pas d’adresse e-mail' })
    else if (!(await peutRecevoir(id, key))) ecartes.push({ id, raison: 'n’a plus accès au menu Pointage' })
    else adresses.push(emails[id])
  }
  const noms = new Map<number, string>()
  if (ecartes.length) {
    const rows = await query<{ IDutilisateur: number; prenom: string | null; nom: string | null }>(
      `SELECT IDutilisateur, prenom, nom FROM utilisateur WHERE IDutilisateur IN (${ecartes.map((e) => Math.trunc(e.id)).join(',')})`,
    )
    for (const u of rows) noms.set(Number(u.IDutilisateur), [u.prenom, u.nom].filter(Boolean).join(' ').trim())
  }
  return {
    adresses: [...new Set(adresses)],
    ecartes: ecartes.map((e) => ({ nom: noms.get(e.id) || `utilisateur ${e.id}`, raison: e.raison })),
  }
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
