/**
 * Guard for client tarif modes on CLIENT ORDER LINES
 * (lib/tarif-client.ts + lib/pricing-ligne-client.ts + the two write guards in
 * routes/commandes-client.ts).
 *
 * The bug this pins (reported 2026-07-30): Clients › Commandes priced every line
 * off the STANDARD PrixDeVenteV4 grid because the auto-pricer never received the
 * client. A client in "contrat" mode was therefore quoted the catalogue price
 * instead of its negotiated one, and when the contract lapsed nothing said so —
 * C2TEC's contract on référence E1731 expired on 30/06/2026 and an order was
 * still taken on 30/07/2026, at a price nobody in the app had validated.
 *
 * Checks:
 *  1. C2TEC / E1731 (client 19, ref_fini 1437, coloris 3515) resolves to
 *     ref_client_colori 209, mode "contrat", contract #475 expiring 20260630.
 *  2. That line is BLOCKED for a real quantity — no price, no fall back to the
 *     standard grid (which would be 8,50 €/Ml for 300 Ml).
 *  3. The standard grid still answers 8,50 €/Ml when no client is given, so the
 *     block is the client's tarif mode talking, not a broken pricer.
 *  4. Band selection inside a contract: a single "1 rouleau" band prices every
 *     larger quantity (C2TEC = 6,65 €/Ml at 4 rouleaux).
 *  5. Live data sweep — every (client × ref × coloris) with an ACTIVE contract
 *     is quoted that contract's price, and a "coefficient fixe" pair is quoted
 *     the standard engine re-run with the client's margin.
 *
 * Read-only — never writes.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env' })
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` })
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { calcLignePriceClient } from '../lib/pricing-ligne-client.js'
import { calcTarifRefFini } from '../lib/pricing-fini-tarif.js'
import {
  resolveLigneTarifMode, contratPrixForTrancheIdx, fetchTarifModes,
} from '../lib/tarif-client.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  OK   ${label}${detail ? ` — ${detail}` : ''}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// The reference case, from the incident.
const C2TEC = { client: 19, type: 2, ref: 1437, colori: 3515, rcc: 209, contrat: 475, expire: '20260630', prix: 6.65 }

async function main() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')

  console.log('\n1) C2TEC / E1731 — mode contrat, contrat expiré')
  const mode = await resolveLigneTarifMode({
    IDclient: C2TEC.client, type: C2TEC.type, IDreference: C2TEC.ref, IDcolori: C2TEC.colori,
  })
  check('la paire (référence × coloris) est résolue', mode !== null)
  if (mode) {
    check('ref_client_colori', mode.IDref_client_colori === C2TEC.rcc, `${mode.IDref_client_colori} (attendu ${C2TEC.rcc})`)
    check('tarif_mode', mode.tarif_mode === 'contrat', mode.tarif_mode)
    check('dernier contrat', mode.dernier_contrat?.IDcontrat_tarif === C2TEC.contrat, String(mode.dernier_contrat?.IDcontrat_tarif))
    check("date d'expiration", mode.dernier_contrat?.date_expiration === C2TEC.expire, mode.dernier_contrat?.date_expiration)
    // The pin below only means something once that date is in the past.
    check('le contrat est bien expiré aujourd’hui', today > C2TEC.expire && mode.contrat_expire, `aujourd'hui ${today}`)
  }

  console.log('\n2) La ligne est refusée, sans repli sur le tarif standard')
  const blocked = await calcLignePriceClient({
    type: C2TEC.type, IDreference: C2TEC.ref, IDcolori: C2TEC.colori, quantite: 300, unite: 3, IDclient: C2TEC.client,
  })
  check('blocked', blocked.blocked === true)
  check('aucun prix proposé', blocked.prix === null, String(blocked.prix))
  check('priceable = false', blocked.priceable === false)
  check('message explicite', /Contrat expiré/.test(blocked.blocked_reason ?? ''), blocked.blocked_reason ?? '—')
  // Blocking must fire before any quantity is typed — that is when the user
  // still has a chance to pick something else.
  const blockedNoQty = await calcLignePriceClient({
    type: C2TEC.type, IDreference: C2TEC.ref, IDcolori: C2TEC.colori, quantite: 0, unite: 3, IDclient: C2TEC.client,
  })
  check('bloqué dès le choix du coloris (sans quantité)', blockedNoQty.blocked === true)

  console.log('\n3) Le tarif standard répond toujours (sans client)')
  const std = await calcLignePriceClient({
    type: C2TEC.type, IDreference: C2TEC.ref, IDcolori: C2TEC.colori, quantite: 300, unite: 3,
  })
  check('prix standard 300 Ml', std.prix === 8.5, `${std.prix} €/Ml`)
  check('mode standard', std.tarif_mode === 'standard' && !std.blocked)

  console.log('\n4) Choix de la tranche dans un contrat')
  const contrat = mode?.dernier_contrat
  if (contrat) {
    // 300 Ml ≈ 4 rouleaux → tranche idx 4, alors que le contrat ne cote que
    // "1 rouleau" (idx 1) : c'est cette bande qui doit s'appliquer.
    check('4 rouleaux → bande "1 rouleau"', contratPrixForTrancheIdx(contrat, 4) === C2TEC.prix, `${contratPrixForTrancheIdx(contrat, 4)} €/Ml`)
    check('métrage (<1 rouleau) → même bande', contratPrixForTrancheIdx(contrat, 0) === C2TEC.prix, `${contratPrixForTrancheIdx(contrat, 0)} €/Ml`)
  } else {
    check('contrat lisible', false, 'aucun contrat trouvé')
  }

  console.log('\n5) Balayage des contrats ACTIFS et des coefficients en base')
  // designation_client / ref_client_colori tolerate SELECT * (accented `archivé`
  // is pruned in JS, never named in SQL).
  const desigs = await query<Record<string, unknown>>(`SELECT * FROM designation_client`)
  const desigById = new Map<number, Record<string, unknown>>()
  for (const d of desigs) desigById.set(Number(d.IDdesignation_client), d)
  const rccAll = await query<Record<string, unknown>>(`SELECT * FROM ref_client_colori`)
  const modes = await fetchTarifModes(
    rccAll.map((r) => ({ id: Number(r.IDref_client_colori), contrat: Number(r.contrat) })),
  )
  const arch = (r: Record<string, unknown>): boolean => Number(r['archivé'] ?? r['archiv'] ?? 0) === 1
  /** Tranche index the pricer used, from the roll geometry it reported. */
  const ROLLS = [1, 1, 2, 3, 4, 5, 10, 15, 30]
  const usedIdx = (nRolls: number, trancheRolls: number): number => {
    if (nRolls < 1) return 0
    const i = ROLLS.findIndex((m, k) => k > 0 && m === trancheRolls)
    return i > 0 ? i : 1
  }

  let actifs = 0, actifsOk = 0, coefs = 0, coefsOk = 0, expires = 0, skipped = 0
  for (const r of rccAll) {
    const rccId = Number(r.IDref_client_colori)
    const info = modes.get(rccId)
    if (!info) continue
    if (info.contrat_expire) { expires++; continue }
    if (info.tarif_mode === 'standard') continue
    const d = desigById.get(Number(r.IDdesignation_client))
    if (!d) continue
    const clientId = Number(d.IDclient)
    const refFini = Number(d.IDref_fini)
    // Écru-only catalogue entries exist but the fini path is what users price.
    if (!(clientId > 0) || !(refFini > 0)) continue
    const colori = Number(r.IDref_fini_colori) || Number(r.IDcolori_ecru)
    if (!(colori > 0)) continue
    // An ARCHIVED catalogue entry must never price a new line — and several
    // clients do carry an old archived designation holding a coefficient next to
    // a live one that doesn't (client 174 / ref 1343). Those rows are skipped
    // here for the same reason the resolver skips them.
    if (arch(r) || arch(d)) { skipped++; continue }
    // Duplicate rows can point at the same coloris; only assert on the pair the
    // resolver actually lands on, otherwise the expectation is built from a row
    // the pricer never read.
    const resolved = await resolveLigneTarifMode({ IDclient: clientId, type: 2, IDreference: refFini, IDcolori: colori })
    if (resolved?.IDref_client_colori !== rccId) { skipped++; continue }

    const res = await calcLignePriceClient({ type: 2, IDreference: refFini, IDcolori: colori, quantite: 100, unite: 3, IDclient: clientId })
    if (!res.priceable) { skipped++; continue }
    const idx = usedIdx(res.nRolls, res.trancheRolls)

    if (info.tarif_mode === 'contrat' && info.contrat_actif) {
      actifs++
      const want = contratPrixForTrancheIdx(info.contrat_actif, idx)
      // Print one conforming example: it is the pair to open in the app when
      // you want to SEE a negotiated price applied, not just read a counter.
      if (actifs === 1) console.log(`       exemple: client ${clientId} ref_fini ${refFini} coloris ${colori} → ${res.prix} €/Ml (contrat)`)
      if (res.tarif_mode === 'contrat' && res.prix === want) actifsOk++
      else console.log(`       contrat actif divergent: client ${clientId} ref ${refFini} col ${colori} → ${res.prix} (attendu ${want})`)
    } else if (info.tarif_mode === 'coefficient' && info.coefficient > 0) {
      coefs++
      const tarif = await calcTarifRefFini(refFini, colori, { coefficient: info.coefficient / 100 })
      const want = tarif.tranches[idx]?.moPrixDeVenteAuMl
      if (coefs === 1) console.log(`       exemple: client ${clientId} ref_fini ${refFini} coloris ${colori} → ${res.prix} €/Ml (coefficient ${info.coefficient} %)`)
      if (res.tarif_mode === 'coefficient' && res.prix === want) coefsOk++
      else console.log(`       coefficient divergent: client ${clientId} ref ${refFini} col ${colori} → ${res.prix} (attendu ${want})`)
    }
  }
  console.log(`  contrats actifs testés: ${actifs}, conformes: ${actifsOk}`)
  console.log(`  coefficients testés: ${coefs}, conformes: ${coefsOk}`)
  console.log(`  paires en mode contrat SANS contrat actif (donc bloquées): ${expires}`)
  console.log(`  paires ignorées (archivées / non résolues / non tarifables): ${skipped}`)
  check('tous les contrats actifs appliquent leur prix négocié', actifs === actifsOk)
  check('tous les coefficients appliquent la marge du client', coefs === coefsOk)

  console.log(`\n${failures === 0 ? 'TOUT EST VERT' : `${failures} ÉCHEC(S)`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
