// Evening report of LEGACY (WinDev) activity on the HFSQL server, mailed to
// Vincent every evening until the PostgreSQL cutover (windev_migration repo, docs/plan.md
// § Step 1). Goal: see which workstation / tablet still runs the old
// software, so it can be uninstalled everywhere before HFSQL is switched off.
//
// Two sources, because HFSQL itself logs no connections:
//   1. the connection samples taken every 2 min on 10.10.20.2 by
//      windev_migration/legacy-audit/sample.py — the only trace of
//      READ-ONLY use. Fetched through a forced-command ssh key (serve.sh) that
//      can print one day's file and nothing else.
//   2. the HFSQL journal (Database=__jnl): jnl_users names who is behind an IP
//      (workstation, application), jnl_operation timestamps the writes — but
//      only on the four atelier tables (message_of, bonnetier, utilisateur,
//      evenement_machine), so it mainly shows the workshop tablets.
//
// Also carries one line on the nightly HFSQL -> PostgreSQL rehearsal (step 2),
// read from the PG VM through the same key (forced to serve-summary.sh there).
//
// Usage (on the API host, from ~/mps_api):
//   npx tsx src/scripts/legacy-activity-report.ts                  # dry run, prints the text part
//   npx tsx src/scripts/legacy-activity-report.ts --send           # mail it + update the state file
//   options: --date=YYYY-MM-DD  --to=a@b.fr  --preview=out.html  --samples=<local .tsv>
// Cron (debian, 10.10.20.3): 30 19 * * * — see windev_migration/docs/plan.md.

import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { createHfsqlClient } from '../lib/hfsql-auto.js'
import {
  renderNotificationEmail,
  renderNotificationEmailPreview,
  type NotificationEmailContent,
  type NotificationRow,
} from '../lib/notification-email.js'
import { sendMail } from '../lib/gmail.js'

const SAMPLE_MINUTES = 2
const HFSQL_HOST = '10.10.20.2'
/** The PostgreSQL VM, where the nightly HFSQL -> PG rehearsal runs (pg_migrate.py). */
const PG_HOST = '10.10.20.6'
const DEFAULT_TO = 'vincent@etsmalterre.com'
const STATE_FILE = resolve('data/legacy-audit-state.json')
const RETIRED_AFTER_DAYS = 7
const TZ = 'Europe/Paris'

/** Servers and services, recognised by IP. `legacy: false` = expected
 *  (the new stack); true = a legacy WebDev/WinDev service that must be
 *  ported or stopped before the cutover. */
const KNOWN_HOSTS: Record<string, { label: string; legacy: boolean }> = {
  '10.10.20.3': { label: 'MPS API (nouvelles applications)', legacy: false },
  '10.10.11.2': { label: 'Collecteur TRS (data-recorder)', legacy: true },
  '10.10.54.2': { label: 'WebDev tricotbotapi (n8n)', legacy: true },
  '10.10.55.2': { label: 'WebDev webservice (alpha.etsmalterre.com)', legacy: true },
  '10.10.53.2': { label: 'Serveur GDS', legacy: true },
  '10.10.80.2': { label: 'n8n', legacy: true },
}

// ── args ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const SEND = args.includes('--send')
const DAY = arg('date') ?? new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
const TO = arg('to') ?? DEFAULT_TO
if (!/^\d{4}-\d{2}-\d{2}$/.test(DAY)) throw new Error(`--date must be YYYY-MM-DD, got ${DAY}`)

// ── types ─────────────────────────────────────────────────

interface Sample { hhmm: string; ip: string; conns: number; name: string }
interface JnlUser { User_ID: number; WorkStation_Name: string; Application: string; IPAddress64: string }
interface HostDay {
  key: string
  label: string
  apps: string[]
  legacy: boolean
  minutes: number
  first: string | null
  last: string | null
  writes: number
  writeTables: Set<string>
}
interface HostState { label: string; firstSeen: string; lastSeen: string; apps: string[] }
interface State { hosts: Record<string, HostState>; lastReport?: string }

// ── sources ───────────────────────────────────────────────

