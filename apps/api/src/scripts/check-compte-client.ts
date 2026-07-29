/**
 * Guard for the compte client generator (apps/api/src/lib/compte-client.ts).
 *
 * 1. Replays generation for EVERY existing client against the set of codes held
 *    by all the others — checks the output is always valid, always unique, and
 *    reports how often it reproduces the code the accountant actually picked.
 * 2. Shows what would be generated for the clients that currently have no
 *    compte at all (the "Nouveau client" leftovers this feature exists to stop).
 * 3. Simulates creating a batch of same-named clients to prove collisions
 *    resolve instead of looping.
 *
 * Read-only — never writes.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env' })
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` })
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { pickCompte, normalizeCompte, isValidCompte, COMPTE_PREFIX } from '../lib/compte-client.js'

async function main() {
  const rows = await query<{ IDclient: unknown; nom: unknown; compte: unknown }>(
    `SELECT IDclient, nom, compte FROM client ORDER BY IDclient`,
  )
  const clients = rows.map((r) => ({
    id: Number(r.IDclient),
    nom: r.nom == null ? '' : String(r.nom),
    compte: normalizeCompte(r.compte == null ? '' : String(r.compte)),
  }))
  console.log(`clients: ${clients.length}`)

  const all = new Set(clients.map((c) => c.compte).filter(Boolean))

  // ── 1. replay ────────────────────────────────────────
  let exact = 0
  let invalid = 0
  let collided = 0
  // Legacy mixes 3- and 4-char suffixes; only the 3-char ones are comparable
  // with what we now generate, so score that subset separately.
  let three = 0
  let threeExact = 0
  let threePrefix = 0
  const mismatches: string[] = []
  for (const c of clients) {
    if (!c.nom.trim()) continue
    const taken = new Set(all)
    taken.delete(c.compte)
    const gen = pickCompte(c.nom, taken)
    if (!isValidCompte(gen)) { invalid++; console.log(`  INVALID ${gen} for ${c.nom}`) }
    if (taken.has(gen)) { collided++; console.log(`  COLLISION ${gen} for ${c.nom}`) }
    if (gen === c.compte) exact++
    else if (mismatches.length < 30) mismatches.push(`${c.compte.padEnd(9)} → ${gen.padEnd(9)} ${c.nom}`)
    if (c.compte.length === 6) {
      three++
      if (gen === c.compte) threeExact++
    }
    // Does the generated code at least share the accountant's mnemonic stem?
    if (c.compte.length >= 6 && c.compte.slice(0, 6) === gen) threePrefix++
  }
  console.log(`\nreplay: exact match with legacy (3-char subset) = ${threeExact}/${three}`)
  console.log(`        generated == first 3 chars of legacy code = ${threePrefix}/${clients.length}`)
  console.log(`replay: exact match with legacy = ${exact}/${clients.length}`)
  console.log(`        invalid = ${invalid}   collisions = ${collided}`)
  console.log('sample of differences (legacy → generated):')
  for (const m of mismatches) console.log('  ' + m)

  // ── 2. clients with no compte today ──────────────────
  const missing = clients.filter((c) => !c.compte && c.nom.trim())
  console.log(`\nclients without a compte: ${missing.length}`)
  const taken = new Set(all)
  for (const c of missing) {
    const gen = pickCompte(c.nom, taken)
    taken.add(gen)
    console.log(`  ${String(c.id).padEnd(6)} ${gen}   ${c.nom}`)
  }

  // ── 3. collision cascade on a repeated name ──────────
  const cascade = new Set(all)
  const produced: string[] = []
  for (let i = 0; i < 12; i++) {
    const g = pickCompte('SOFILETA', cascade)
    if (cascade.has(g)) { console.log(`  CASCADE COLLISION at ${i}: ${g}`); break }
    cascade.add(g)
    produced.push(g)
  }
  console.log(`\n12x "SOFILETA" → ${produced.join(' ')}`)

  // ── 4. edge-case names ───────────────────────────────
  console.log('\nedge cases:')
  for (const n of ['MC', 'A', 'SARL', 'Société Générale', 'L’Atelier', '7 FASHION', 'Éts Malterre', '   ']) {
    try {
      const g = n.trim() ? pickCompte(n, all) : COMPTE_PREFIX + '???'
      console.log(`  ${JSON.stringify(n).padEnd(22)} → ${g}  valid=${isValidCompte(g)}`)
    } catch (e) {
      console.log(`  ${JSON.stringify(n).padEnd(22)} → THREW ${(e as Error).message}`)
    }
  }
}

main().catch(console.error).finally(() => closeConnection())
