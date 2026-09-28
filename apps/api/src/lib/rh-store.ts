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
import { hashEvenement, sha256, type EvenementScelle, type MaillonChaine } from './rh-suivi.js'

type Sql = ReturnType<typeof postgres>

let sql: Sql | null = null
let ready: Promise<void> | null = null

export class RhIndisponible extends Error {
  constructor() { super('rh: RH_PG_URL not set') }
}

// Append-only: never edit a shipped migration, add the next.
/** Exported for the dev scripts only. */
export const MIGRATIONS: string[] = [
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
  // Slot 2 — estimated tasks: minutes × a typed weekly volume, with a free unit.
  // Applied to prod and rh_dev on 2026-09-28, before Suivi landed: keep it here.
  `ALTER TABLE charge_tache ADD COLUMN IF NOT EXISTS volume_saisi numeric(10,2);
   ALTER TABLE charge_tache ADD COLUMN IF NOT EXISTS unite text NOT NULL DEFAULT '';`,
  // Slot 3 — Suivi (lib/rh-suivi.ts): append-only evidence. The trigger refuses any
  // UPDATE or DELETE, whoever connects — a correction is a new entry. The FK to
  // employe is RESTRICT: an employee with a suivi cannot be deleted.
  // Idempotent on purpose: feat/rh-analysis took slot 2 (prod and rh_dev), and
  // rh_dev already holds these tables.
  `CREATE TABLE IF NOT EXISTS evenement (
     id               integer PRIMARY KEY,
     idemploye        integer NOT NULL REFERENCES employe (id) ON DELETE RESTRICT,
     date_evenement   date NOT NULL,
     type             text NOT NULL,
     titre            text NOT NULL,
     presents         text NOT NULL DEFAULT '',
     contenu          text NOT NULL,
     rectifie         integer REFERENCES evenement (id),
     cree_le          timestamptz NOT NULL,
     cree_par         text NOT NULL,
     hash             text NOT NULL,
     hash_precedent   text
   );
   CREATE SEQUENCE IF NOT EXISTS evenement_id_seq OWNED BY evenement.id;
   CREATE INDEX IF NOT EXISTS evenement_employe ON evenement (idemploye);
   CREATE TABLE IF NOT EXISTS evenement_piece (
     id            serial PRIMARY KEY,
     idevenement   integer NOT NULL REFERENCES evenement (id) ON DELETE RESTRICT,
     ordre         integer NOT NULL,
     nom           text NOT NULL,
     type_mime     text NOT NULL,
     taille        integer NOT NULL,
     sha256        text NOT NULL,
     contenu       bytea NOT NULL
   );
   CREATE INDEX IF NOT EXISTS evenement_piece_evenement ON evenement_piece (idevenement);
   CREATE OR REPLACE FUNCTION rh_ajout_seul() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'rh: la table % est en ajout seul', TG_TABLE_NAME;
   END $$;
   CREATE OR REPLACE TRIGGER evenement_ajout_seul BEFORE UPDATE OR DELETE ON evenement
     FOR EACH ROW EXECUTE FUNCTION rh_ajout_seul();
   CREATE OR REPLACE TRIGGER evenement_piece_ajout_seul BEFORE UPDATE OR DELETE ON evenement_piece
     FOR EACH ROW EXECUTE FUNCTION rh_ajout_seul();`,
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
  volume_saisi: string | null
  unite: string
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
           indicateur, minutes_par_unite, volume_saisi, unite
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
      volumeSaisi: t.volume_saisi == null ? null : Number(t.volume_saisi),
      unite: t.unite,
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
                                  automatise, categorie, indicateur, minutes_par_unite, volume_saisi, unite)
        VALUES (${v.id}, ${ordre++}, ${x.nom}, ${x.description}, ${x.methode}, ${x.heures}, ${x.automatisable},
                ${x.automatise}, ${x.categorie}, ${x.indicateur}, ${x.minutesParUnite}, ${x.volumeSaisi}, ${x.unite})`
    }
    return v.id
  }) as Promise<number>
}

export async function supprimerVersion(idemploye: number, idversion: number): Promise<boolean> {
  const s = await conn()
  const r = await s`DELETE FROM charge_version WHERE id = ${idversion} AND idemploye = ${idemploye}`
  return r.count > 0
}

// ── Suivi (append-only, lib/rh-suivi.ts) ─────────────────

export interface PieceJointe {
  id: number
  nom: string
  typeMime: string
  taille: number
  sha256: string
}

export interface Evenement extends Omit<EvenementScelle, 'pieces'> {
  hash: string
  pieces: PieceJointe[]
  /** Ids of the rectificatifs that point at this entry. */
  rectifiePar: number[]
}

export interface NouvelEvenement {
  dateEvenement: string
  type: string
  titre: string
  presents: string
  contenu: string
  rectifie: number | null
}

export interface NouvellePiece {
  nom: string
  typeMime: string
  contenu: Buffer
}

interface EvenementRow {
  id: number
  idemploye: number
  date_evenement: string
  type: string
  titre: string
  presents: string
  contenu: string
  rectifie: number | null
  cree_le: Date
  cree_par: string
  hash: string
  hash_precedent: string | null
}

const COLONNES_EVENEMENT = `id, idemploye, to_char(date_evenement, 'YYYY-MM-DD') AS date_evenement, type, titre,
  presents, contenu, rectifie, cree_le, cree_par, hash, hash_precedent`

function scelle(r: EvenementRow, pieces: Array<{ nom: string; sha256: string }>): EvenementScelle {
  return {
    id: r.id,
    idemploye: r.idemploye,
    dateEvenement: r.date_evenement,
    type: r.type,
    titre: r.titre,
    presents: r.presents,
    contenu: r.contenu,
    rectifie: r.rectifie,
    creeLe: r.cree_le.toISOString(),
    creePar: r.cree_par,
    pieces,
  }
}

async function piecesDe(s: Sql, ids: number[]): Promise<Map<number, PieceJointe[]>> {
  const map = new Map<number, PieceJointe[]>()
  if (ids.length === 0) return map
  const rows = await s<Array<{ id: number; idevenement: number; nom: string; type_mime: string; taille: number; sha256: string }>>`
    SELECT id, idevenement, nom, type_mime, taille, sha256 FROM evenement_piece
    WHERE idevenement IN ${s(ids)} ORDER BY idevenement, ordre`
  for (const r of rows) {
    const list = map.get(r.idevenement) ?? []
    list.push({ id: r.id, nom: r.nom, typeMime: r.type_mime, taille: r.taille, sha256: r.sha256 })
    map.set(r.idevenement, list)
  }
  return map
}

/** An employee's suivi, newest event first. */
export async function listerEvenements(idemploye: number): Promise<Evenement[]> {
  const s = await conn()
  const rows = await s.unsafe<EvenementRow[]>(
    `SELECT ${COLONNES_EVENEMENT} FROM evenement WHERE idemploye = $1 ORDER BY date_evenement DESC, id DESC`,
    [idemploye],
  )
  const pieces = await piecesDe(s, rows.map((r) => r.id))
  return rows.map((r) => {
    const p = pieces.get(r.id) ?? []
    return {
      ...scelle(r, p),
      hash: r.hash,
      pieces: p,
      rectifiePar: rows.filter((x) => x.rectifie === r.id).map((x) => x.id),
    }
  })
}

export async function compterEvenements(idemploye: number): Promise<number> {
  const s = await conn()
  const [row] = await s<{ n: string }[]>`SELECT count(*) AS n FROM evenement WHERE idemploye = ${idemploye}`
  return Number(row.n)
}

export class RectificatifInvalide extends Error {
  constructor() { super('rh: rectifie hors de ce dossier') }
}

/** Seal and store an entry with its attachments, in one transaction. The
 *  table lock serialises writers so the chain never forks. */
export async function ajouterEvenement(
  idemploye: number,
  e: NouvelEvenement,
  pieces: NouvellePiece[],
  par: string,
): Promise<{ id: number; hash: string }> {
  const s = await conn()
  return s.begin(async (t) => {
    const tx = t as unknown as Sql
    await tx`LOCK TABLE evenement IN EXCLUSIVE MODE`
    if (e.rectifie !== null) {
      const [orig] = await tx<{ idemploye: number }[]>`SELECT idemploye FROM evenement WHERE id = ${e.rectifie}`
      if (!orig || orig.idemploye !== idemploye) throw new RectificatifInvalide()
    }
    const [dernier] = await tx<{ hash: string }[]>`SELECT hash FROM evenement ORDER BY id DESC LIMIT 1`
    const [{ id }] = await tx<{ id: number }[]>`SELECT nextval('evenement_id_seq')::int AS id`
    const creeLe = new Date()
    const empreintes = pieces.map((p) => ({ ...p, sha256: sha256(p.contenu) }))
    const precedent = dernier?.hash ?? null
    const hash = hashEvenement({
      id,
      idemploye,
      ...e,
      creeLe: creeLe.toISOString(),
      creePar: par,
      pieces: empreintes.map((p) => ({ nom: p.nom, sha256: p.sha256 })),
    }, precedent)
    await tx`
      INSERT INTO evenement (id, idemploye, date_evenement, type, titre, presents, contenu, rectifie,
                             cree_le, cree_par, hash, hash_precedent)
      VALUES (${id}, ${idemploye}, ${e.dateEvenement}, ${e.type}, ${e.titre}, ${e.presents}, ${e.contenu},
              ${e.rectifie}, ${creeLe}, ${par}, ${hash}, ${precedent})`
    let ordre = 0
    for (const p of empreintes) {
      await tx`
        INSERT INTO evenement_piece (idevenement, ordre, nom, type_mime, taille, sha256, contenu)
        VALUES (${id}, ${ordre++}, ${p.nom}, ${p.typeMime}, ${p.contenu.length}, ${p.sha256}, ${p.contenu})`
    }
    return { id, hash }
  }) as Promise<{ id: number; hash: string }>
}

export async function lirePiece(
  idemploye: number,
  idevenement: number,
  idpiece: number,
): Promise<{ nom: string; typeMime: string; contenu: Buffer } | null> {
  const s = await conn()
  const [row] = await s<Array<{ nom: string; type_mime: string; contenu: Buffer }>>`
    SELECT p.nom, p.type_mime, p.contenu FROM evenement_piece p
    JOIN evenement e ON e.id = p.idevenement
    WHERE p.id = ${idpiece} AND p.idevenement = ${idevenement} AND e.idemploye = ${idemploye}`
  return row ? { nom: row.nom, typeMime: row.type_mime, contenu: row.contenu } : null
}

/** The whole chain, oldest first. Every attachment's bytes are re-hashed in
 *  the database, so a swapped file is caught even when its row kept the old
 *  sha256. */
export async function chaineComplete(): Promise<{ maillons: MaillonChaine[]; piecesAlterees: number[] }> {
  const s = await conn()
  const rows = await s.unsafe<EvenementRow[]>(`SELECT ${COLONNES_EVENEMENT} FROM evenement ORDER BY id`)
  const pieces = await s<Array<{ idevenement: number; nom: string; sha256: string; reel: string }>>`
    SELECT idevenement, nom, sha256, encode(sha256(contenu), 'hex') AS reel
    FROM evenement_piece ORDER BY idevenement, ordre`
  const parEvt = new Map<number, Array<{ nom: string; sha256: string }>>()
  const piecesAlterees = new Set<number>()
  for (const p of pieces) {
    if (p.reel !== p.sha256) piecesAlterees.add(p.idevenement)
    const list = parEvt.get(p.idevenement) ?? []
    list.push({ nom: p.nom, sha256: p.sha256 })
    parEvt.set(p.idevenement, list)
  }
  return {
    maillons: rows.map((r) => ({ evenement: scelle(r, parEvt.get(r.id) ?? []), hash: r.hash, hashPrecedent: r.hash_precedent })),
    piecesAlterees: [...piecesAlterees],
  }
}
