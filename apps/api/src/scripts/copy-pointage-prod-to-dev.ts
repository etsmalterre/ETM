/**
 * Build the dev `pointage` HFSQL database from production. Production is only
 * ever READ (every statement sent to it goes through `selectOnly`).
 *
 *   node --import tsx src/scripts/copy-pointage-prod-to-dev.ts                    # dry run
 *   node --import tsx src/scripts/copy-pointage-prod-to-dev.ts --write            # build it
 *   node --import tsx src/scripts/copy-pointage-prod-to-dev.ts --write --replace  # rebuild over a previous copy
 *     … --source-env <file>   # default: ./.env.production, then the ETM main checkout's
 *
 * Run from apps/api: the local server's credentials come from .env.development.
 * Windows only — the last step copies files into the local HFSQL server's data
 * folder (auto-detected under C:\PC SOFT\Serveur HFSQL *\BDD, or HFSQL_DEV_BDD_DIR).
 *
 * The dry run reads everything, encodes every value it would write and checks
 * the column order against the table specs below, so a --write that follows a
 * clean dry run can only fail on the local server.
 *
 * Why it is not a plain `CREATE TABLE` on the dev server: through the ODBC
 * driver CREATE TABLE writes a local HFSQL Classic file in the process's cwd,
 * which the server never hears of (claude_doc/hfsql_odbc.md). An HFSQL file
 * carries its own description, so the table is built in a temp folder and its
 * .fic/.ndx/.mmo are copied into BDD\pointage\, which the server then serves.
 * Driver facts this relies on, measured on the dev server 2026-09-15:
 *  - connecting to a database with no folder fails; an EMPTY folder under BDD\
 *    is accepted as a database (the server adds its own __System);
 *  - a secondary index makes the local file unreadable from the connection that
 *    created it (« description … incompatible »), before or after the data —
 *    so the indexes are created LAST, and the copied file works;
 *  - AUTO_INCREMENT keeps explicit ids and continues from the highest;
 *  - multi-row `INSERT … VALUES (…),(…)` works;
 *  - text on disk is Windows-1252 (the messages hold € and ’) → sqlTextCp1252;
 *  - `CONVERT(memo USING 'UTF-8')` over a whole table crashes the driver
 *    (« Error allocating or reallocating memory ») — memos are read raw and
 *    repaired row by row through fixEncoding;
 *  - the server keeps a database folder open once it has served it, so it
 *    cannot be deleted while the server runs: --replace DROPs the tables.
 *  - ⚠️ the dev `mps` database has its OWN old lst_horaire / lst_salarie /
 *    hors_prod / pointage files, so the build connects to `pointage` itself,
 *    never to MPS (a CREATE there collides).
 *
 * Nullability is not declared: the prod catalog says NOT NULL for the
 * lst_pointage datetimes, and yet they hold NULL — the legacy never enforced it.
 */
import dotenv from 'dotenv'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOdbcClient, type OdbcClient } from '../lib/hfsql.js'
import { POINTAGE_DATABASE, withDatabase } from '../lib/hfsql-pointage.js'
import { sqlTextCp1252 } from '../lib/sql-cp1252.js'

dotenv.config({ path: '.env.development' })

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const REPLACE = args.includes('--replace')
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

// ── Table specs: runtime column order of prod (`SELECT *`), types from
//    Pointage.xdd + the prod ODBC catalog, keys from Pointage.xdd. ──

type ColType = 'id' | 'id64' | 'int' | 'tinyint' | 'bigint' | 'real' | 'date' | 'datetime' | 'memo' | `char${number}`
interface Col { name: string; type: ColType }
interface Index { name: string; cols: string[]; unique?: boolean }
interface TableSpec { name: string; cols: Col[]; indexes: Index[] }

const c = (name: string, type: ColType): Col => ({ name, type })
const heures = (type: 'int' | 'datetime') =>
  ['debut', 'debut_pause1', 'fin_pause1', 'debut_pause2', 'fin_pause2', 'fin'].map((n) => c(n, type))
