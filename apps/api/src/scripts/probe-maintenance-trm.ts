/**
 * Read-only probe for TRM Atelier > Maintenance (routes/maintenance-trm.ts).
 *
 *   npx tsx src/scripts/probe-maintenance-trm.ts
 *
 * Prints, per métier, the kg knitted since each maintenance item (weighed
 * rolls, lib/maintenance-trm.ts) next to the legacy rouloir measure (Σ OF
 * quantities), so the 2026-10-01 switch of measure can be judged on prod.
 * The 2026-08 parity replay of the 15 000 Kg seuil against the WinDev screen
 * was retired with WinDev (2026-09-29) — see git history.
 */
import '../load-env.js'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'

const sql = mpsPg()
try {
  const ops = await sql`SELECT idoperation_maintenance, nom::text AS nom, portee, frequence, archive,
    to_char(date_derniere, 'YYYYMMDD') AS d FROM operation_maintenance ORDER BY 1`
  console.log('operation_maintenance:')
  for (const o of ops) console.log(`  ${o.idoperation_maintenance} ${o.nom} [${o.portee}] /${o.frequence} mois ${o.d ?? '—'}${o.archive ? ' (archivé)' : ''}`)

  const rows = await sql`
    SELECT m.emplacement::text AS emplacement, to_char(m.date_maintenance, 'YYYYMMDD') AS visite,
      (SELECT COALESCE(SUM(o.quantite), 0) FROM ordre_fabrication o
        WHERE o.idmachine = m.idmachine AND o.est_termine = 1 AND o.date_creation > m.date_maintenance) AS of_kg,
      (SELECT COALESCE(SUM(s.poids), 0) FROM stock_ecru s JOIN ordre_fabrication o ON o.idordre_fabrication = s.idordre_fabrication
        WHERE o.idmachine = m.idmachine AND s.date_saisie::date > m.date_maintenance) AS rolls_kg,
      (SELECT COUNT(*) FROM operation_maintenance_metier x WHERE x.idmachine = m.idmachine)::int AS entretiens
    FROM machine m WHERE m.archive = 0 ORDER BY 1`
  console.log('\nmétier  visite     OF kg (legacy)  rouleaux kg  entretiens')
  for (const r of rows) {
    console.log(`${String(r.emplacement).padEnd(7)} ${r.visite ?? '—'.padEnd(8)}  ${String(Math.round(r.of_kg)).padStart(14)}  ${String(Math.round(r.rolls_kg)).padStart(11)}  ${r.entretiens}`)
  }
} finally {
  await closeMpsPg()
}
