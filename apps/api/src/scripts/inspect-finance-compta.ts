import { query } from '../lib/hfsql-auto.js'

async function main() {
  // Latest upload date per year, per societe
  const dates = (await query(
    `SELECT DATE, id_societe FROM upload_compta WHERE id_societe = 1 ORDER BY DATE`
  )) as any[]
  const lastByYear: Record<string, string> = {}
  for (const d of dates) lastByYear[String(d.DATE).slice(0, 4)] = String(d.DATE)
  console.log('last upload date per year (societe 1):', lastByYear)

  const d26 = lastByYear['2026']
  const d25 = lastByYear['2025']

  for (const variable of [0, 1]) {
    console.log(`\n=== charges ${variable ? 'VARIABLES' : 'FIXES'} (societe 1) ===`)
    const rows = (await query(
      `SELECT c.IDcompte_compta AS id, c.numero AS numero, c.libelle AS libelle, c.Description AS descr,
              a.debit AS d26, a.credit AS c26, b.debit AS d25, b.credit AS c25
         FROM compte_compta c
         LEFT JOIN releve_compta a ON a.IDcompte_compta = c.IDcompte_compta AND a.DATE = '${d26}'
         LEFT JOIN releve_compta b ON b.IDcompte_compta = c.IDcompte_compta AND b.DATE = '${d25}'
        WHERE c.id_societe = 1 AND c.frais_variable = ${variable}
        ORDER BY c.numero`
    )) as any[]
    for (const r of rows) {
      const m26 = (r.d26 ?? 0) - (r.c26 ?? 0)
      const m25 = (r.d25 ?? 0) - (r.c25 ?? 0)
      const pct = m25 ? Math.round((m26 / m25) * 100) : 0
      console.log(
        `${r.numero}\t${String(r.libelle).padEnd(38).slice(0, 38)}\t${m26.toFixed(2)}\t${m25.toFixed(2)}\t${pct}%\thasRel=${r.d26 !== null || r.d25 !== null}\tdescr=${r.descr ?? ''}`
      )
    }
    console.log(`(${rows.length} accounts)`)
  }

  console.log('\n=== any charge account with credit > 0 ? ===')
  const cr = (await query(
    `SELECT TOP 20 r.DATE, c.numero, r.debit, r.credit FROM releve_compta r
       JOIN compte_compta c ON c.IDcompte_compta = r.IDcompte_compta
      WHERE r.credit > 0 AND c.id_societe = 1 AND c.numero < 700000 ORDER BY r.DATE DESC`
  )) as any[]
  for (const r of cr) console.log(JSON.stringify(r))
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