const jours = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
  .flatMap((j) => [c(`${j}_type`, 'char1'), c(`${j}_total`, 'int')])

const TABLES: TableSpec[] = [
  {
    name: 'lst_salarie',
    cols: [c('id', 'id'), c('nom', 'char50'), c('prenom', 'char50'), c('login', 'char3'), c('is_deleted', 'tinyint'), c('id_mps', 'int'), c('useInRatio', 'tinyint')],
    indexes: [{ name: 'login', cols: ['login'], unique: true }, { name: 'is_deleted', cols: ['is_deleted'] }],
  },
  {
    name: 'lst_horaire',
    cols: [c('id', 'id'), c('id_salarie', 'int'), c('DATE', 'date'), ...heures('int'), c('is_deleted', 'tinyint')],
    indexes: [{ name: 'id_salarie', cols: ['id_salarie'] }, { name: 'sal_fin_del', cols: ['id_salarie', 'fin', 'is_deleted'] }],
  },
  {
    name: 'lst_pointage',
    cols: [c('id', 'id'), c('id_salarie', 'int'), c('DATE', 'date'), ...heures('datetime'), c('is_deleted', 'tinyint')],
    indexes: [{ name: 'id_salarie', cols: ['id_salarie'] }, { name: 'sal_fin_del', cols: ['id_salarie', 'fin', 'is_deleted'] }],
  },
  {
    name: 'hors_prod',
    cols: [c('id', 'id'), c('id_salarie', 'int'), c('DATE', 'date'), c('duree', 'real')],
    indexes: [{ name: 'id_salarie', cols: ['id_salarie'] }, { name: 'date', cols: ['DATE'] }, { name: 'id_salariedate', cols: ['id_salarie', 'DATE'], unique: true }],
  },
  {
    name: 'lst_message',
    cols: [c('id', 'id'), c('id_salarie', 'int'), c('MESSAGE', 'memo'), c('date_fin', 'date'), c('is_deleted', 'tinyint')],
    indexes: [{ name: 'id_salarie', cols: ['id_salarie'] }],
  },
  {
    name: 'lst_lissage',
    cols: [c('id', 'id'), c('id_salarie', 'int'), c('annee', 'int'), c('num_semaine', 'int'), ...jours, c('cumul_semaine', 'int'), c('is_deleted', 'tinyint')],
    indexes: [{ name: 'id_salarie', cols: ['id_salarie'] }, { name: 'sal_an_sem_del', cols: ['id_salarie', 'annee', 'num_semaine', 'is_deleted'] }],
  },
  {
    name: 'lst_prev',
    cols: [c('id', 'id'), c('id_salarie', 'int'), c('annee', 'int'), c('num_semaine', 'int'), c('prev', 'int'), c('commentaire', 'memo'), c('is_deleted', 'tinyint')],
    indexes: [{ name: 'id_salarie', cols: ['id_salarie'] }, { name: 'del_sal_an_sem', cols: ['is_deleted', 'id_salarie', 'annee', 'num_semaine'] }],
  },
  {
    name: 'lst_info_sal_annee',
    cols: [c('id', 'id'), c('id_salarie', 'int'), c('annee', 'int'), c('info', 'int'), c('commentaire', 'memo'), c('is_deleted', 'tinyint')],
    indexes: [{ name: 'id_salarie', cols: ['id_salarie'] }, { name: 'del_sal_an', cols: ['is_deleted', 'id_salarie', 'annee'] }],
  },
  {
    // The pointage database's own `pointage` table: dead since 2025-10 (the
    // journal the TRS read is mps.pointage). Copied for fidelity, never written.
    name: 'pointage',
    cols: [c('IDpointage', 'id64'), c('IDbonnetier', 'bigint'), c('DATE', 'datetime'), c('en_poste', 'tinyint')],
    indexes: [{ name: 'idbonnetier', cols: ['IDbonnetier'] }],
  },
]

const isText = (col: Col) => col.type === 'memo' || col.type.startsWith('char')

