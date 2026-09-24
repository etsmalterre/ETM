// Real-time alert of LEGACY (WinDev / WebDev) use of the HFSQL server: one email to
// Vincent each time a legacy host STARTS a session, until the PostgreSQL cutover
// (windev_migration repo, docs/plan.md § Step 1). The evening digest
// (legacy-activity-report.ts) stays the reference; this one says "right now, go and look".
//
// Source: the connection samples taken every 2 min on 10.10.20.2 (lib/legacy-audit.ts).
// HFSQL logs no connections, so "someone opened a WinDev app" can only be seen as
// "a legacy host appears in the samples". A session starts when a host is present
// after more than SESSION_GAP_MIN without being seen — office PCs stay connected all
// day, so alerting on presence would mail every 2 min. The new stack (MPS API, the
// nightly PG copy) never alerts.
//
// Every slot since the last run is processed, so a missed cron run loses nothing.
// First run (no state file): records who is connected, sends nothing.
//
// Usage (on the API host, from ~/mps_api):
//   npx tsx src/scripts/legacy-activity-alert.ts           # dry run, prints what it would send
//   npx tsx src/scripts/legacy-activity-alert.ts --send    # mail + update the state file
//   options: --to=a@b.fr  --samples=<local .tsv, for today>  --state=<state file>
// Cron (debian, 10.10.20.3): 1-59/2 * * * * (odd minutes, the sampler runs on even ones).

import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { createHfsqlClient } from '../lib/hfsql-auto.js'
import {
  describeHost, fetchSamples, hostKey, isLegacyIp, JNL_USERS_SQL, parisDay, parseJnlUsers,
  type JnlUser, type Sample,
} from '../lib/legacy-audit.js'
import { renderNotificationEmail, type NotificationEmailContent, type NotificationRow } from '../lib/notification-email.js'
import { sendMail } from '../lib/gmail.js'

const DEFAULT_TO = 'vincent@etsmalterre.com'
/** A host unseen for longer than this and present again = a new session. */
const SESSION_GAP_MIN = 30
/** Same threshold as the evening report's « absents depuis 7 j ». */
const RETIRED_AFTER_DAYS = 7
const FORGET_AFTER_DAYS = 60
const REPORT_STATE_FILE = resolve('data/legacy-audit-state.json')

const args = process.argv.slice(2)
const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const SEND = args.includes('--send')
const TO = arg('to') ?? DEFAULT_TO
const STATE_FILE = resolve(arg('state') ?? 'data/legacy-alert-state.json')
const TODAY = parisDay()

/** Slots are 'YYYY-MM-DD HH:MM', Paris time (the sampler's clock). */
interface State { lastSlot: string; lastSeen: Record<string, string> }
interface Session { key: string; ip: string; name: string; slot: string; conns: number; prevSeen: string | null }

