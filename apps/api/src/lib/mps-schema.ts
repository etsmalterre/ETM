// Schema changes of the `mps` PostgreSQL database, since the cutover
// (2026-09-29: WinDev and HFSQL retired, PostgreSQL is the only database, its
// schema is ours to change).
//
// Append-only, like lib/espace-client-acces.ts: never edit a shipped
// migration, add the next one. Each entry runs once, in order, inside one
// transaction with its bookkeeping row in `schema_migration`.
//
// NOT applied by the API at startup: the API's production role (mps_api_prod)
// reads and writes rows but owns no table, so it cannot ALTER them — on
// purpose. `scripts/mps-migrate.ts` applies them with the owner's connection
// (MPS_PG_OWNER_URL, or PG_CONNECTION_STRING in dev where `mps_dev` owns its
// copy), as a deploy step BEFORE the new API starts.
//
// ⚠️ A table created here must also be granted to the API role in the same
// migration (`GRANT … TO mps_api_prod` — guarded by `grantApi()` so the dev
// copy, which has no such role, runs the same text).

import type { Sql } from 'postgres'

export interface Migration {
  /** Stable, unique, never renamed — it is the bookkeeping key. */
  name: string
  sql: string
}

/** GRANT to the production API role when it exists (dev copies have none). */
export function grantApi(privileges: string, objects: string): string {
  return `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mps_api_prod') THEN
    GRANT ${privileges} ON ${objects} TO mps_api_prod;
  END IF;
END $$;`
}

export const MIGRATIONS: Migration[] = [
  {
    // User management (plan ~/.claude/plans/user-management.md): one account
    // per person with a password, station accounts for enrolled postes, the
    // record of merged per-PC rows, and the permission stores (ex
    // data/permissions.json + permissions-trm.json).
    name: '0001_comptes_utilisateurs',
    sql: `
ALTER TABLE utilisateur
  ADD COLUMN identifiant citext,
  ADD COLUMN email citext,
  ADD COLUMN type_compte text NOT NULL DEFAULT 'personne',
  ADD COLUMN est_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN actif boolean NOT NULL DEFAULT true,
  ADD COLUMN password_hash text,
  ADD COLUMN doit_changer_mdp boolean NOT NULL DEFAULT false,
  ADD COLUMN mdp_modifie_le timestamptz,
  ADD COLUMN derniere_connexion timestamptz,
  ADD CONSTRAINT utilisateur_type_compte_check CHECK (type_compte IN ('personne', 'poste'));
CREATE UNIQUE INDEX utilisateur_identifiant_key ON utilisateur (identifiant);
CREATE UNIQUE INDEX utilisateur_email_key ON utilisateur (email);

-- A per-PC row folded into its person's account: kept so an old cookie, a
-- data file or a late reference to the old id still resolves.
CREATE TABLE utilisateur_fusion (
  ancien_id bigint PRIMARY KEY,
  idutilisateur bigint NOT NULL REFERENCES utilisateur (idutilisateur),
  fusionne_le timestamptz NOT NULL DEFAULT now()
);

-- Action keys and screen-access keys (menu grants, screen hides), per app.
CREATE TABLE permission (
  idutilisateur bigint NOT NULL REFERENCES utilisateur (idutilisateur) ON DELETE CASCADE,
  app text NOT NULL CHECK (app IN ('etm', 'trm')),
  cle text NOT NULL,
  PRIMARY KEY (idutilisateur, app, cle)
);
${grantApi('SELECT, INSERT, UPDATE, DELETE', 'utilisateur_fusion, permission')}
`,
  },
  {
    // Server-side sessions (lib/sessions.ts) and the login journal
    // (lib/login-throttle.ts). A session of type 'poste' is an enrolled
    // station PC (Visitage…): no expiry, revocable like any other.
    name: '0002_sessions',
    sql: `
CREATE TABLE session (
  id text PRIMARY KEY,                -- sha256 hex of the cookie token, never the token
  idutilisateur bigint NOT NULL REFERENCES utilisateur (idutilisateur) ON DELETE CASCADE,
  voir_comme bigint REFERENCES utilisateur (idutilisateur) ON DELETE SET NULL,
  type text NOT NULL DEFAULT 'navigateur' CHECK (type IN ('navigateur', 'poste')),
  libelle text,
  cree_le timestamptz NOT NULL DEFAULT now(),
  vu_le timestamptz NOT NULL DEFAULT now(),
  expire_le timestamptz,              -- NULL = enrolled poste, no expiry
  ip text,
  user_agent text,
  revoque_le timestamptz
);
CREATE INDEX session_utilisateur ON session (idutilisateur);

CREATE TABLE connexion (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  le timestamptz NOT NULL DEFAULT now(),
  identifiant text NOT NULL,
  idutilisateur bigint,
  ip text,
  succes boolean NOT NULL,
  motif text
);
CREATE INDEX connexion_identifiant_le ON connexion (lower(identifiant), le);
CREATE INDEX connexion_ip_le ON connexion (ip, le);
${grantApi('SELECT, INSERT, UPDATE, DELETE', 'session, connexion')}
${grantApi('USAGE, SELECT', 'SEQUENCE connexion_id_seq')}
`,
  },
  {
    // LIVA #1245: journal of every poids / métrage correction on a finished
    // roll (lib/stock-fini-mesures.ts). Append-only by use: the API only
    // INSERTs and SELECTs it. `auteur` is the name at the time, kept even if
    // the account is later renamed or merged.
    name: '0003_stock_fini_mesure_journal',
    sql: `
CREATE TABLE stock_fini_mesure_journal (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idstock_fini bigint NOT NULL,
  le timestamptz NOT NULL DEFAULT now(),
  idutilisateur bigint NOT NULL,
  auteur text NOT NULL,
  poids_avant numeric(12, 2) NOT NULL,
  poids_apres numeric(12, 2) NOT NULL,
  metrage_avant numeric(12, 2) NOT NULL,
  metrage_apres numeric(12, 2) NOT NULL
);
CREATE INDEX stock_fini_mesure_journal_roll ON stock_fini_mesure_journal (idstock_fini, le);
${grantApi('SELECT, INSERT', 'stock_fini_mesure_journal')}
${grantApi('USAGE, SELECT', 'SEQUENCE stock_fini_mesure_journal_id_seq')}
`,
  },
]