function ddlType(col: Col): string {
  switch (col.type) {
    case 'id': return 'INTEGER AUTO_INCREMENT PRIMARY KEY'
    case 'id64': return 'BIGINT AUTO_INCREMENT PRIMARY KEY'
    case 'int': return 'INTEGER'
    case 'tinyint': return 'TINYINT'
    case 'bigint': return 'BIGINT'
    case 'real': return 'REAL'
    case 'date': return 'DATE'
    case 'datetime': return 'DATETIME'
    case 'memo': return 'TEXT'
    default: return `VARCHAR(${col.type.slice(4)})`
  }
}

/** The SQL literal of one value; throws with the row and column on anything it would alter. */
function literal(table: string, id: unknown, col: Col, v: unknown): string {
  const fail = (why: string) => new Error(`${table} id=${String(id)} ${col.name}: ${why}`)
  if (isText(col)) {
    try {
      return sqlTextCp1252(v == null ? '' : String(v))
    } catch (e) {
      throw fail((e as Error).message)
    }
  }
  if (v === null || v === undefined) return 'NULL'
  switch (col.type) {
    case 'real': {
      const n = Number(v)
      if (!Number.isFinite(n)) throw fail(`not a number (${String(v)})`)
      return String(n)
    }
    case 'date': {
      const s = String(v)
      if (!/^\d{8}$/.test(s)) throw fail(`unexpected DATE shape « ${s} »`)
      return `'${s}'`
    }
    case 'datetime': {
      const s = String(v)
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,3})?$/.test(s)) throw fail(`unexpected DATETIME shape « ${s} »`)
      return `'${s}'`
    }
    default: {
      const n = Number(v)
      if (!Number.isInteger(n)) throw fail(`not an integer (${String(v)})`)
      return String(n)
    }
  }
}

/** A row as comparable values in spec order: what "copied identically" means. */
function normalise(spec: TableSpec, row: Record<string, unknown>): unknown[] {
  return spec.cols.map((col) => {
    const v = row[col.name]
    if (isText(col)) return v == null ? '' : String(v)
    if (v === null || v === undefined) return null
    if (col.type === 'real') return Math.fround(Number(v))
    if (col.type === 'date' || col.type === 'datetime') return String(v)
    return Number(v)
  })
}

// ── Connections and guards ──

const mask = (cs: string) => cs.replace(/PWD=[^;]*/i, 'PWD=***')
const isLocal = (cs: string) => /Server Name\s*=\s*(localhost|127\.0\.0\.1)\s*(;|$)/i.test(cs)