const slotMs = (slot: string) => Date.parse(slot.replace(' ', 'T') + ':00')
const minutesBetween = (a: string, b: string) => Math.round((slotMs(b) - slotMs(a)) / 60_000)
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
const frDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`

function loadJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null }
}

function saveState(s: State) {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s, null, 2))
  renameSync(STATE_FILE + '.tmp', STATE_FILE)
}

/** The samples of every day from the last processed slot's day to today, as slots. */
function samplesSince(state: State | null): { slots: Map<string, Sample[]>; error: string | null } {
  const days = [TODAY]
  const lastDay = state?.lastSlot.slice(0, 10)
  if (lastDay && lastDay < TODAY && daysBetween(lastDay, TODAY) === 1) days.unshift(lastDay)
  const slots = new Map<string, Sample[]>()
  for (const day of days) {
    const { samples, error } = fetchSamples(day, day === TODAY ? arg('samples') : undefined)
    if (error) return { slots, error }
    for (const s of samples) {
      const slot = `${day} ${s.hhmm}`
      const list = slots.get(slot) ?? []
      if (s.ip !== '-') list.push(s)
      slots.set(slot, list)
    }
  }
  return { slots, error: null }
}

async function fetchJnlUsers(): Promise<{ users: JnlUser[]; error: string | null }> {
  const cs = process.env.HFSQL_CONNECTION_STRING
  if (!cs) return { users: [], error: 'HFSQL_CONNECTION_STRING absent' }
  const jnl = createHfsqlClient(cs.replace(/Database=[^;]*/i, 'Database=__jnl'))
  try {
    return { users: parseJnlUsers(await jnl.query<Record<string, unknown>>(JNL_USERS_SQL)), error: null }
  } catch (e) {
    return { users: [], error: (e as Error).message.split('\n')[0] }
  } finally {
    await jnl.closeConnection().catch(() => {})
  }
}

async function main() {
  const state = loadJson<State>(STATE_FILE)
  const { slots, error } = samplesSince(state)
  const stamp = new Date().toISOString()
  if (error) { console.log(`${stamp} samples unavailable: ${error}`); process.exitCode = 1; return }
  const ordered = [...slots.keys()].sort()
  if (!ordered.length) { console.log(`${stamp} no sample yet today`); return }

  const next: State = state ? { lastSlot: state.lastSlot, lastSeen: { ...state.lastSeen } } : { lastSlot: '', lastSeen: {} }
  const sessions: Session[] = []
  // First run: only the latest slot, silently, so hosts already connected don't alert.
  const todo = state ? ordered.filter(s => s > state.lastSlot) : ordered.slice(-1)
  for (const slot of todo) {
    for (const s of slots.get(slot)!) {
      if (!isLegacyIp(s.ip)) continue
      const key = hostKey(s)
      const prev = next.lastSeen[key] ?? null
      if (state && (!prev || minutesBetween(prev, slot) > SESSION_GAP_MIN)) {
        sessions.push({ key, ip: s.ip, name: s.name, slot, conns: s.conns, prevSeen: prev })
      }
      next.lastSeen[key] = slot
    }
    next.lastSlot = slot
  }
  for (const [k, seen] of Object.entries(next.lastSeen)) {
    if (daysBetween(seen.slice(0, 10), TODAY) > FORGET_AFTER_DAYS) delete next.lastSeen[k]
  }

  if (!sessions.length) {
    if (SEND) saveState(next)
    console.log(`${stamp} ${todo.length} slot(s) up to ${next.lastSlot}: no new legacy session${state ? '' : ' (first run, state initialised)'}`)
    return
  }

  // Name the hosts: the journal knows which application each workstation ran.
  const { users, error: jnlError } = await fetchJnlUsers()
  const reportState = loadJson<{ hosts: Record<string, { lastSeen: string }> }>(REPORT_STATE_FILE)
  const described = sessions.map(s => {
    const { label, apps } = describeHost(s.ip, s.name, users)
    // Never seen by the evening report, or back after a week of silence: worth a callout.
    const known = reportState?.hosts[s.key]
    const away = known ? daysBetween(known.lastSeen, TODAY) : null
    const flag = !reportState ? null
      : !known ? 'JAMAIS VU'
      : away! >= RETIRED_AFTER_DAYS ? `REVENU après ${away} jours d’absence`
      : null
    return { ...s, label, apps, flag }
  })

  const hhmm = (slot: string) => slot.slice(0, 10) === TODAY ? slot.slice(11) : `${frDate(slot.slice(0, 10))} ${slot.slice(11)}`
  const rows: NotificationRow[] = described.map(d => ({
    label: d.label,
    value: [
      d.apps.length ? d.apps.join(', ') : 'application inconnue',
      `connecté à ${hhmm(d.slot)}`,
      d.label.includes(d.ip) ? null : d.ip,
      d.prevSeen ? `précédente session vue à ${hhmm(d.prevSeen)}` : null,
      d.flag,
    ].filter(Boolean).join(' · '),
  }))
  if (jnlError) rows.push({ label: 'Journal HFSQL', value: `INDISPONIBLE, applications non identifiées : ${jnlError}` })

  const flagged = described.filter(d => d.flag)
  const first = described[0]
  const n = described.length
  const content: NotificationEmailContent = {
    title: 'Ancien logiciel en cours d’utilisation',
    tone: 'alert',
    intro: n === 1
      ? `**${first.label}** vient d’ouvrir une session sur la base HFSQL avec un ancien logiciel (${first.apps.join(', ') || 'application inconnue'}), à ${hhmm(first.slot)}.`
      : `**${n} postes ou services** viennent d’ouvrir une session sur la base HFSQL avec un ancien logiciel.`,
    rows,
    callout: flagged.length
      ? `À identifier : ${flagged.map(d => `${d.label} (${d.flag!.toLowerCase()})`).join(', ')}, à désinstaller ou arrêter avant la bascule PostgreSQL.`
      : null,
    footerNote: `Alerte en temps réel de suivi de la migration PostgreSQL : une par nouvelle session d’un ancien logiciel (poste absent depuis plus de ${SESSION_GAP_MIN} min), détectée par les relevés de connexions toutes les 2 min. Le récapitulatif de la journée arrive à 19 h 30.`,
  }
  const subject = `Legacy HFSQL - ${hhmm(first.slot)} - ${n === 1 ? first.label : `${n} postes`}${flagged.length ? ' - NOUVEAU' : ''}`
  const rendered = renderNotificationEmail(content)
  console.log(`${stamp} Subject: ${subject}\n\n${rendered.text}`)

  if (!SEND) { console.log('\n(dry run: nothing sent, state unchanged; pass --send)'); return }
  await sendMail({
    from: TO,
    fromName: 'MPS - Notification',
    to: [TO],
    subject,
    body: rendered.text,
    bodyHtml: rendered.html,
    inlineImages: rendered.inlineImages,
    signatureHtml: null,
  })
  // Saved only once the mail is out: a Gmail failure retries on the next run.
  saveState(next)
  console.log(`sent to ${TO}`)
}

main().then(() => process.exit(process.exitCode ?? 0), e => { console.error(e); process.exit(1) })
