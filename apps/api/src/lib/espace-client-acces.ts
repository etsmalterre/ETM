// Who may use the espace client (client.etsmalterre.fr): one row per ERP contact given
// access. The ERP decides — the portal never creates, suspends or deletes an account; it
// reads the list (GET /api/site/espace/acces) and reports back what happened
// (POST /api/site/espace/activite: invitation sent, password set, sign-in).
//
// Stored in PostgreSQL, database `espace_client` (windev_migration docs/plan.md D9): data
// WinDev never reads is born in PostgreSQL rather than in a new HFSQL table. It links to
// HFSQL by id only (`idcontact`, `idclient`), joined here in JS — flat lookups, no JOIN.
// Without ESPACE_CLIENT_PG_URL the feature is off: the routes answer 503, nothing else
// in the API depends on it.

import postgres from 'postgres'
import { query, fixEncoding } from './hfsql-auto.js'

type Sql = ReturnType<typeof postgres>

let sql: Sql | null = null
let ready: Promise<void> | null = null

export class EspaceIndisponible extends Error {
  constructor() { super('espace client: ESPACE_CLIENT_PG_URL not set') }
}

// Append-only: never edit a shipped migration, add the next.
const MIGRATIONS: string[] = [
  `CREATE TABLE acces (
     idcontact             integer PRIMARY KEY,
     idclient              integer NOT NULL,
     actif                 boolean NOT NULL,
     modifie_le            timestamptz NOT NULL DEFAULT now(),
     modifie_par           text NOT NULL,
     invitation_le         timestamptz,
     mot_de_passe_le       timestamptz,
     derniere_connexion_le timestamptz
   );
   CREATE INDEX acces_client ON acces (idclient);
   CREATE TABLE journal (
     id        bigserial PRIMARY KEY,
     le        timestamptz NOT NULL DEFAULT now(),
     idcontact integer NOT NULL,
     idclient  integer NOT NULL,
     action    text NOT NULL,
     par       text NOT NULL,
     detail    text
   );
   CREATE INDEX journal_contact ON journal (idcontact);`,
]

function db(): Sql {
  const url = process.env.ESPACE_CLIENT_PG_URL
  if (!url) throw new EspaceIndisponible()
  sql ??= postgres(url, {
    max: 3,
    idle_timeout: 60,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: 'mps-api espace-client' },
  })
  return sql
}

async function migrate(s: Sql): Promise<void> {
  await s`CREATE TABLE IF NOT EXISTS schema_version (version integer NOT NULL)`
  await s.begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    await tx`LOCK TABLE schema_version IN EXCLUSIVE MODE`
    const [row] = await tx<{ version: number }[]>`SELECT version FROM schema_version`
    let v = row ? Number(row.version) : 0
    if (!row) await tx`INSERT INTO schema_version (version) VALUES (0)`
    for (; v < MIGRATIONS.length; v++) {
      await tx.unsafe(MIGRATIONS[v])
      await tx`UPDATE schema_version SET version = ${v + 1}`
    }
  })
}

/** The connection, schema up to date. Throws EspaceIndisponible when not configured. */
async function conn(): Promise<Sql> {
  const s = db()
  ready ??= migrate(s).catch((err) => { ready = null; throw err })
  await ready
  return s
}

export function espaceConfigure(): boolean {
  return !!process.env.ESPACE_CLIENT_PG_URL
}

// ── Rules (pure, tested) ────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normaliserEmail(mail: unknown): string {
  return String(mail ?? '').trim().toLowerCase()
}

export function emailValide(mail: string): boolean {
  return EMAIL.test(mail)
}

export interface ContactErp {
  IDcontact: number
  IDclient: number
  nom: string
  prenom: string
  mail: string
  visible: boolean
}

export interface ClientErp {
  IDclient: number
  nom: string
  visible: boolean
  societe: number
}

export interface AccesRow {
  idcontact: number
  idclient: number
  actif: boolean
  modifie_le: Date
}

export interface AccesPortail {
  idcontact: number
  idclient: number
  client: string
  email: string
  prenom: string
  nom: string
}