function sourceConnection(): { cs: string; from: string } {
  const here = dirname(fileURLToPath(import.meta.url))
  const explicit = flag('source-env')
  const candidates = explicit
    ? [resolve(explicit)]
    : [resolve('.env.production'), resolve(here, '../../../../../ETM/apps/api/.env.production')]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const m = /^HFSQL_CONNECTION_STRING=(.*)$/m.exec(readFileSync(file, 'utf8'))
    if (m) return { cs: withDatabase(m[1].trim().replace(/^['"]|['"]$/g, ''), POINTAGE_DATABASE), from: file }
  }
  throw new Error(`no HFSQL_CONNECTION_STRING found in ${candidates.join(' / ')} — pass --source-env <.env.production>`)
}

function findBddDir(): string {
  if (process.env.HFSQL_DEV_BDD_DIR) return process.env.HFSQL_DEV_BDD_DIR
  const root = 'C:/PC SOFT'
  const found = existsSync(root)
    ? readdirSync(root).filter((d) => /^Serveur HFSQL/i.test(d)).map((d) => join(root, d, 'BDD')).filter((d) => existsSync(join(d, 'mps')))
    : []
  if (found.length !== 1) {
    throw new Error(`local HFSQL data folder not found (${found.length} candidates under ${root}) — set HFSQL_DEV_BDD_DIR`)
  }
  return found[0]
}

/** Every statement sent to production goes through here. */
function selectOnly(source: OdbcClient) {
  return async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`refusing a non-SELECT against production: ${sql.slice(0, 60)}`)
    return source.query<T>(sql)
  }
}

/** Rows of one table, accents repaired, keyed by the spec's column names. */
async function readTable(
  label: string,
  select: <T = Record<string, unknown>>(sql: string) => Promise<T[]>,
  client: OdbcClient,
  spec: TableSpec,
): Promise<Record<string, unknown>[]> {
  const pk = spec.cols[0].name
  const raw = await select<Record<string, unknown>>(`SELECT * FROM ${spec.name} ORDER BY ${pk}`)
  if (raw.length === 0) return []
  const keys = Object.keys(raw[0])
  const expected = spec.cols.map((col) => col.name.toLowerCase())
  if (keys.map((k) => k.toLowerCase()).join(',') !== expected.join(',')) {
    throw new Error(`${label} ${spec.name}: column drift\n  expected ${expected.join(', ')}\n  got      ${keys.join(', ')}`)
  }
  const rows = raw.map((r) => Object.fromEntries(spec.cols.map((col, i) => [col.name, r[keys[i]]])))
  const textCols = spec.cols.filter(isText).map((col) => col.name)
  return textCols.length ? client.fixEncoding(rows, spec.name, pk, textCols) : rows
}

function insertStatements(spec: TableSpec, rows: Record<string, unknown>[]): string[] {
  const pk = spec.cols[0].name
  const statements: string[] = []
  let tuples: string[] = []
  let size = 0
  const flush = () => {
    if (tuples.length) statements.push(`INSERT INTO ${spec.name} VALUES ${tuples.join(', ')}`)
    tuples = []
    size = 0
  }
  for (const row of rows) {
    const tuple = `(${spec.cols.map((col) => literal(spec.name, row[pk], col, row[col.name])).join(', ')})`
    if (tuples.length >= 250 || size + tuple.length > 400_000) flush()
    tuples.push(tuple)
    size += tuple.length
  }
  flush()
  return statements
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows only: the build ends by copying files into the local HFSQL data folder')

  const source = sourceConnection()
  if (isLocal(source.cs)) throw new Error(`the source is the local server (${source.from}) — nothing to copy from`)
  const mainDev = process.env.HFSQL_CONNECTION_STRING ?? ''
  if (!isLocal(mainDev)) throw new Error(`REFUS : .env.development HFSQL_CONNECTION_STRING is not localhost (${mask(mainDev) || 'vide'})`)
  const targetCs = withDatabase(mainDev, POINTAGE_DATABASE)
  const bdd = findBddDir()
  const targetDir = join(bdd, POINTAGE_DATABASE)

  console.log(WRITE ? '── ÉCRITURE (base de dev seulement) ──' : '── DRY RUN (rien n’est écrit ; --write pour construire) ──')
  console.log(`source : ${mask(source.cs)}\n         (${source.from})`)
  console.log(`cible  : ${mask(targetCs)}\n         ${targetDir}${existsSync(targetDir) ? '' : ' (absent, sera créé)'}`)

  const src = createOdbcClient(source.cs)
  const select = selectOnly(src)
  const data = new Map<string, Record<string, unknown>[]>()
  const plan = new Map<string, string[]>()
  try {
    for (const spec of TABLES) {
      const t0 = Date.now()
      const rows = await readTable('source', select, src, spec)
      const statements = insertStatements(spec, rows) // encodes every value: a dry run catches what --write would refuse
      data.set(spec.name, rows)
      plan.set(spec.name, statements)
      const maxId = rows.length ? Number(rows[rows.length - 1][spec.cols[0].name]) : 0
      console.log(`  ${spec.name.padEnd(20)} ${String(rows.length).padStart(6)} lignes  id max ${String(maxId).padStart(6)}  ${statements.length} INSERT  (${Date.now() - t0} ms)`)
    }
  } finally {
    await src.closeConnection()
  }

  const tgt = createOdbcClient(targetCs)
  let existing: string[] = []
  if (existsSync(targetDir)) {
    const conn = await tgt.getConnection()
    const listed = (await conn.tables(null, null, null, 'TABLE')) as Array<{ TABLE_NAME: string }>
    const ours = new Set(TABLES.map((t) => t.name.toLowerCase()))
    existing = listed.map((t) => t.TABLE_NAME).filter((n) => ours.has(n.toLowerCase()))
  }
  if (existing.length) console.log(`  déjà présentes en dev : ${existing.join(', ')}`)

  if (!WRITE) {
    await tgt.closeConnection()
    console.log(existing.length && !REPLACE ? '\nUne copie existe : --write --replace pour la reconstruire.' : '\nDry run OK.')
    return
  }
  if (existing.length && !REPLACE) {
    await tgt.closeConnection()
    throw new Error(`the dev pointage database already has ${existing.join(', ')} — add --replace to rebuild it`)
  }

  mkdirSync(targetDir, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'pointage-copy-'))
  const cwd = process.cwd()
  try {
    for (const name of existing) {
      try {
        await tgt.query(`DROP TABLE ${name}`)
      } catch (e) {
        throw new Error(`DROP TABLE ${name} failed — stop the dev APIs holding the pointage database, then retry: ${(e as Error).message}`)
      }
    }
    // CREATE TABLE lands in the process's cwd (see header) — so the build runs in `work`.
    process.chdir(work)
    for (const spec of TABLES) {
      const t0 = Date.now()
      await tgt.query(`CREATE TABLE ${spec.name} (${spec.cols.map((col) => `${col.name} ${ddlType(col)}`).join(', ')})`)
      for (const statement of plan.get(spec.name)!) await tgt.query(statement)
      // Indexes LAST: after one exists this connection can no longer read the file.
      for (const idx of spec.indexes) {
        await tgt.query(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${spec.name}_${idx.name} ON ${spec.name} (${idx.cols.join(', ')})`)
      }
      console.log(`  construit ${spec.name} (${Date.now() - t0} ms)`)
    }
    await tgt.closeConnection()
    process.chdir(cwd)

    for (const file of readdirSync(work)) {
      if (existsSync(join(targetDir, file))) throw new Error(`${join(targetDir, file)} still exists after DROP — nothing was copied`)
    }
    for (const file of readdirSync(work)) copyFileSync(join(work, file), join(targetDir, file))
    console.log(`  fichiers copiés dans ${targetDir}`)
  } finally {
    process.chdir(cwd)
    await tgt.closeConnection()
    rmSync(work, { recursive: true, force: true })
  }

  // A fresh connection: the server enumerates a database's files when a connection opens.
  const check = createOdbcClient(targetCs)
  let bad = 0
  try {
    for (const spec of TABLES) {
      const rows = await readTable('dev', (sql) => check.query(sql), check, spec)
      const want = data.get(spec.name)!
      const byId = new Map(rows.map((r) => [Number(r[spec.cols[0].name]), r]))
      const diffs: string[] = []
      if (rows.length !== want.length) diffs.push(`${rows.length} lignes au lieu de ${want.length}`)
      for (const w of want) {
        const id = Number(w[spec.cols[0].name])
        const got = byId.get(id)
        if (!got) { diffs.push(`id ${id} absent`); continue }
        const a = normalise(spec, w)
        const b = normalise(spec, got)
        const cols = spec.cols.filter((_, i) => a[i] !== b[i]).map((col) => col.name)
        if (cols.length) diffs.push(`id ${id} : ${cols.join(', ')}`)
      }
      if (diffs.length) bad++
      console.log(`  vérifié ${spec.name.padEnd(20)} ${diffs.length ? `✗ ${diffs.length} écarts — ${diffs.slice(0, 3).join(' ; ')}` : `✓ ${rows.length} lignes identiques`}`)
    }
  } finally {
    await check.closeConnection()
  }
  if (bad) throw new Error(`${bad} table(s) differ from production`)
  console.log('\nBase de dev `pointage` construite. Redémarrer une API de dev déjà lancée pour qu’elle la voie.')
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\nÉCHEC : ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
