// Read-only census of reprises (lots suffixed R by hand) before reprise becomes data.
//   npx tsx src/scripts/audit-reprise-lots.ts [--env production] [--section cols|lots|etat2|traces] [--all]
import { config } from 'dotenv'
import { resolve } from 'node:path'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const env = arg('env') ?? 'development'
config({ path: env === 'production' ? resolve(process.cwd(), '../../../ETM/apps/api/.env.production') : resolve(process.cwd(), '.env.development') })
process.env.PGOPTIONS = '-c default_transaction_read_only=on'

const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const sql = mpsPg()
const section = arg('section')
const show = (t: string, rows: readonly unknown[]) => { console.log(`\n=== ${t} (${rows.length})`); console.table(rows) }

if (section === 'cols') {
  for (const t of ['stock_fini', 'suivilot', 'data_bl_tricotbot', 'etat_stock_fini']) {
    const r = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ${t} ORDER BY ordinal_position`
    console.log(t, r.map((c) => `${c.column_name}:${c.data_type}`).join(', '))
  }
}

// A lot carrying something after the dyer's digits (R, -R, TER, REPRIS, BIS…).
const SUFFIXE = String.raw`^\s*[A-Za-z]*\s*\d{5,}\s*[-_ /]?\s*[A-Za-z].*$`
const CANON = String.raw`^MA\d{5,}R$`

if (!section || section === 'lots') {
  const lots = await sql`
    SELECT trim(sf.lot::text) AS lot, count(*)::int AS rouleaux,
           count(DISTINCT sf.idref_commande_source)::int AS lignes,
           min(sf.date_saisie)::date::text AS premier, max(sf.date_saisie)::date::text AS dernier,
           string_agg(DISTINCT sf.idetat_stock_fini::text, ',') AS etats,
           string_agg(DISTINCT st.nom::text, ',') AS sst,
           (trim(sf.lot::text) ~ ${CANON}) AS canon
    FROM stock_fini sf
    LEFT JOIN ligne_commande_sous_traitant l ON l.idligne_commande_sous_traitant = sf.idref_commande_source
    LEFT JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
    LEFT JOIN sous_traitant st ON st.idsous_traitant = c.idsous_traitant
    WHERE trim(sf.lot::text) ~ ${SUFFIXE}
    GROUP BY trim(sf.lot::text) ORDER BY premier`
  const canon = lots.filter((l) => l.canon)
  console.log(`lots with a suffix: ${lots.length} (${lots.reduce((a, l) => a + l.rouleaux, 0)} rolls) — canonical MA…R: ${canon.length} (${canon.reduce((a, l) => a + l.rouleaux, 0)} rolls)`)
  const parAn = new Map<string, [number, number]>()
  for (const l of lots) { const y = String(l.premier ?? '?').slice(0, 4); const v = parAn.get(y) ?? [0, 0]; parAn.set(y, [v[0] + 1, v[1] + l.rouleaux]) }
  console.log('per year (lots, rolls):', Object.fromEntries(parAn))
  console.log('états of suffixed rolls:', await sql`
    SELECT idetat_stock_fini AS etat, count(*)::int AS n FROM stock_fini WHERE trim(lot::text) ~ ${SUFFIXE} GROUP BY 1 ORDER BY 1`)
  show('NON-canonical suffixes', lots.filter((l) => !l.canon))
  if (process.argv.includes('--all')) show('canonical', canon)

  // For each suffixed lot: is the base lot still present on the same line (rolls / suivilot)?
  const pairs = await sql`
    WITH r AS (
      SELECT DISTINCT sf.idref_commande_source AS ligne, trim(sf.lot::text) AS lot,
             substring(trim(sf.lot::text) from '\d{5,}') AS chiffres
      FROM stock_fini sf WHERE trim(sf.lot::text) ~ ${SUFFIXE})
    SELECT
      count(*)::int AS paires,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM stock_fini b WHERE b.idref_commande_source = r.ligne
         AND trim(b.lot::text) ~ ('^[A-Za-z]*\s*' || r.chiffres || '$')))::int AS base_rolls_meme_ligne,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM suivilot s WHERE s.idligne_commande_sous_traitant = r.ligne
         AND trim(s.lot::text) = r.lot))::int AS suivilot_suffixe,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM suivilot s WHERE s.idligne_commande_sous_traitant = r.ligne
         AND trim(s.lot::text) ~ ('^[A-Za-z]*\s*' || r.chiffres || '$')))::int AS suivilot_base
    FROM r`
  show('suffixed (ligne, lot) pairs: base lot still there?', pairs)
  show('suivilot of suffixed lots by état', await sql`
    SELECT idetatlot AS etat, count(*)::int AS n FROM suivilot WHERE trim(lot::text) ~ ${SUFFIXE} GROUP BY 1 ORDER BY 1`)
}

if (!section || section === 'etat2') {
  show('rolls in état 2 (En reprise) today, by lot', await sql`
    SELECT c.idcommande_sous_traitant AS cmd, c.est_soldee, st.nom::text AS sst, sf.idref_commande_source AS ligne,
           trim(sf.lot::text) AS lot, count(*)::int AS rouleaux, min(sf.date_saisie)::date::text AS saisie,
           (SELECT string_agg(s.idetatlot::text, ',') FROM suivilot s
             WHERE s.idligne_commande_sous_traitant = sf.idref_commande_source AND trim(s.lot::text) = min(trim(sf.lot::text))) AS etat_lot
    FROM stock_fini sf
    LEFT JOIN ligne_commande_sous_traitant l ON l.idligne_commande_sous_traitant = sf.idref_commande_source
    LEFT JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
    LEFT JOIN sous_traitant st ON st.idsous_traitant = c.idsous_traitant
    WHERE sf.idetat_stock_fini = 2
    GROUP BY 1, 2, 3, 4, 5 ORDER BY saisie`)
  show('stock_fini by état', await sql`SELECT idetat_stock_fini AS etat, count(*)::int AS n FROM stock_fini GROUP BY 1 ORDER BY 1`)
  show('suivilot by état', await sql`SELECT idetatlot AS etat, count(*)::int AS n FROM suivilot GROUP BY 1 ORDER BY 1`)
  show('suivilot état 2 (lot en reprise)', await sql`
    SELECT s.idsuivilot, s.idcommande_sous_traitant AS cmd, trim(s.lot::text) AS lot, s.date::text AS reception,
           (SELECT count(*)::int FROM stock_fini sf WHERE sf.idref_commande_source = s.idligne_commande_sous_traitant
              AND trim(sf.lot::text) = trim(s.lot::text)) AS rouleaux
    FROM suivilot s WHERE s.idetatlot = 2 ORDER BY s.date`)
}

if (!section || section === 'traces') {
  show('Tricobot BL rows whose lot carries a suffix', await sql`
    SELECT trim(lot::text) AS lot, count(*)::int AS n, max(date)::text AS jour FROM data_bl_tricotbot
    WHERE trim(lot::text) ~ ${SUFFIXE} GROUP BY 1 ORDER BY jour DESC LIMIT 30`)
  show('Tricobot: same piece read on 2+ BL dates of the same line (reprise BL?)', await sql`
    SELECT count(*)::int AS pieces, count(DISTINCT idligne_commande_sous_traitant)::int AS lignes,
           min(premier)::text AS depuis FROM (
      SELECT idligne_commande_sous_traitant, trim(num_piece::text) AS p, min(date) AS premier
      FROM data_bl_tricotbot WHERE trim(coalesce(num_piece::text, '')) <> ''
      GROUP BY 1, 2 HAVING count(DISTINCT date) > 1) x`)
  show('soumission emails (type 15) naming a suffixed lot', await sql`
    SELECT count(*)::int AS n, min(date)::date::text AS depuis, max(date)::date::text AS jusqu FROM envoi_email
    WHERE idtype_doc = 15 AND notes::text ~* '\d{5,}\s*[-_ ]?\s*(R\M|REPRIS)'`)
  const ja = await sql`SELECT to_regclass('journal_activite')::text AS t`
  console.log('\njournal_activite present:', ja[0].t)
}

await closeMpsPg()
