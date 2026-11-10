// Put back the délais that were brought EARLIER on sous-traitant lines
// (Vincent 2026-11-10, lib/report-delai-sst.ts: a délai is never advanced, the
// engagement stays true, a delivery ahead of it is read from the reception).
//
//   npx tsx src/scripts/delai-sst-avances.ts [--env production] [--write] [--sauf 9080,9083]
//
// Dry run by default (read-only transaction). Source: `journal_activite.changements`
// (filled since 2026-10-14): every save of a sst line whose date_livraison went
// from A to an earlier B. For each line, its LAST such save; the line gets A
// back when it still holds B (a later save moved it again = a person's later
// decision, left alone) and is not finished. Skipped and listed:
//   - A more than 6 months after B (a year typo corrected: 16/11/2027 → 2026);
//   - the lines named by --sauf (line ids).
// No fact is written: the advance was never recorded, the line just gets its
// délai back.
import { config } from 'dotenv'
import { resolve } from 'node:path'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const env = arg('env') ?? 'development'
const write = process.argv.includes('--write')
const sauf = new Set((arg('sauf') ?? '').split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0))
config({ path: env === 'production' ? resolve(process.cwd(), '../../../ETM/apps/api/.env.production') : resolve(process.cwd(), '.env.development') })
if (!write) process.env.PGOPTIONS = '-c default_transaction_read_only=on'

const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const sql = mpsPg()

const ymd = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(0, 8)
const jj = (d: string) => `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`

const rows = await sql<{ le: Date; idutilisateur: number | null; chemin: string; a: string | null; b: string | null }[]>`
  SELECT j.le, j.idutilisateur, j.chemin,
         j.changements->'date_livraison'->>0 AS a, j.changements->'date_livraison'->>1 AS b
  FROM journal_activite j
  WHERE j.changements ? 'date_livraison' AND j.chemin ~ '^/api/commandes-sous-traitant/lignes/[0-9]+$'
  ORDER BY j.le`

const derniere = new Map<number, { le: Date; a: string; b: string; par: number }>()
for (const r of rows) {
  const ligne = Number(/(\d+)$/.exec(r.chemin)![1])
  const a = ymd(r.a)
  const b = ymd(r.b)
  // Any later save of the line's date replaces what we know of it.
  if (a && b && b < a) derniere.set(ligne, { le: r.le, a, b, par: Number(r.idutilisateur) || 0 })
  else if (b && derniere.has(ligne)) derniere.delete(ligne)
}

interface Remise { ligne: number; cmd: number; a: string; b: string; le: Date; par: string }
const remises: Remise[] = []
const ignorees: string[] = []
for (const [ligne, x] of derniere) {
  const [l] = await sql<{ cmd: number; liv: string | null; sstatut: string | null }[]>`
    SELECT idcommande_sous_traitant AS cmd, to_char(date_livraison, 'YYYYMMDD') AS liv, sstatut
      FROM ligne_commande_sous_traitant WHERE idligne_commande_sous_traitant = ${ligne}`
  const [u] = x.par ? await sql<{ n: string }[]>`SELECT trim(concat(prenom, ' ', nom)) AS n FROM utilisateur WHERE idutilisateur = ${x.par}` : []
  const qui = u?.n || '?'
  const desc = `cde ${l?.cmd ?? '?'} ligne ${ligne}  ${jj(x.a)} → ${jj(x.b)} le ${x.le.toISOString().slice(0, 10)} (${qui})`
  if (!l) { ignorees.push(`${desc} — ligne supprimée`); continue }
  if ((l.liv ?? '') !== x.b) { ignorees.push(`${desc} — la ligne porte maintenant ${l.liv ? jj(l.liv) : 'aucune date'}`); continue }
  if ((l.sstatut ?? '').trim().startsWith('Termin')) { ignorees.push(`${desc} — ligne terminée`); continue }
  if (sauf.has(ligne)) { ignorees.push(`${desc} — exclue (--sauf)`); continue }
  const ecartJours = (Date.UTC(+x.a.slice(0, 4), +x.a.slice(4, 6) - 1, +x.a.slice(6, 8)) - Date.UTC(+x.b.slice(0, 4), +x.b.slice(4, 6) - 1, +x.b.slice(6, 8))) / 86_400_000
  if (ecartJours > 183) { ignorees.push(`${desc} — faute de frappe probable (plus de 6 mois)`); continue }
  remises.push({ ligne, cmd: Number(l.cmd), a: x.a, b: x.b, le: x.le, par: qui })
}

for (const r of remises) console.log(`cde ${r.cmd} ligne ${r.ligne}  ${jj(r.b)} → remis au ${jj(r.a)}  (avancé le ${r.le.toISOString().slice(0, 10)} par ${r.par})`)
if (ignorees.length) { console.log('\nLaissées telles quelles :'); for (const i of ignorees) console.log(`  ${i}`) }
console.log(`\n${remises.length} délai(s) à remettre, ${ignorees.length} laissé(s).`)

if (write && remises.length) {
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql // postgres.js typing: TransactionSql loses its call signatures
    for (const r of remises) {
      const iso = `${r.a.slice(0, 4)}-${r.a.slice(4, 6)}-${r.a.slice(6, 8)}`
      await tx`UPDATE ligne_commande_sous_traitant SET date_livraison = ${iso}::date
                WHERE idligne_commande_sous_traitant = ${r.ligne} AND to_char(date_livraison, 'YYYYMMDD') = ${r.b}`
    }
  })
  console.log('Écrit.')
} else if (!write) console.log('Dry run — re-run with --write to apply.')
await closeMpsPg()
