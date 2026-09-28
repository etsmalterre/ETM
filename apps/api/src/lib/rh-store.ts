// RH data: employees, their workload versions, the RH codes and a journal.
//
// Stored in PostgreSQL, database `rh` (dev twin `rh_dev`), role `rh_api` —
// windev_migration docs/plan.md D9: data WinDev never had is born in
// PostgreSQL, in its own database. Its own database rather than a table in
// `espace_client` because it is personal data (birthdays, photos) that only two
// people may read. Linked to HFSQL by `idutilisateur` only.
// Without RH_PG_URL the feature is off: the routes answer 503.

import postgres from 'postgres'
import type { TacheCharge, VersionCharge } from './rh-charge.js'

type Sql = ReturnType<typeof postgres>

let sql: Sql | null = null
let ready: Promise<void> | null = null

export class RhIndisponible extends Error {
  constructor() { super('rh: RH_PG_URL not set') }
}

// Append-only: never edit a shipped migration, add the next.
const MIGRATIONS: string[] = [
  `CREATE TABLE employe (
     id              serial PRIMARY KEY,
     prenom          text NOT NULL,
     nom             text NOT NULL DEFAULT '',
     poste           text NOT NULL DEFAULT '',
     email           text NOT NULL DEFAULT '',
     date_embauche   date,
     date_naissance  date,
     idutilisateur   integer,
     heures_contrat  numeric(5,2) NOT NULL DEFAULT 35,
     photo           bytea,
     photo_maj       timestamptz,
     cree_le         timestamptz NOT NULL DEFAULT now(),
     modifie_le      timestamptz NOT NULL DEFAULT now(),
     modifie_par     text NOT NULL
   );
   CREATE TABLE charge_version (
     id           serial PRIMARY KEY,
     idemploye    integer NOT NULL REFERENCES employe (id) ON DELETE CASCADE,
     date_releve  date NOT NULL,
     note         text NOT NULL DEFAULT '',
     cree_le      timestamptz NOT NULL DEFAULT now(),
     cree_par     text NOT NULL,
     UNIQUE (idemploye, date_releve)
   );
   CREATE TABLE charge_tache (
     id                 serial PRIMARY KEY,
     idversion          integer NOT NULL REFERENCES charge_version (id) ON DELETE CASCADE,
     ordre              integer NOT NULL,
     nom                text NOT NULL,
     description        text NOT NULL DEFAULT '',
     methode            text NOT NULL DEFAULT '',
     heures             numeric(6,2) NOT NULL DEFAULT 0,
     automatisable      text NOT NULL DEFAULT 'inconnu',
     automatise         boolean NOT NULL DEFAULT false,
     categorie          text NOT NULL DEFAULT 'tache',
     indicateur         text,
     minutes_par_unite  numeric(8,2)
   );
   CREATE INDEX charge_tache_version ON charge_tache (idversion);
   CREATE TABLE code_acces (
     personne    text PRIMARY KEY,
     hash        text NOT NULL,
     sel         text NOT NULL,
     modifie_le  timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE journal (
     id        bigserial PRIMARY KEY,
     le        timestamptz NOT NULL DEFAULT now(),
     personne  text NOT NULL,
     action    text NOT NULL,
     detail    text
   );`,
]

