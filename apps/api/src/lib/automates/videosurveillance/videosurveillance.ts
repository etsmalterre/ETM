// Automate « Vidéosurveillance » — arms the Reolink NVR motion push when the
// factory is closed, from the TRM atelier planning. Rules in regles.ts, NVR
// client in lib/reolink.ts, doctrine in screen_notes.md § 13 « Automates ».
//
// A run: read planning_bonnetier (one flat SELECT) → NVR session: online
// channels + their push settings (the snapshot kept in the run) → target MD
// table → channels that differ → essai: report only; actif: SetPushV20 on those
// channels (only MD + enable/scheduleEnable change; AI tables kept as read),
// re-read and check.

import { createHash } from 'node:crypto'
import { query } from '../../hfsql-auto.js'
import { parseDtParisMs } from '../../pointage-etat.js'
import { avecSession, canaux, ecrirePush, lirePush, plagesLisibles, ReolinkError, type PushCanal, type Session } from '../../reolink.js'
import { calculerCible, conforme, lundiParis, tableFixe, type Cible, type Poste } from './regles.js'
import type { Issue } from '../catalog.js'

export const SLUG = 'videosurveillance'
export const VERSION = 1
export const VERSIONS = [
  {
    version: 1,
    date: '2026-09-28',
    note: 'Première version : notifications « mouvement » sur toutes les caméras quand aucune équipe de l’atelier TRM n’est planifiée (une heure de marge avant et après chaque équipe). Semaine sans planning → planning fixe du vendredi 18 h au lundi 5 h.',
  },
] as const

const JOUR_MS = 86_400_000

const ymd = (iso: string) => iso.replace(/-/g, '')
const plusJours = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * JOUR_MS).toISOString().slice(0, 10)

/** The planned shifts from the day before this ISO week to the end of the week
 *  after next (the 168-hour horizon never runs past it). All rows count. */
export async function lirePlanning(nowMs: number): Promise<Poste[]> {
  const lundi = lundiParis(nowMs)
  const du = ymd(plusJours(lundi, -1))
  const au = ymd(plusJours(lundi, 21))
  const rows = await query<Record<string, unknown>>(
    `SELECT IDbonnetier, date_debut, date_fin FROM planning_bonnetier
     WHERE date_debut >= '${du}000000' AND date_debut < '${au}000000'`,
  )
  const postes: Poste[] = []
  for (const r of rows) {
    const d = parseDtParisMs(r.date_debut)
    const f = parseDtParisMs(r.date_fin)
    if (d !== null && f !== null && f > d) postes.push({ debutMs: d, finMs: f })
  }
  return postes.sort((a, b) => a.debutMs - b.debutMs)
}

interface VueCanal {
  canal: number
  nom: string
  enable: number
  scheduleEnable: number
  md: string
  plages: string[]
  /** The other detections' push ranges, when any is set (AI_PEOPLE…). */
  autres: Record<string, string[]>
}

function vueCanal(canal: number, nom: string, push: PushCanal): VueCanal {
  const autres: Record<string, string[]> = {}
  for (const [evt, t] of Object.entries(push.schedule.table)) if (evt !== 'MD' && t.includes('1')) autres[evt] = plagesLisibles(t)
  return { canal, nom, enable: push.enable, scheduleEnable: push.scheduleEnable, md: push.schedule.table.MD, plages: plagesLisibles(push.schedule.table.MD), autres }
}

const vueCible = (c: Cible) => ({ md: c.table, plages: plagesLisibles(c.table), semainesNonPlanifiees: c.semainesNonPlanifiees })