/**
 * The accounts the portal must honour: active rows whose contact still exists, still
 * belongs to that client, is visible and has a valid e-mail, at a visible ETS Malterre
 * client. An e-mail is a login, so it may appear once: on a clash the oldest grant wins
 * (the grant route refuses a clash; this only covers an e-mail changed in the ERP later).
 */
export function accesEffectifs(
  rows: AccesRow[],
  contacts: Map<number, ContactErp>,
  clients: Map<number, ClientErp>,
): AccesPortail[] {
  const out: AccesPortail[] = []
  const vus = new Set<string>()
  const tries = [...rows].sort((a, b) => a.modifie_le.getTime() - b.modifie_le.getTime() || a.idcontact - b.idcontact)
  for (const r of tries) {
    if (!r.actif) continue
    const c = contacts.get(r.idcontact)
    if (!c || !c.visible || c.IDclient !== r.idclient) continue
    const cl = clients.get(c.IDclient)
    if (!cl || !cl.visible || cl.societe !== 1) continue
    const email = normaliserEmail(c.mail)
    if (!emailValide(email) || vus.has(email)) continue
    vus.add(email)
    out.push({ idcontact: c.IDcontact, idclient: c.IDclient, client: cl.nom, email, prenom: c.prenom, nom: c.nom })
  }
  return out
}

// ── HFSQL reads (flat IN lookups, chunks of 50) ─────────────

function chunks<T>(xs: T[], n = 50): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

const str = (v: unknown) => String(v ?? '').trim()

export async function contactsErp(ids: number[]): Promise<Map<number, ContactErp>> {
  const m = new Map<number, ContactErp>()
  for (const part of chunks([...new Set(ids)].filter(Number.isInteger))) {
    const rows = await fixEncoding(
      await query<Record<string, unknown>>(
        `SELECT IDcontact, IDclient, nom, prenom, mail, est_visible FROM contact WHERE IDcontact IN (${part.join(',')})`,
      ),
      'contact', 'IDcontact', ['nom', 'prenom'],
    )
    for (const r of rows) {
      m.set(Number(r.IDcontact), {
        IDcontact: Number(r.IDcontact), IDclient: Number(r.IDclient),
        nom: str(r.nom), prenom: str(r.prenom), mail: str(r.mail), visible: Number(r.est_visible) === 1,
      })
    }
  }
  return m
}

export async function clientsErp(ids: number[]): Promise<Map<number, ClientErp>> {
  const m = new Map<number, ClientErp>()
  for (const part of chunks([...new Set(ids)].filter(Number.isInteger))) {
    const rows = await fixEncoding(
      await query<Record<string, unknown>>(
        `SELECT IDclient, nom, est_visible, IDsociete FROM client WHERE IDclient IN (${part.join(',')})`,
      ),
      'client', 'IDclient', ['nom'],
    )
    for (const r of rows) {
      m.set(Number(r.IDclient), {
        IDclient: Number(r.IDclient), nom: str(r.nom), visible: Number(r.est_visible) === 1, societe: Number(r.IDsociete),
      })
    }
  }
  return m
}

// ── ETM side ────────────────────────────────────────────────

export interface AccesContact {
  idcontact: number
  actif: boolean
  modifie_le: Date
  modifie_par: string
  invitation_le: Date | null
  mot_de_passe_le: Date | null
  derniere_connexion_le: Date | null
}

/** Access state of every contact of one client that ever had a row. */
export async function accesDuClient(idclient: number): Promise<AccesContact[]> {
  const s = await conn()
  return s<AccesContact[]>`
    SELECT idcontact, actif, modifie_le, modifie_par, invitation_le, mot_de_passe_le, derniere_connexion_le
    FROM acces WHERE idclient = ${idclient} ORDER BY idcontact`
}

export class AccesRefuse extends Error {}

/** Grant or remove one contact's access. Checks the ERP side first: the contact belongs to
 *  that client, is visible and has a valid e-mail no other active access uses. */
