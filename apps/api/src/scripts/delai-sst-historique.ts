// The délais received before ETM recorded them (lib/delai-sst.ts, LIVA #1314).
//
//   npx tsx src/scripts/delai-sst-historique.ts [--env production] [--write]
//
// Dry run by default (read-only transaction). Source: `journal_activite.changements`
// (migration 0024, filled since 2026-10-14) — every save that moved a sst line
// from Attente_Delai to another status, with its time, its author and the date
// given. One `delai_sst_evenement` row of type 'delai_recu', origine
// 'historique', per line that has none yet. Nothing is guessed before 2026-10-14:
// those orders stay « non mesurées » in the Qualité de service.
// Relances need no history: a Point sent is read from point_sst itself.
import { config } from 'dotenv'
import { resolve } from 'node:path'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const env = arg('env') ?? 'development'
const write = process.argv.includes('--write')
config({ path: env === 'production' ? resolve(process.cwd(), '../../../ETM/apps/api/.env.production') : resolve(process.cwd(), '.env.development') })
if (!write) process.env.PGOPTIONS = '-c default_transaction_read_only=on'

const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const sql = mpsPg()

const rows = await sql<{ le: Date; idutilisateur: number | null; chemin: string; avant: string | null; apres: string | null; delai: string | null }[]>`
  SELECT j.le, j.idutilisateur, j.chemin,
         j.changements->'sstatut'->>0 AS avant, j.changements->'sstatut'->>1 AS apres,
         j.changements->'date_livraison'->>1 AS delai
  FROM journal_activite j
  WHERE j.changements ? 'sstatut' AND j.chemin ~ '^/api/commandes-sous-traitant/lignes/[0-9]+$'
  ORDER BY j.le`

// Before migration 0030 (a production dry run ahead of the deploy): nothing recorded yet.
const [{ table }] = await sql<{ table: boolean }[]>`SELECT to_regclass('delai_sst_evenement') IS NOT NULL AS table`
const deja = new Set(table ? (await sql<{ ligne: number }[]>`
  SELECT DISTINCT idligne_commande_sous_traitant AS ligne FROM delai_sst_evenement WHERE type = 'delai_recu'`).map((r) => Number(r.ligne)) : [])

interface Ajout { ligne: number; cmd: number; le: Date; delai: string | null; par_id: number; par: string | null }
const ajouts: Ajout[] = []
const vues = new Set<number>()
for (const r of rows) {
  if ((r.avant ?? '').trim() !== 'Attente_Delai' || ['Attente_Delai', 'Non_Envoye'].includes((r.apres ?? '').trim())) continue
  const ligne = Number(/(\d+)$/.exec(r.chemin)![1])
  if (deja.has(ligne) || vues.has(ligne)) continue
  vues.add(ligne)
  const [l] = await sql<{ cmd: number }[]>`SELECT idcommande_sous_traitant AS cmd FROM ligne_commande_sous_traitant WHERE idligne_commande_sous_traitant = ${ligne}`
  if (!l) continue
  const [u] = r.idutilisateur ? await sql<{ n: string }[]>`SELECT trim(concat(prenom, ' ', nom)) AS n FROM utilisateur WHERE idutilisateur = ${r.idutilisateur}` : []
  ajouts.push({ ligne, cmd: Number(l.cmd), le: r.le, delai: r.delai && /^\d{4}-\d{2}-\d{2}/.test(r.delai) ? r.delai.slice(0, 10) : null, par_id: Number(r.idutilisateur) || 0, par: u?.n || null })
}

for (const a of ajouts) console.log(`cde ${a.cmd} ligne ${a.ligne}  délai reçu ${a.le.toISOString().slice(0, 16)}  → ${a.delai ?? '—'}  (${a.par ?? '?'})`)
console.log(`${ajouts.length} délai(s) reçu(s) à enregistrer, ${deja.size} ligne(s) déjà enregistrée(s).`)

if (write && ajouts.length) {
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql // postgres.js typing: TransactionSql loses its call signatures
    for (const a of ajouts) {
      await tx`
        INSERT INTO delai_sst_evenement (idcommande_sous_traitant, idligne_commande_sous_traitant, type, le, delai_donne, origine, par_id, par)
        VALUES (${a.cmd}, ${a.ligne}, 'delai_recu', ${a.le}, ${a.delai}, 'historique', ${a.par_id}, ${a.par})`
    }
  })
  console.log('Écrit.')
} else if (!write) console.log('Dry run — re-run with --write to apply.')
await closeMpsPg()