export interface MigrationStatus {
  applied: string[]
  pending: string[]
  /** Applied in the database but absent from MIGRATIONS — a renamed or deleted entry. */
  unknown: string[]
}

async function ensureTable(s: Sql): Promise<void> {
  await s`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`
}

/** Read-only: works with the API role too (which may not CREATE, even
 *  « IF NOT EXISTS » — PostgreSQL checks the right before the existence). */
export async function migrationStatus(s: Sql, list: Migration[] = MIGRATIONS): Promise<MigrationStatus> {
  const [{ existe }] = await s<{ existe: boolean }[]>`SELECT to_regclass('schema_migration') IS NOT NULL AS existe`
  const rows = existe ? await s<{ name: string }[]>`SELECT name FROM schema_migration` : []
  const done = new Set(rows.map((r) => r.name))
  const known = new Set(list.map((m) => m.name))
  return {
    applied: list.filter((m) => done.has(m.name)).map((m) => m.name),
    pending: list.filter((m) => !done.has(m.name)).map((m) => m.name),
    unknown: [...done].filter((n) => !known.has(n)),
  }
}

/** Applies every pending migration, each in its own transaction. Returns the names applied. */
export async function applyMigrations(s: Sql, list: Migration[] = MIGRATIONS): Promise<string[]> {
  const names = list.map((m) => m.name)
  if (new Set(names).size !== names.length) throw new Error('mps-schema: duplicate migration name')
  await ensureTable(s)
  const applied: string[] = []
  for (const m of list) {
    const done = await s.begin(async (t) => {
      const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
      await tx`LOCK TABLE schema_migration IN EXCLUSIVE MODE`
      const [row] = await tx`SELECT 1 FROM schema_migration WHERE name = ${m.name}`
      if (row) return false
      await tx.unsafe(m.sql)
      await tx`INSERT INTO schema_migration (name) VALUES (${m.name})`
      return true
    })
    if (done) applied.push(m.name)
  }
  return applied
}