function fetchSamples(): { samples: Sample[]; error: string | null } {
  let raw = ''
  try {
    const local = arg('samples')
    raw = local
      ? readFileSync(local, 'utf8')
      : execFileSync('ssh', [
          '-i', join(homedir(), '.ssh', 'hfsql_audit'),
          '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
          `debian@${HFSQL_HOST}`, DAY,
        ], { encoding: 'utf8', timeout: 30_000 })
  } catch (e) {
    return { samples: [], error: (e as Error).message.split('\n')[0] }
  }
  const samples: Sample[] = []
  for (const line of raw.split('\n')) {
    const [hhmm, ip, conns, name] = line.split('\t')
    if (!hhmm || !ip) continue
    samples.push({ hhmm, ip, conns: Number(conns) || 0, name: (name ?? '').trim() })
  }
  return { samples, error: null }
}

interface MigrationSummary {
  run?: string; tables?: number; tables_ok?: number; rows?: number; duration_min?: number
  new?: number; regressed?: number; open_errors?: number; gone?: number
}

/** Summary of the latest nightly rehearsal, through the same key, forced on the
 *  PG VM to serve-summary.sh (it can print that JSON and nothing else). */
function fetchMigration(): { summary: MigrationSummary | null; error: string | null } {
  try {
    const raw = execFileSync('ssh', [
      '-i', join(homedir(), '.ssh', 'hfsql_audit'),
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      `debian@${PG_HOST}`,
    ], { encoding: 'utf8', timeout: 30_000 })
    const s = JSON.parse(raw) as MigrationSummary
    return { summary: s.run ? s : null, error: null }
  } catch (e) {
    return { summary: null, error: (e as Error).message.split('\n')[0] }
  }
}

function migrationRow(m: { summary: MigrationSummary | null; error: string | null }): NotificationRow {
  const label = 'Migration PostgreSQL'
  if (m.error) return { label, value: `résumé INDISPONIBLE : ${m.error}` }
  const s = m.summary
  if (!s?.run) return { label, value: 'aucune copie de nuit pour l’instant' }
  const [d, t] = s.run.split('_')
  const age = daysBetween(d, DAY)
  const when = `${frDate(d)} à ${t.slice(0, 2)}:${t.slice(2)}`
  const parts = [
    `copie du ${when}${age > 1 ? ` (PAS DE COPIE DEPUIS ${age} JOURS)` : ''}`,
    `${s.tables_ok}/${s.tables} tables, ${(s.rows ?? 0).toLocaleString('fr-FR')} lignes en ${String(s.duration_min).replace(".", ",")} min`,
    `${s.new} nouveau${(s.new ?? 0) > 1 ? 'x' : ''} problème${(s.new ?? 0) > 1 ? 's' : ''}`,
    s.regressed ? `${s.regressed} revenu${s.regressed > 1 ? 's' : ''}` : null,
    `${s.open_errors} erreur${(s.open_errors ?? 0) > 1 ? 's' : ''} ouverte${(s.open_errors ?? 0) > 1 ? 's' : ''}`,
    (s.new || s.regressed) ? 'à revoir avec /pg_migration_review' : null,
  ].filter(Boolean)
  return { label, value: parts.join(' · ') }
}

/** Local Paris day → the UTC instants bounding it (jnl Server_Time is UTC). */
function utcBounds(day: string): [Date, Date] {
  const [y, m, d] = day.split('-').map(Number)
  const offsetAt = (t: Date) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
      .formatToParts(t).find(x => x.type === 'timeZoneName')?.value ?? 'GMT+00:00'
    const mm = p.match(/GMT([+-])(\d{2}):?(\d{2})?/)
    return mm ? (mm[1] === '-' ? -1 : 1) * (Number(mm[2]) * 60 + Number(mm[3] ?? 0)) : 0
  }
  const start = new Date(Date.UTC(y, m - 1, d) - offsetAt(new Date(Date.UTC(y, m - 1, d, 12))) * 60_000)
  const end = new Date(Date.UTC(y, m - 1, d + 1) - offsetAt(new Date(Date.UTC(y, m - 1, d + 1, 12))) * 60_000)
  return [start, end]
}

const hfsqlStamp = (t: Date) => t.toISOString().slice(0, 19).replace('T', ' ')

