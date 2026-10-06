// Journal d'activité — who did what in ETM / TRM (2026-10-06).
//
// Until then the API recorded logins (`connexion`) and a few per-screen
// journals, never « this person changed that order at 10:42 ». One middleware,
// mounted right after attachUser() in index.ts, writes a row of
// `journal_activite` (migration 0011) for:
//   - every WRITE (POST / PUT / PATCH / DELETE) of an identified account —
//     whatever its answer, so a refused or failed attempt is there too;
//   - every 5xx answer to an identified account, reads included (the
//     technical errors a person ran into).
// Plain reads are NOT journaled (decision Vincent 2026-10-06: writes + errors).
//
// Read by the agent « Rapport d'activité » (lib/agents/rapport-activite/).
// ⚠️ Recording people's work is a monitoring device: the people concerned are
// informed (Code du travail L1222-4) — keep the scope to what is written here,
// and the purge (one year) running.
//
// Never blocks nor fails a request: the insert runs after the answer is sent,
// and a database error is logged at most once a minute.

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { mpsPg } from './mps-pg.js'
import { clientIp } from './auth.js'

const ECRITURES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Not journaled at all: machines (the TRS collector writes every few
 *  seconds), and the dashboard layout saved on every drag. */
const EXCLUS = [/^\/api\/recorder\//, /^\/api\/health/, /^\/api\/user-profiles/]

/** Journaled, but never with the request body: credentials, RH data. */
const CORPS_MASQUE = [/^\/api\/auth\//, /^\/api\/comptes/, /^\/api\/rh\//, /^\/api\/utilisateurs/]

/** A body key whose value is never stored. */
const CLE_SECRETE = /pass|mdp|mot_?de_?passe|token|jeton|secret|^code(_rh)?$|signature/i

export const DUREE_CONSERVATION_JOURS = 365

const MAX_CORPS = 1500
const MAX_TEXTE = 200

/** The request body as a short JSON for the report: secrets dropped, long
 *  texts and files replaced by their size, arrays and depth bounded. */
export function resumerCorps(body: unknown): string | null {
  if (body === undefined || body === null) return null
  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body as object).length === 0) return null
  const reduire = (v: unknown, profondeur: number): unknown => {
    if (typeof v === 'string') {
      if (v.length > 500 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 500))) return `[fichier ${Math.round(v.length * 0.75 / 1024)} Ko]`
      return v.length > MAX_TEXTE ? `${v.slice(0, MAX_TEXTE)}… [${v.length} car.]` : v
    }
    if (v === null || typeof v !== 'object') return v
    if (profondeur >= 3) return Array.isArray(v) ? `[${v.length} éléments]` : '{…}'
    if (Array.isArray(v)) {
      const t = v.slice(0, 20).map((x) => reduire(x, profondeur + 1))
      return v.length > 20 ? [...t, `… ${v.length - 20} de plus`] : t
    }
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = CLE_SECRETE.test(k) ? '[masqué]' : reduire(x, profondeur + 1)
    return out
  }
  const s = JSON.stringify(reduire(body, 0))
  return s.length > MAX_CORPS ? `${s.slice(0, MAX_CORPS)}…` : s
}

/** The message an error answer carried (`{ error }` or `{ message }`). */
export function messageErreur(body: unknown): string | null {
  if (typeof body === 'string') return body.slice(0, 300) || null
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const m = [b.message, b.error, b.erreur].find((x) => typeof x === 'string' && x.trim()) as string | undefined
  return m ? m.slice(0, 300) : null
}

/** The page the person was on (Referer: host + path + query), or the Origin. */
function pageDe(req: Request): { origine: string | null; ecran: string | null } {
  const brut = (req.headers.referer as string | undefined) ?? (req.headers.origin as string | undefined)
  if (!brut) return { origine: null, ecran: null }
  try {
    const u = new URL(brut)
    return { origine: u.host, ecran: `${u.pathname}${u.search}`.slice(0, 300) }
  } catch {
    return { origine: null, ecran: null }
  }
}

let derniereErreurLog = 0

export function journaliserActivite(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const chemin = req.originalUrl.split('?')[0]
    if (EXCLUS.some((r) => r.test(chemin))) return next()
    const t0 = Date.now()
    let erreur: string | null = null
    const json = res.json.bind(res)
    res.json = (body?: unknown) => {
      if (res.statusCode >= 400) erreur = messageErreur(body)
      return json(body)
    }
    res.on('finish', () => {
      if (req.userId === undefined) return
      const ecriture = ECRITURES.has(req.method)
      if (!ecriture && res.statusCode < 500) return
      const { origine, ecran } = pageDe(req)
      const corps = ecriture && !CORPS_MASQUE.some((r) => r.test(chemin)) ? resumerCorps(req.body) : null
      const idutilisateur = req.session?.idutilisateur ?? req.userId
      const voirComme = req.session?.voirComme ?? null
      const appareil = req.appareil ? `${req.appareil.id}` : null
      mpsPg()`
        INSERT INTO journal_activite (idutilisateur, voir_comme, appareil, methode, chemin, statut, duree_ms, origine, ecran, corps, erreur, ip)
        VALUES (${idutilisateur}, ${voirComme}, ${appareil}, ${req.method}, ${chemin.slice(0, 300)}, ${res.statusCode},
                ${Date.now() - t0}, ${origine}, ${ecran}, ${corps}, ${erreur}, ${clientIp(req)})`
        .catch((err: unknown) => {
          if (Date.now() - derniereErreurLog < 60_000) return
          derniereErreurLog = Date.now()
          console.error('[journal-activite] insert failed:', err instanceof Error ? err.message : err)
        })
    })
    next()
  }
}

// ── Reads ────────────────────────────────────────────────

export interface LigneJournal {
  le: Date
  voir_comme: number | null
  appareil: string | null
  methode: string
  chemin: string
  statut: number
  duree_ms: number
  origine: string | null
  ecran: string | null
  corps: string | null
  erreur: string | null
  ip: string | null
}

/** One person's journal over [du, au), oldest first. */
export async function journalDe(idutilisateur: number, du: Date, au: Date): Promise<LigneJournal[]> {
  return mpsPg()<LigneJournal[]>`
    SELECT le, voir_comme, appareil, methode, chemin, statut, duree_ms, origine, ecran, corps, erreur, ip
    FROM journal_activite
    WHERE idutilisateur = ${idutilisateur} AND le >= ${du} AND le < ${au}
    ORDER BY le, id`
}

/** Deletes rows past the retention period. Returns how many went. */
export async function purgerJournal(): Promise<number> {
  const r = await mpsPg()`DELETE FROM journal_activite WHERE le < now() - make_interval(days => ${DUREE_CONSERVATION_JOURS})`
  return r.count
}
