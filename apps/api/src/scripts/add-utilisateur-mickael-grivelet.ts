// One-off, idempotent: add Mickael Grivelet (TRM staff) to the shared
// `utilisateur` table. Run on the server before/with the first TRM deploy of
// Paramètres > Utilisateurs — the dev DB already has him (2026-08-24), prod
// doesn't, and the TRM staff allowlist expects the row.
//
//   npx tsx src/scripts/add-utilisateur-mickael-grivelet.ts
//
// `utilisateur` is 5 columns (IDutilisateur, pc, prenom, nom, IDexpediteur),
// all ASCII. The PK is not auto-assigned in HFSQL — computed as max+1 here,
// never hardcoded (dev got 21; prod's next id may differ).

import { query } from '../lib/hfsql-auto.js'

async function main() {
  const existing = (await query(
    "SELECT IDutilisateur, prenom, nom FROM utilisateur WHERE prenom = 'Mickael' AND nom = 'Grivelet'",
  )) as any[]
  if (existing.length > 0) {
    console.log('Already present:', JSON.stringify(existing))
    return
  }
  const maxRows = (await query('SELECT MAX(IDutilisateur) AS maxid FROM utilisateur')) as any[]
  const nextId = Number(maxRows[0]?.maxid ?? 0) + 1
  if (!Number.isFinite(nextId) || nextId <= 1) throw new Error(`bad next id: ${nextId}`)
  await query(
    `INSERT INTO utilisateur (IDutilisateur, pc, prenom, nom, IDexpediteur) VALUES (${nextId}, 'pc-mickael', 'Mickael', 'Grivelet', 0)`,
  )
  const check = (await query(`SELECT * FROM utilisateur WHERE IDutilisateur = ${nextId}`)) as any[]
  console.log('Inserted:', JSON.stringify(check))
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