const fmtLundi = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/** Read the NVR, bring every channel to `table`, record everything in `resultat`. */
async function appliquer(s: Session, table: string, mode: 'essai' | 'actif', resultat: Record<string, unknown>): Promise<{ changes: VueCanal[]; total: number }> {
  const liste = await canaux(s)
  if (!liste.length) throw new ReolinkError('NVR : aucune caméra en ligne.')
  const avant = await lirePush(s, liste.map((c) => c.canal))
  resultat.instantane = Object.fromEntries(avant)
  const aChanger = new Map<number, PushCanal>()
  for (const c of liste) {
    const push = avant.get(c.canal)!
    if (conforme(push, table)) continue
    aChanger.set(c.canal, { ...push, enable: 1, scheduleEnable: 1, schedule: { ...push.schedule, table: { ...push.schedule.table, MD: table } } })
  }
  resultat.canaux = liste.map((c) => ({ ...vueCanal(c.canal, c.nom, avant.get(c.canal)!), change: aChanger.has(c.canal) }))
  if (mode === 'actif' && aChanger.size) {
    await ecrirePush(s, aChanger)
    const apres = await lirePush(s, [...aChanger.keys()])
    const rates = [...apres].filter(([, p]) => !conforme(p, table)).map(([canal]) => liste.find((c) => c.canal === canal)?.nom ?? canal)
    resultat.apres = Object.fromEntries(apres)
    if (rates.length) throw new ReolinkError(`NVR : écriture non prise en compte sur ${rates.join(', ')}.`)
  }
  return { changes: liste.filter((c) => aChanger.has(c.canal)).map((c) => vueCanal(c.canal, c.nom, avant.get(c.canal)!)), total: liste.length }
}

export async function executer(mode: 'essai' | 'actif', resultat: Record<string, unknown>): Promise<Issue> {
  const now = Date.now()
  const postes = await lirePlanning(now)
  resultat.planning = { postes: postes.map((p) => ({ debut: new Date(p.debutMs).toISOString(), fin: new Date(p.finMs).toISOString() })) }
  const cible = calculerCible(postes, now)
  resultat.cible = vueCible(cible)
  const { changes, total } = await avecSession((s) => appliquer(s, cible.table, mode, resultat))
  const repli = cible.semainesNonPlanifiees.length
    ? ` Semaine du ${cible.semainesNonPlanifiees.map(fmtLundi).join(', du ')} sans planning : planning fixe.`
    : ''
  const empreinte = createHash('sha1').update(cible.table + changes.map((c) => c.canal).join(',')).digest('hex').slice(0, 12)
  if (!changes.length) return { statut: 'inchange', resume: `Les ${total} caméras sont déjà à jour.${repli}`, empreinte }
  const quoi = changes.length === total ? `les ${total} caméras` : `${changes.length} caméra(s) sur ${total}`
  const alertes = `Alertes : ${cible.table.includes('1') ? plagesLisibles(cible.table).join(', ') : 'aucune'}.`
  return mode === 'actif'
    ? { statut: 'applique', resume: `Planning mis à jour sur ${quoi}. ${alertes}${repli}` }
    : { statut: 'simule', resume: `Changerait ${quoi}. ${alertes}${repli}`, empreinte }
}

/** Leaving « actif »: the fixed schedule back once — a computed week left on
 *  the NVR would repeat every week, wrong. */
export async function remettreFixe(resultat: Record<string, unknown>): Promise<Issue> {
  const table = tableFixe()
  resultat.cible = { md: table, plages: plagesLisibles(table), semainesNonPlanifiees: [] }
  const { changes, total } = await avecSession((s) => appliquer(s, table, 'actif', resultat))
  return changes.length
    ? { statut: 'applique', resume: `Planning fixe remis sur ${changes.length} caméra(s) sur ${total} (vendredi 18 h → lundi 5 h).` }
    : { statut: 'inchange', resume: `Les ${total} caméras avaient déjà le planning fixe.` }
}

/** « État » tab: the NVR as it is now, and what the planning asks for now. */
export async function etat() {
  const now = Date.now()
  const cible = calculerCible(await lirePlanning(now), now)
  const cameras = await avecSession(async (s) => {
    const liste = await canaux(s)
    const pushs = await lirePush(s, liste.map((c) => c.canal))
    return liste.map((c) => ({ ...vueCanal(c.canal, c.nom, pushs.get(c.canal)!), conforme: conforme(pushs.get(c.canal)!, cible.table) }))
  })
  return { lu: new Date(now).toISOString(), cible: vueCible(cible), fixe: plagesLisibles(tableFixe()), cameras }
}
