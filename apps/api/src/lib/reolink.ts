// Reolink NVR (RLN16-410 « ETS Malterre », IoT VLAN, `https://10.10.40.10`) —
// HTTP JSON API client for Agents IA › Automates › Vidéosurveillance.
//
//   POST /api.cgi?cmd=Login  [{cmd:'Login', param:{User:{userName, password}}}] → value.Token.name
//   POST /api.cgi?token=<t>  [ …commands… ]   (batching works, one answer per command)
//   Logout ALWAYS at the end: the NVR has few session slots.
//
// Credentials: env REOLINK_USER / REOLINK_PASSWORD (an admin account — Set* needs
// it), read at call time. The NVR presents a self-signed certificate: the check
// is skipped for this request only (node:https agent), never process-wide.
//
// Push schedule (`GetPushV20` / `SetPushV20`, per channel): each event table
// (MD, AI_PEOPLE, AI_VEHICLE, AI_DOG_CAT) is 168 chars '0'/'1', one per hour of
// the week. ⚠️ The first day of the table is `ORDRE_JOURS` — see screen_notes.md
// § 13 « Automates » for how it was confirmed.

import * as https from 'node:https'

/** ISO weekday (1 = Monday … 7 = Sunday) of each 24-char block of a schedule
 *  table, in table order. Reolink tables start on Sunday. */
export const ORDRE_JOURS: readonly number[] = [7, 1, 2, 3, 4, 5, 6]

export const HEURES_SEMAINE = 168

const TIMEOUT_MS = 10_000

export class ReolinkError extends Error {}

interface ReolinkReponse {
  cmd: string
  code: number
  value?: Record<string, unknown>
  error?: { rspCode: number; detail: string }
}

function config() {
  const url = (process.env.REOLINK_URL || 'https://10.10.40.10').replace(/\/+$/, '')
  const user = process.env.REOLINK_USER
  const password = process.env.REOLINK_PASSWORD
  if (!user || !password) throw new ReolinkError('Identifiants du NVR absents (REOLINK_USER / REOLINK_PASSWORD dans le .env de l’API).')
  return { url, user, password }
}

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false })