async function fetchJournal(): Promise<{ users: JnlUser[]; writes: Map<number, { n: number; tables: Set<string> }>; error: string | null }> {
  const writes = new Map<number, { n: number; tables: Set<string> }>()
  const cs = process.env.HFSQL_CONNECTION_STRING
  if (!cs) return { users: [], writes, error: 'HFSQL_CONNECTION_STRING absent' }
  const jnl = createHfsqlClient(cs.replace(/Database=[^;]*/i, 'Database=__jnl'))
  try {
    const users = (await jnl.query<Record<string, unknown>>(
      'SELECT User_ID, WorkStation_Name, Application, IPAddress64 FROM jnl_users',
    )).map(r => ({
      User_ID: Number(r.User_ID),
      WorkStation_Name: String(r.WorkStation_Name ?? '').trim(),
      Application: String(r.Application ?? '').trim(),
      IPAddress64: String(r.IPAddress64 ?? '').trim(),
    }))
    const [from, to] = utcBounds(DAY)
    const ops = await jnl.query<Record<string, unknown>>(
      `SELECT User_ID, JNLFile_ID FROM jnl_operation ` +
      `WHERE Server_Time >= '${hfsqlStamp(from)}' AND Server_Time < '${hfsqlStamp(to)}'`,
    )
    const fileIds = [...new Set(ops.map(o => Number(o.JNLFile_ID)).filter(Number.isFinite))]
    const tableOf = new Map<number, string>()
    for (let i = 0; i < fileIds.length; i += 200) {
      const rows = await jnl.query<Record<string, unknown>>(
        `SELECT JNLFile_ID, Source_DB_File_Location FROM jnl_files WHERE JNLFile_ID IN (${fileIds.slice(i, i + 200).join(',')})`,
      )
      for (const r of rows) {
        const loc = String(r.Source_DB_File_Location ?? '')
        tableOf.set(Number(r.JNLFile_ID), loc.split(/[\\/]/).pop()!.replace(/\.fic$/i, ''))
      }
    }
    for (const o of ops) {
      const uid = Number(o.User_ID)
      const w = writes.get(uid) ?? { n: 0, tables: new Set<string>() }
      w.n++
      const t = tableOf.get(Number(o.JNLFile_ID))
      if (t) w.tables.add(t)
      writes.set(uid, w)
    }
    return { users, writes, error: null }
  } catch (e) {
    return { users: [], writes, error: (e as Error).message.split('\n')[0] }
  } finally {
    await jnl.closeConnection().catch(() => {})
  }
}

// ── classification ────────────────────────────────────────

function appLabel(application: string): string {
  const a = application.toUpperCase()
  if (a.includes('BONNETIER')) return 'tablette Bonnetier (WinDev Mobile)'
  if (a.includes('REGLEUR')) return 'tablette Régleur (WinDev Mobile)'
  if (a.startsWith('MPS.EXE')) return 'MPS (WinDev)'
  if (a.startsWith('WDTST')) return 'WinDev, mode test'
  if (a.startsWith('CC3')) return 'Centre de contrôle HFSQL'
  if (a.startsWith('HFSQL_BRIDGE')) return 'MPS API ou script'
  if (a.startsWith('NODE')) return 'script Node'
  if (a.startsWith('DATA_RECORDER')) return 'ancien collecteur TRS'
  return application || 'application inconnue'
}

const shortName = (ws: string) => ws.split('.')[0].toUpperCase()

/** Which applications this host is known for in jnl_users: by NetBIOS name
 *  when we have one (DHCP moves PCs around), else by the latest row for the IP. */
function appsFor(ip: string, name: string, users: JnlUser[]): string[] {
  if (name) {
    const mine = users.filter(u => shortName(u.WorkStation_Name) === name.toUpperCase())
    if (mine.length) return [...new Set(mine.map(u => appLabel(u.Application)))]
  }
  const byIp = users.filter(u => u.IPAddress64 === ip).sort((a, b) => b.User_ID - a.User_ID)
  return byIp.length ? [appLabel(byIp[0].Application)] : []
}

/** A PC that doesn't answer NetBIOS: the workstation name of the latest
 *  jnl_users row for its IP. A guess only, DHCP may have moved it since. */