export async function changerAcces(idcontact: number, idclient: number, actif: boolean, par: string): Promise<void> {
  const s = await conn()
  if (actif) {
    const c = (await contactsErp([idcontact])).get(idcontact)
    if (!c || c.IDclient !== idclient) throw new AccesRefuse('Contact introuvable pour ce client.')
    if (!c.visible) throw new AccesRefuse('Ce contact est masqué dans l’ERP.')
    const email = normaliserEmail(c.mail)
    if (!emailValide(email)) throw new AccesRefuse('Ce contact n’a pas d’adresse e-mail valide : renseignez-la d’abord.')
    const cl = (await clientsErp([idclient])).get(idclient)
    if (!cl || !cl.visible || cl.societe !== 1) throw new AccesRefuse('Ce client n’est pas un client ETS Malterre actif.')
    const autres = await s<{ idcontact: number; idclient: number }[]>`
      SELECT idcontact, idclient FROM acces WHERE actif AND idcontact <> ${idcontact}`
    const erp = await contactsErp(autres.map((a) => a.idcontact))
    const clash = autres.find((a) => normaliserEmail(erp.get(a.idcontact)?.mail) === email)
    if (clash) {
      const autre = (await clientsErp([clash.idclient])).get(clash.idclient)
      throw new AccesRefuse(`L’adresse ${email} a déjà un accès (client ${autre?.nom ?? clash.idclient}). Une adresse = un seul accès.`)
    }
  }
  await s.begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    const [avant] = await tx<{ actif: boolean }[]>`SELECT actif FROM acces WHERE idcontact = ${idcontact} FOR UPDATE`
    if (avant && avant.actif === actif) return
    await tx`
      INSERT INTO acces (idcontact, idclient, actif, modifie_par)
      VALUES (${idcontact}, ${idclient}, ${actif}, ${par})
      ON CONFLICT (idcontact) DO UPDATE SET idclient = ${idclient}, actif = ${actif}, modifie_le = now(), modifie_par = ${par}`
    await tx`
      INSERT INTO journal (idcontact, idclient, action, par)
      VALUES (${idcontact}, ${idclient}, ${actif ? 'accorde' : 'retire'}, ${par})`
  })
  cacheListe = null
}

// ── Portal side ─────────────────────────────────────────────

let cacheListe: { at: number; acces: AccesPortail[] } | null = null

/** The list the portal honours. Cached 30 s: the portal reads it on a timer and at each
 *  sign-in, HFSQL is spared the burst. A change made in ETM clears the cache. */
export async function listeAcces(): Promise<AccesPortail[]> {
  if (cacheListe && Date.now() - cacheListe.at < 30_000) return cacheListe.acces
  const s = await conn()
  const rows = await s<AccesRow[]>`SELECT idcontact, idclient, actif, modifie_le FROM acces WHERE actif`
  const contacts = await contactsErp(rows.map((r) => r.idcontact))
  const clients = await clientsErp([...contacts.values()].map((c) => c.IDclient))
  const acces = accesEffectifs(rows, contacts, clients)
  cacheListe = { at: Date.now(), acces }
  return acces
}

export type TypeEvenement = 'invitation' | 'mot_de_passe' | 'connexion'

export interface Evenement {
  idcontact: number
  type: TypeEvenement
  le: Date
}

const COLONNE: Record<TypeEvenement, 'invitation_le' | 'mot_de_passe_le' | 'derniere_connexion_le'> = {
  invitation: 'invitation_le',
  mot_de_passe: 'mot_de_passe_le',
  connexion: 'derniere_connexion_le',
}

/** What the portal reports. Unknown contacts are ignored; a date never goes backwards.
 *  Invitations and passwords are journaled, sign-ins only update the date. */
export async function enregistrerActivite(evenements: Evenement[]): Promise<number> {
  const s = await conn()
  let n = 0
  await s.begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    for (const e of evenements) {
      const col = COLONNE[e.type]
      const [row] = await tx<{ idclient: number }[]>`
        UPDATE acces SET ${tx(col)} = GREATEST(COALESCE(${tx(col)}, ${e.le}), ${e.le})
        WHERE idcontact = ${e.idcontact} RETURNING idclient`
      if (!row) continue
      n++
      if (e.type !== 'connexion') {
        await tx`
          INSERT INTO journal (le, idcontact, idclient, action, par)
          VALUES (${e.le}, ${e.idcontact}, ${row.idclient}, ${e.type}, 'espace client')`
      }
    }
  })
  return n
}