function poster(url: string, corps: unknown): Promise<ReolinkReponse[]> {
  return new Promise((resolve, reject) => {
    const donnees = Buffer.from(JSON.stringify(corps))
    const req = https.request(
      url,
      { method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': donnees.length }, timeout: TIMEOUT_MS },
      (res) => {
        const morceaux: Buffer[] = []
        res.on('data', (c: Buffer) => morceaux.push(c))
        res.on('end', () => {
          const texte = Buffer.concat(morceaux).toString('utf8')
          if (res.statusCode !== 200) return reject(new ReolinkError(`NVR : HTTP ${res.statusCode}`))
          try {
            const json = JSON.parse(texte)
            resolve(Array.isArray(json) ? json : [json])
          } catch {
            reject(new ReolinkError('NVR : réponse illisible.'))
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new ReolinkError('NVR injoignable (délai dépassé).')))
    req.on('error', (err) => reject(err instanceof ReolinkError ? err : new ReolinkError(`NVR injoignable : ${err.message}`)))
    req.end(donnees)
  })
}

/** The command's value, or a ReolinkError naming the command. */
export function valeur(r: ReolinkReponse | undefined, cmd: string): Record<string, unknown> {
  if (!r) throw new ReolinkError(`NVR : pas de réponse à ${cmd}.`)
  if (r.code !== 0 || !r.value) {
    const detail = r.error ? `${r.error.detail} (${r.error.rspCode})` : `code ${r.code}`
    throw new ReolinkError(`NVR : ${cmd} refusé — ${detail}.`)
  }
  return r.value
}

export interface Session {
  /** Run a batch of commands; one answer per command, in order. */
  commandes(cmds: Array<{ cmd: string; action?: number; param?: unknown }>): Promise<ReolinkReponse[]>
}

/** Login, run `fn`, Logout — even when `fn` throws. */
export async function avecSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  const { url, user, password } = config()
  const login = await poster(`${url}/api.cgi?cmd=Login`, [
    { cmd: 'Login', action: 0, param: { User: { Version: '0', userName: user, password } } },
  ])
  const token = (valeur(login[0], 'Login').Token as { name?: string } | undefined)?.name
  if (!token) throw new ReolinkError('NVR : connexion refusée (pas de jeton).')
  const endpoint = `${url}/api.cgi?token=${encodeURIComponent(token)}`
  try {
    return await fn({ commandes: (cmds) => poster(endpoint, cmds.map((c) => ({ action: 0, ...c }))) })
  } finally {
    await poster(endpoint, [{ cmd: 'Logout', action: 0, param: {} }]).catch(() => undefined)
  }
}

// ── Typed helpers ────────────────────────────────────────

export interface Canal {
  canal: number
  nom: string
}

/** Online channels with their live names (never hard-coded). */
export async function canaux(s: Session): Promise<Canal[]> {
  const [r] = await s.commandes([{ cmd: 'GetChannelstatus' }])
  const status = (valeur(r, 'GetChannelstatus').status ?? []) as Array<{ channel: number; name: string; online: number }>
  return status.filter((c) => c.online === 1).map((c) => ({ canal: c.channel, nom: c.name }))
}

export type TablesPush = Record<string, string>

/** The push settings of one channel, as the NVR returns them (`value.Push`). */
export interface PushCanal {
  enable: number
  scheduleEnable: number
  schedule: { channel: number; table: TablesPush }
  [autre: string]: unknown
}

export async function lirePush(s: Session, liste: readonly number[]): Promise<Map<number, PushCanal>> {
  const reps = await s.commandes(liste.map((canal) => ({ cmd: 'GetPushV20', param: { channel: canal } })))
  const out = new Map<number, PushCanal>()
  liste.forEach((canal, i) => {
    const push = valeur(reps[i], 'GetPushV20').Push as PushCanal | undefined
    if (!push?.schedule?.table) throw new ReolinkError(`NVR : réglage des notifications illisible (canal ${canal}).`)
    for (const [evt, t] of Object.entries(push.schedule.table)) {
      if (!tableValide(t)) throw new ReolinkError(`NVR : table ${evt} du canal ${canal} inattendue.`)
    }
    out.set(canal, push)
  })
  return out
}

/** Write each channel's push settings (whole object, as read then modified). */
export async function ecrirePush(s: Session, pushs: ReadonlyMap<number, PushCanal>): Promise<void> {
  const entrees = [...pushs.entries()]
  const reps = await s.commandes(entrees.map(([, push]) => ({ cmd: 'SetPushV20', param: { Push: push } })))
  entrees.forEach(([canal], i) => valeur(reps[i], `SetPushV20 (canal ${canal})`))
}

// ── Schedule tables (pure) ───────────────────────────────

export function tableValide(t: unknown): t is string {
  return typeof t === 'string' && t.length === HEURES_SEMAINE && /^[01]+$/.test(t)
}

/** Table index of an ISO weekday (1 = Monday) + hour. */
export function indexHeure(jourIso: number, heure: number): number {
  return ORDRE_JOURS.indexOf(jourIso) * 24 + heure
}

const JOURS_COURTS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.']

/** A table read Monday 00h first (k = (jourIso − 1) × 24 + heure). */
export function semaineDepuisLundi(table: string): string {
  let out = ''
  for (let j = 1; j <= 7; j++) for (let h = 0; h < 24; h++) out += table[indexHeure(j, h)]
  return out
}

const libelle = (k: number) => `${JOURS_COURTS[Math.floor(k / 24) % 7]} ${String(k % 24).padStart(2, '0')}h`

/** The '1' runs of a table as readable ranges, Monday first, a run across
 *  Sunday → Monday kept whole: « ven. 20h → lun. 05h » (end = first hour off). */
export function plagesLisibles(table: string): string[] {
  if (!tableValide(table)) return []
  const lin = semaineDepuisLundi(table)
  if (!lin.includes('0')) return ['toute la semaine']
  if (!lin.includes('1')) return []
  const bit = (k: number) => lin[k % HEURES_SEMAINE] === '1'
  const plages: Array<{ debut: number; texte: string }> = []
  let debut: number | null = null
  // Start right after an hour that is off, so a run over the week's end stays whole.
  const k0 = lin.indexOf('0')
  for (let k = k0 + 1; k <= k0 + HEURES_SEMAINE; k++) {
    if (bit(k) && debut === null) debut = k
    if (!bit(k) && debut !== null) {
      plages.push({ debut: debut % HEURES_SEMAINE, texte: `${libelle(debut % HEURES_SEMAINE)} → ${libelle(k % HEURES_SEMAINE)}` })
      debut = null
    }
  }
  return plages.sort((a, b) => a.debut - b.debut).map((p) => p.texte)
}