function probableName(ip: string, users: JnlUser[]): string | null {
  const u = users.filter(x => x.IPAddress64 === ip && !/^\d/.test(x.WorkStation_Name))
    .sort((a, b) => b.User_ID - a.User_ID)[0]
  return u ? shortName(u.WorkStation_Name) : null
}

function hostKeyOfUser(u: JnlUser): { key: string; ip: string } {
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(u.WorkStation_Name)
  return { key: isIp ? u.IPAddress64 : shortName(u.WorkStation_Name), ip: u.IPAddress64 }
}

function buildDay(samples: Sample[], users: JnlUser[], writes: Map<number, { n: number; tables: Set<string> }>): HostDay[] {
  const hosts = new Map<string, HostDay>()
  const get = (key: string, ip: string, name: string): HostDay => {
    let h = hosts.get(key)
    if (!h) {
      const known = KNOWN_HOSTS[ip]
      const tailscale = ip.startsWith('100.')
      const apps = known ? [] : appsFor(ip, name, users)
      const label = known?.label
        ?? (name ? name.toUpperCase()
          : tailscale ? `${ip} (Tailscale, poste distant)`
          : apps.some(a => a.startsWith('tablette')) ? `tablette ${ip}`
          : probableName(ip, users) ? `${ip} (probablement ${probableName(ip, users)})` : ip)
      h = {
        key, label, apps,
        legacy: known ? known.legacy : true,
        minutes: 0, first: null, last: null, writes: 0, writeTables: new Set(),
      }
      hosts.set(key, h)
    }
    return h
  }
  // Presence: count distinct sample slots per host.
  const slots = new Map<string, Set<string>>()
  for (const s of samples) {
    if (s.ip === '-') continue
    const key = s.name ? s.name.toUpperCase() : s.ip
    const h = get(key, s.ip, s.name)
    const set = slots.get(key) ?? new Set<string>()
    set.add(s.hhmm)
    slots.set(key, set)
    if (!h.first || s.hhmm < h.first) h.first = s.hhmm
    if (!h.last || s.hhmm > h.last) h.last = s.hhmm
  }
  for (const [key, set] of slots) hosts.get(key)!.minutes = set.size * SAMPLE_MINUTES
  // Writes from the journal.
  const userById = new Map(users.map(u => [u.User_ID, u]))
  for (const [uid, w] of writes) {
    const u = userById.get(uid)
    if (!u) continue
    const { key, ip } = hostKeyOfUser(u)
    const h = hosts.get(key) ?? get(key, ip, /^\d/.test(key) ? '' : key)
    if (!h.apps.includes(appLabel(u.Application)) && !KNOWN_HOSTS[ip]) h.apps.push(appLabel(u.Application))
    h.writes += w.n
    for (const t of w.tables) h.writeTables.add(t)
  }
  return [...hosts.values()].sort((a, b) => Number(a.legacy) - Number(b.legacy) || b.minutes - a.minutes)
}

// ── state (first / last seen per host) ────────────────────

function loadState(): State {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State } catch { return { hosts: {} } }
}

