// Shared by the two legacy-audit scripts (windev_migration repo, docs/plan.md § Step 1):
// scripts/legacy-activity-report.ts (evening digest) and scripts/legacy-activity-alert.ts
// (one email per new legacy session, every 2 min). Reads the connection samples taken on
// the HFSQL server by windev_migration/legacy-audit/sample.py and names the hosts.

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const SAMPLE_MINUTES = 2
export const HFSQL_HOST = '10.10.20.2'
export const TZ = 'Europe/Paris'

/** Servers and services, recognised by IP. `legacy: false` = expected
 *  (the new stack); true = a legacy WebDev/WinDev service that must be
 *  ported or stopped before the cutover. */
export const KNOWN_HOSTS: Record<string, { label: string; legacy: boolean }> = {
  '10.10.20.3': { label: 'MPS API (nouvelles applications)', legacy: false },
  '10.10.20.6': { label: 'Copie de nuit HFSQL → PostgreSQL', legacy: false },
  '10.10.11.2': { label: 'Collecteur TRS (data-recorder)', legacy: true },
  '10.10.54.2': { label: 'WebDev tricotbotapi (n8n)', legacy: true },
  '10.10.55.2': { label: 'WebDev webservice (alpha.etsmalterre.com)', legacy: true },
  '10.10.53.2': { label: 'Serveur GDS', legacy: true },
  '10.10.80.2': { label: 'n8n', legacy: true },
}

export interface Sample { hhmm: string; ip: string; conns: number; name: string }
export interface JnlUser { User_ID: number; WorkStation_Name: string; Application: string; IPAddress64: string }

/** Today's date (or any instant's) as YYYY-MM-DD in Paris time. */
export const parisDay = (t = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(t)

/** One day's samples, through the forced-command key (serve.sh on the HFSQL
 *  server prints that day's file and nothing else), or from a local file. */
export function fetchSamples(day: string, localFile?: string): { samples: Sample[]; error: string | null } {
  let raw = ''
  try {
    raw = localFile
      ? readFileSync(localFile, 'utf8')
      : execFileSync('ssh', [
          '-i', join(homedir(), '.ssh', 'hfsql_audit'),
          '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
          `debian@${HFSQL_HOST}`, day,
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

/** Key a host by NetBIOS name when it has one (DHCP moves PCs around), else by IP. */
export const hostKey = (s: { ip: string; name: string }) => s.name ? s.name.toUpperCase() : s.ip
export const isLegacyIp = (ip: string) => KNOWN_HOSTS[ip]?.legacy ?? true

export function appLabel(application: string): string {
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

export const shortName = (ws: string) => ws.split('.')[0].toUpperCase()

/** Which applications this host is known for in jnl_users: by NetBIOS name
 *  when we have one (DHCP moves PCs around), else by the latest row for the IP. */
export function appsFor(ip: string, name: string, users: JnlUser[]): string[] {
  if (name) {
    const mine = users.filter(u => shortName(u.WorkStation_Name) === name.toUpperCase())
    if (mine.length) return [...new Set(mine.map(u => appLabel(u.Application)))]
  }
  const byIp = users.filter(u => u.IPAddress64 === ip).sort((a, b) => b.User_ID - a.User_ID)
  return byIp.length ? [appLabel(byIp[0].Application)] : []
}

/** A PC that doesn't answer NetBIOS: the workstation name of the latest
 *  jnl_users row for its IP. A guess only, DHCP may have moved it since. */
export function probableName(ip: string, users: JnlUser[]): string | null {
  const u = users.filter(x => x.IPAddress64 === ip && !/^\d/.test(x.WorkStation_Name))
    .sort((a, b) => b.User_ID - a.User_ID)[0]
  return u ? shortName(u.WorkStation_Name) : null
}

/** Human label of a host seen in the samples, and its applications. */
export function describeHost(ip: string, name: string, users: JnlUser[]): { label: string; apps: string[] } {
  const known = KNOWN_HOSTS[ip]
  if (known) return { label: known.label, apps: [] }
  const apps = appsFor(ip, name, users)
  const probable = probableName(ip, users)
  const label = name ? name.toUpperCase()
    : ip.startsWith('100.') ? `${ip} (Tailscale, poste distant)`
    : apps.some(a => a.startsWith('tablette')) ? `tablette ${ip}`
    : probable ? `${ip} (probablement ${probable})` : ip
  return { label, apps }
}

export function parseJnlUsers(rows: Record<string, unknown>[]): JnlUser[] {
  return rows.map(r => ({
    User_ID: Number(r.User_ID),
    WorkStation_Name: String(r.WorkStation_Name ?? '').trim(),
    Application: String(r.Application ?? '').trim(),
    IPAddress64: String(r.IPAddress64 ?? '').trim(),
  }))
}

export const JNL_USERS_SQL = 'SELECT User_ID, WorkStation_Name, Application, IPAddress64 FROM jnl_users'
