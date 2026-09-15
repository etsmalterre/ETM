/**
 * Log prefix naming the database when it is not the default `mps` one, so a
 * `pointage` connection error never reads as an outage of the main database.
 *
 * Its own file because the Linux bridge must not import hfsql.ts at runtime
 * (that module loads the `odbc` native package, which only the Windows path uses).
 */
export function hfsqlLogTag(connectionString: string, base = 'hfsql'): string {
  const db = /(?:^|;)\s*Database\s*=\s*([^;]*)/i.exec(connectionString)?.[1]?.trim()
  return !db || /^mps$/i.test(db) ? `[${base}]` : `[${base}:${db}]`
}