function db(): Sql {
  const url = process.env.RH_PG_URL
  if (!url) throw new RhIndisponible()
  sql ??= postgres(url, {
    max: 3,
    idle_timeout: 60,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: 'mps-api rh' },
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

/** The connection, schema up to date. Throws RhIndisponible when not configured. */
async function conn(): Promise<Sql> {
  const s = db()
  ready ??= migrate(s).catch((err) => { ready = null; throw err })
  await ready
  return s
}

export function rhConfigure(): boolean {
  return !!process.env.RH_PG_URL
}

export async function fermerRh(): Promise<void> {
  if (sql) await sql.end({ timeout: 5 })
  sql = null
  ready = null
}

// ── Journal ──────────────────────────────────────────────

export async function journaliser(personne: string, action: string, detail?: string): Promise<void> {
  const s = await conn()
  await s`INSERT INTO journal (personne, action, detail) VALUES (${personne}, ${action}, ${detail ?? null})`
}

// ── RH codes ─────────────────────────────────────────────

export async function lireCode(personne: string): Promise<{ hash: string; sel: string } | null> {
  const s = await conn()
  const [row] = await s<{ hash: string; sel: string }[]>`SELECT hash, sel FROM code_acces WHERE personne = ${personne}`
  return row ?? null
}

export async function ecrireCode(personne: string, hash: string, sel: string): Promise<void> {
  const s = await conn()
  await s`
    INSERT INTO code_acces (personne, hash, sel) VALUES (${personne}, ${hash}, ${sel})
    ON CONFLICT (personne) DO UPDATE SET hash = EXCLUDED.hash, sel = EXCLUDED.sel, modifie_le = now()`
}

// ── Employees ────────────────────────────────────────────

export interface Employe {
  id: number
  prenom: string
  nom: string
  poste: string
  email: string
  /** YYYY-MM-DD or null */
  dateEmbauche: string | null
  dateNaissance: string | null
  idutilisateur: number | null
  heuresContrat: number
  /** ISO timestamp of the photo, null = no photo (also the cache-buster). */
  photoMaj: string | null
}

interface EmployeRow {
  id: number
  prenom: string
  nom: string
  poste: string
  email: string
  date_embauche: string | null
  date_naissance: string | null
  idutilisateur: number | null
  heures_contrat: string
  photo_maj: Date | null
}

function versEmploye(r: EmployeRow): Employe {
  return {
    id: r.id,
    prenom: r.prenom,
    nom: r.nom,
    poste: r.poste,
    email: r.email,
    dateEmbauche: r.date_embauche,
    dateNaissance: r.date_naissance,
    idutilisateur: r.idutilisateur,
    heuresContrat: Number(r.heures_contrat),
    photoMaj: r.photo_maj ? r.photo_maj.toISOString() : null,
  }
}

// Dates come back as text (to_char) so no timezone ever shifts a birthday.
const COLONNES_EMPLOYE = `id, prenom, nom, poste, email,
  to_char(date_embauche, 'YYYY-MM-DD') AS date_embauche,
  to_char(date_naissance, 'YYYY-MM-DD') AS date_naissance,
  idutilisateur, heures_contrat, photo_maj`

export async function listerEmployes(): Promise<Employe[]> {
  const s = await conn()
  const rows = await s.unsafe<EmployeRow[]>(`SELECT ${COLONNES_EMPLOYE} FROM employe ORDER BY prenom, nom`)
  return rows.map(versEmploye)
}

export async function lireEmploye(id: number): Promise<Employe | null> {
  const s = await conn()
  const rows = await s.unsafe<EmployeRow[]>(`SELECT ${COLONNES_EMPLOYE} FROM employe WHERE id = $1`, [id])
  return rows[0] ? versEmploye(rows[0]) : null
}

export async function creerEmploye(prenom: string, nom: string, par: string): Promise<number> {
  const s = await conn()
  const [row] = await s<{ id: number }[]>`
    INSERT INTO employe (prenom, nom, modifie_par) VALUES (${prenom}, ${nom}, ${par}) RETURNING id`
  return row.id
}

export interface ChampsEmploye {
  prenom: string
  nom: string
  poste: string
  email: string
  dateEmbauche: string | null
  dateNaissance: string | null
  idutilisateur: number | null
  heuresContrat: number
}

export async function modifierEmploye(id: number, c: ChampsEmploye, par: string): Promise<boolean> {
  const s = await conn()
  const r = await s`
    UPDATE employe SET
      prenom = ${c.prenom}, nom = ${c.nom}, poste = ${c.poste}, email = ${c.email},
      date_embauche = ${c.dateEmbauche}, date_naissance = ${c.dateNaissance},
      idutilisateur = ${c.idutilisateur}, heures_contrat = ${c.heuresContrat},
      modifie_le = now(), modifie_par = ${par}
    WHERE id = ${id}`
  return r.count > 0
}

export async function supprimerEmploye(id: number): Promise<boolean> {
  const s = await conn()
  const r = await s`DELETE FROM employe WHERE id = ${id}`
  return r.count > 0
}

export async function lirePhoto(id: number): Promise<Buffer | null> {
  const s = await conn()
  const [row] = await s<{ photo: Buffer | null }[]>`SELECT photo FROM employe WHERE id = ${id}`
  return row?.photo && row.photo.length > 0 ? row.photo : null
}

export async function ecrirePhoto(id: number, jpeg: Buffer | null, par: string): Promise<string | null> {
  const s = await conn()
  const [row] = await s<{ photo_maj: Date | null }[]>`
    UPDATE employe SET photo = ${jpeg}, photo_maj = ${jpeg ? s`now()` : null},
      modifie_le = now(), modifie_par = ${par}
    WHERE id = ${id} RETURNING photo_maj`
  return row?.photo_maj ? row.photo_maj.toISOString() : null
}

// ── Workload versions ────────────────────────────────────

export interface VersionResume {
  id: number
  dateReleve: string
  note: string
  creePar: string
}

interface TacheRow {
  idversion: number
  nom: string
  description: string
  methode: string
  heures: string
  automatisable: TacheCharge['automatisable']
  automatise: boolean
  categorie: TacheCharge['categorie']
  indicateur: string | null
  minutes_par_unite: string | null
}

export async function listerVersions(idemploye: number): Promise<VersionResume[]> {
  const s = await conn()
  const rows = await s<{ id: number; date_releve: string; note: string; cree_par: string }[]>`
    SELECT id, to_char(date_releve, 'YYYY-MM-DD') AS date_releve, note, cree_par
    FROM charge_version WHERE idemploye = ${idemploye} ORDER BY date_releve DESC`
  return rows.map((r) => ({ id: r.id, dateReleve: r.date_releve, note: r.note, creePar: r.cree_par }))
}

/** Every version of an employee with its tasks, oldest first. */
export async function versionsCompletes(idemploye: number): Promise<Array<VersionCharge & { note: string }>> {
  const s = await conn()
  const versions = await s<{ id: number; date_releve: string; note: string }[]>`
    SELECT id, to_char(date_releve, 'YYYY-MM-DD') AS date_releve, note
    FROM charge_version WHERE idemploye = ${idemploye} ORDER BY date_releve`
  if (versions.length === 0) return []
  const taches = await s<TacheRow[]>`
    SELECT idversion, nom, description, methode, heures, automatisable, automatise, categorie,
           indicateur, minutes_par_unite
    FROM charge_tache WHERE idversion IN ${s(versions.map((v) => v.id))} ORDER BY idversion, ordre`
  const parVersion = new Map<number, TacheCharge[]>()
  for (const t of taches) {
    const list = parVersion.get(t.idversion) ?? []
    list.push({
      nom: t.nom,
      description: t.description,
      methode: t.methode,
      heures: Number(t.heures),
      automatisable: t.automatisable,
      automatise: t.automatise,
      categorie: t.categorie,
      indicateur: t.indicateur,
      minutesParUnite: t.minutes_par_unite == null ? null : Number(t.minutes_par_unite),
    })
    parVersion.set(t.idversion, list)
  }
  return versions.map((v) => ({ id: v.id, dateReleve: v.date_releve, note: v.note, taches: parVersion.get(v.id) ?? [] }))
}

/** Save a relevé: a new version, or the same date's version rewritten. */
export async function enregistrerVersion(
  idemploye: number,
  dateReleve: string,
  note: string,
  taches: TacheCharge[],
  par: string,
): Promise<number> {
  const s = await conn()
  return s.begin(async (t) => {
    const tx = t as unknown as Sql
    const [v] = await tx<{ id: number }[]>`
      INSERT INTO charge_version (idemploye, date_releve, note, cree_par)
      VALUES (${idemploye}, ${dateReleve}, ${note}, ${par})
      ON CONFLICT (idemploye, date_releve) DO UPDATE SET note = EXCLUDED.note, cree_par = EXCLUDED.cree_par, cree_le = now()
      RETURNING id`
    await tx`DELETE FROM charge_tache WHERE idversion = ${v.id}`
    let ordre = 0
    for (const x of taches) {
      await tx`
        INSERT INTO charge_tache (idversion, ordre, nom, description, methode, heures, automatisable,
                                  automatise, categorie, indicateur, minutes_par_unite)
        VALUES (${v.id}, ${ordre++}, ${x.nom}, ${x.description}, ${x.methode}, ${x.heures}, ${x.automatisable},
                ${x.automatise}, ${x.categorie}, ${x.indicateur}, ${x.minutesParUnite})`
    }
    return v.id
  }) as Promise<number>
}

export async function supprimerVersion(idemploye: number, idversion: number): Promise<boolean> {
  const s = await conn()
  const r = await s`DELETE FROM charge_version WHERE id = ${idversion} AND idemploye = ${idemploye}`
  return r.count > 0
}