function saveState(s: State) {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s, null, 2))
  renameSync(STATE_FILE + '.tmp', STATE_FILE)
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
const frDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
const duration = (min: number) => min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${min} min`

// ── main ──────────────────────────────────────────────────

async function main() {
  const { samples, error: sampleError } = fetchSamples()
  const { users, writes, error: jnlError } = await fetchJournal()
  const day = buildDay(samples, users, writes)
  const state = loadState()

  const legacyActive = day.filter(h => h.legacy)
  const newHosts = new Set(legacyActive.filter(h => !state.hosts[h.key]).map(h => h.key))
  const activeKeys = new Set(day.map(h => h.key))
  const retired = Object.entries(state.hosts)
    .filter(([k, h]) => !activeKeys.has(k) && daysBetween(h.lastSeen, DAY) >= RETIRED_AFTER_DAYS)
    .sort((a, b) => a[1].lastSeen.localeCompare(b[1].lastSeen))
  const silentRecently = Object.entries(state.hosts)
    .filter(([k, h]) => !activeKeys.has(k) && daysBetween(h.lastSeen, DAY) < RETIRED_AFTER_DAYS && h.lastSeen < DAY)

  const rows: NotificationRow[] = []
  for (const h of legacyActive) {
    const parts = [
      h.apps.length ? h.apps.join(', ') : null,
      h.minutes ? `${duration(h.minutes)} connecté` : null,
      h.first ? `${h.first} à ${h.last}` : null,
      h.writes ? `${h.writes} écriture${h.writes > 1 ? 's' : ''} (${[...h.writeTables].join(', ')})` : null,
      newHosts.has(h.key) ? 'NOUVEAU' : null,
    ].filter(Boolean)
    rows.push({ label: h.label, value: parts.join(' · ') })
  }
  for (const h of day.filter(x => !x.legacy)) {
    rows.push({ label: h.label, value: `connectée ${duration(h.minutes)} (normal)` })
  }
  rows.push(migrationRow(fetchMigration()))
  if (silentRecently.length) {
    rows.push({
      label: 'Silencieux depuis peu',
      value: silentRecently.map(([, h]) => `${h.label} (vu le ${frDate(h.lastSeen)})`).join(', '),
    })
  }
  if (retired.length) {
    rows.push({
      label: `Absents depuis ${RETIRED_AFTER_DAYS} j et plus`,
      value: retired.map(([, h]) => `${h.label} (dernier ${frDate(h.lastSeen)})`).join(', ') + ' : désinstallation à confirmer',
    })
  }
  const slots = [...new Set(samples.map(s => s.hhmm))].sort()
  rows.push({
    label: 'Relevés',
    value: sampleError
      ? `INDISPONIBLES : ${sampleError}`
      : slots.length
        ? `${slots.length} relevés, un toutes les ${SAMPLE_MINUTES} min, de ${slots[0]} à ${slots[slots.length - 1]}`
        : 'aucun relevé pour ce jour',
  })
  const totalWrites = [...writes.values()].reduce((s, w) => s + w.n, 0)
  const legacyWrites = legacyActive.reduce((s, h) => s + h.writes, 0)
  rows.push({
    label: 'Journal HFSQL',
    value: jnlError
      ? `INDISPONIBLE : ${jnlError}`
      : `${totalWrites} écriture${totalWrites > 1 ? 's' : ''} sur les tables atelier, dont ${legacyWrites} par un ancien logiciel`,
  })

  const n = legacyActive.length
  const content: NotificationEmailContent = {
    title: 'Activité legacy du jour',
    tone: n || sampleError || jnlError ? 'alert' : 'info',
    intro: n
      ? `**${n} poste${n > 1 ? 's' : ''} ou service${n > 1 ? 's' : ''}** ${n > 1 ? 'ont' : 'a'} encore utilisé la base HFSQL avec un ancien logiciel le ${frDate(DAY)}.`
      : `Aucun ancien logiciel n’a utilisé la base HFSQL le ${frDate(DAY)}.`,
    rows,
    callout: n
      ? `À désinstaller ou arrêter : ${legacyActive.map(h => h.label).join(', ')}. Ils ne doivent plus apparaître ici avant la bascule PostgreSQL.`
      : null,
    footerNote: 'Rapport quotidien de suivi de la migration PostgreSQL, envoyé chaque soir jusqu’à la bascule. Sources : connexions au serveur HFSQL relevées toutes les 2 min, et journal HFSQL (écritures des tables atelier seulement).',
  }
  const subject = `Legacy HFSQL - ${frDate(DAY)} - ${n ? `${n} poste${n > 1 ? 's' : ''} actif${n > 1 ? 's' : ''}` : 'aucune activité'}`

  const preview = arg('preview')
  if (preview) {
    writeFileSync(preview, renderNotificationEmailPreview(content))
    console.log(`preview → ${preview}`)
  }
  const rendered = renderNotificationEmail(content)
  console.log(`Subject: ${subject}\n\n${rendered.text}`)

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
  for (const h of day) {
    const prev = state.hosts[h.key]
    state.hosts[h.key] = {
      label: h.label,
      firstSeen: prev && prev.firstSeen < DAY ? prev.firstSeen : DAY,
      lastSeen: prev && prev.lastSeen > DAY ? prev.lastSeen : DAY,
      apps: [...new Set([...(prev?.apps ?? []), ...h.apps])],
    }
  }
  state.lastReport = DAY
  saveState(state)
  console.log(`\nsent to ${TO}; state → ${STATE_FILE}`)
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
