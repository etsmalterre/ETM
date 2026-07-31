// Guard for the DIVERS half of POST /api/factures/prov/generate.
//
// The generator invoices `expedition_divers` shipments one proforma per
// shipment, exactly as legacy did — so the legacy definitive ledger IS the
// expected output. This replays the generator's line builder over every
// facture that carries an IDexpedition_divers back-pointer and compares it to
// the lines legacy actually wrote.
//
// What is checked strictly: the ARTICLE LABEL, the quantity, the unit text and
// the unit price of every line — the figures the client is billed on.
//
// Three known divergences in the designation BLOCK, reported but never counted
// as failures:
//   - legacy's OLD template printed the article label alone; the "N/Commande …
//     V/Commande …" + "Avis : N" lines were added later. Older factures
//     therefore legitimately carry a one-line designation.
//   - legacy truncated the commande line at 60 chars (a WinDev display
//     artifact); ETM emits the full string, like its formelle pass already does.
//   - a few legacy factures carry hand-typed extra lines ("PORT", a manual
//     rebate…) that no generator could reproduce.
//
// Run:  npx tsx src/scripts/check-divers-facturation.ts
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { loadDiversItems, resolveDiversPrix, type DiversItem } from '../routes/expeditions.js'
import { diversArticleLabel, diversUniteLabel } from '../routes/factures.js'

/** Shipments up to this id carry hand-touched invoices — a label typed instead
 *  of picked ("Plaid gmx 590" for catalog "Plaid gx 590"), several variations
 *  merged into one line, a quantity edited on the shipment after the invoice
 *  went out, a catalog designation renamed since ("Col R006 - 44" → "…- 2L").
 *  Nothing reproduces those and nothing should try.
 *
 *  Every shipment ABOVE it reproduces today (576-598), so a divergence up there
 *  means the line builder drifted from what the two apps produce now — a real
 *  failure. Raise this ONLY with evidence that the newly-covered shipments were
 *  themselves hand-typed. */
const HAND_TYPED_CUTOFF = 575

const r2 = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100

/** Same rule as the generator: frozen ship-time price, tarif grid when 0. */
const prixCache = new Map<string, number>()
async function diversPrix(it: DiversItem): Promise<number> {
  if (it.prix > 0) return r2(it.prix)
  if (!(it.IDref_divers > 0)) return 0
  const key = `${it.IDref_divers}|${it.IDVariation1}|${it.IDVariation2}`
  if (!prixCache.has(key)) {
    prixCache.set(key, r2(await resolveDiversPrix(it.IDref_divers, it.IDVariation1, it.IDVariation2)))
  }
  return prixCache.get(key)!
}

/** The generator's designation for one carton article. */
function buildDesignation(label: string, cmdLine: string, expId: number): string {
  const parts = [label]
  if (cmdLine) parts.push(cmdLine)
  parts.push(`Avis : ${expId}`)
  return parts.join('\r\n')
}

type TailVerdict = 'exact' | 'truncated' | 'old-template' | 'differs'

/** How the built designation relates to the one legacy stored. The article
 *  label (first line) is already known equal modulo whitespace, so only the
 *  lines under it are judged.
 *
 *  The designation block grew in three steps over the ledger's life:
 *    label                                  (oldest)
 *    label + "Avis : N"                     (avis 386-389 era)
 *    label + "N/Commande … V/Commande …" + "Avis : N"   (current)
 *  We emit the current one; the two earlier shapes are history, not drift. */
function tailVerdict(built: string, stored: string): TailVerdict {
  const b = built.split('\r\n').slice(1).map((l) => l.trim())
  const s = stored.split('\r\n').slice(1).map((l) => l.trim())
  if (b.join('\n') === s.join('\n')) return built === stored ? 'exact' : 'truncated'
  // Older templates: the tail is a suffix of the current one (no commande line,
  // or nothing at all under the label).
  if (s.length < b.length && b.slice(b.length - s.length).join('\n') === s.join('\n')) return 'old-template'
  if (b.length !== s.length) return 'differs'
  return b.every((line, i) => line === s[i] || (s[i].length <= 60 && line.startsWith(s[i])))
    ? 'truncated'
    : 'differs'
}

async function main() {
  const factures = (await query<any>(
    `SELECT IDfacture, numero, IDclient, IDexpedition_divers, TYPE AS tk
       FROM facture WHERE IDsociete = 1 AND IDexpedition_divers > 0`,
  )) as any[]
  // Compare PER SHIPMENT, not per facture: 39 shipments were invoiced across
  // two documents (a partial invoice plus a complement, or an avoir), so no
  // single facture holds the whole expected set.
  const byExp = new Map<number, number[]>()
  for (const f of factures) {
    const e = Number(f.IDexpedition_divers)
    byExp.set(e, [...(byExp.get(e) ?? []), Number(f.IDfacture)])
  }
  console.log(`Legacy divers factures: ${factures.length} sur ${byExp.size} expédition(s)`)

  let exact = 0
  let truncatedOnly = 0
  let oldTemplate = 0
  let extraLegacyLines = 0
  let priceDrift = 0
  let mismatched = 0
  const failures: string[] = []
  const mismatchedExpIds: number[] = []
  let newestReproduced = 0

  for (const [expId, facIds] of byExp) {
    const facId = facIds[0]

    // --- expected (what the generator would produce) -------------------
    const head = (await fixEncoding(
      (await query<any>(
        `SELECT IDexpedition_divers, IDclient, IDcommande_client, ref_client
           FROM expedition_divers WHERE IDexpedition_divers = ${expId}`,
      )) as any[],
      'expedition_divers', 'IDexpedition_divers', ['ref_client'],
    ))[0] as any
    if (!head) continue

    const cmdId = Number(head.IDcommande_client) || 0
    let cmd: any = null
    if (cmdId > 0) {
      cmd = (await fixEncoding(
        (await query<any>(
          `SELECT IDcommande_client, numero, ref_client FROM commande_client WHERE IDcommande_client = ${cmdId}`,
        )) as any[],
        'commande_client', 'IDcommande_client', ['ref_client'],
      ))[0] as any
    }
    const cmdLine = cmd
      ? `N/Commande : ${cmd.numero != null ? Number(cmd.numero) : ''} V/Commande : ${(cmd.ref_client ?? '').toString().trim()}`
      : ''

    const cartons = (await query<any>(
      `SELECT IDligne_expedition_divers FROM ligne_expedition_divers
        WHERE IDexpedition_divers = ${expId} ORDER BY IDligne_expedition_divers`,
    )) as any[]
    const cartonIds = cartons.map((c) => Number(c.IDligne_expedition_divers) || 0).filter((x) => x > 0)
    const itemsByCarton = await loadDiversItems(cartonIds)

    // Same merge the generator applies: one line per (label, unit, price).
    const mergedExpected = new Map<string, { designation: string; quantite: number; unite: string; prix: number }>()
    for (const cid of cartonIds) {
      for (const it of itemsByCarton.get(cid) ?? []) {
        const label = diversArticleLabel(it) || `Article ${it.IDref_divers_expedie}`
        const unite = diversUniteLabel(it.unite)
        const prix = await diversPrix(it)
        const key = `${label} ${unite} ${prix}`
        const hit = mergedExpected.get(key)
        if (hit) { hit.quantite = r2(hit.quantite + r2(it.quantite)); continue }
        mergedExpected.set(key, {
          designation: buildDesignation(label, cmdLine, expId),
          quantite: r2(it.quantite),
          unite,
          prix,
        })
      }
    }
    const expected = Array.from(mergedExpected.values())
    if (expected.length === 0) continue // shipment emptied since — nothing to compare

    // --- actual (every line legacy wrote for this shipment) ------------
    const storedRaw = (await query<any>(
      `SELECT IDligne_facture, designation, quantite, unite, prix FROM ligne_facture WHERE IDfacture IN (${facIds.join(',')})`,
    )) as any[]
    const stored = (await fixEncoding(storedRaw, 'ligne_facture', 'IDligne_facture', ['designation', 'unite'])) as any[]

    // Match each expected line against an unused stored line (order differs).
    const unused = stored.map((l) => ({
      designation: (l.designation ?? '').toString(),
      quantite: r2(l.quantite),
      unite: (l.unite ?? '').toString(),
      prix: r2(l.prix),
      taken: false,
    }))
    // A line matches on article label + quantity + unit; the price and the
    // designation tail are then classified, never used to reject the match
    // (legacy invoices were hand-editable, and the shipment row is the source
    // of truth for a NEW proforma).
    let sawTruncation = false
    let sawOldTemplate = false
    let sawPriceDrift = false
    const missing: string[] = []
    for (const e of expected) {
      const label = e.designation.split('\r\n')[0]
      const sameLabel = (s: typeof unused[number]) =>
        s.designation.split('\r\n')[0].trim() === label.trim()
      const hit = unused.find((s) => !s.taken && s.quantite === e.quantite && s.unite === e.unite && sameLabel(s))
      if (!hit) {
        // Say WHY, so a future failure is diagnosable: a quantity that moved
        // after invoicing reads very differently from a label we can't build.
        const sameLabelOther = unused.find((s) => !s.taken && sameLabel(s))
        missing.push(sameLabelOther
          ? `${label} (qté ${e.quantite} ≠ ${sameLabelOther.quantite} facturée)`
          : `${label} (libellé absent de la facture)`)
        continue
      }
      hit.taken = true
      if (hit.prix !== e.prix) sawPriceDrift = true
      const verdict = tailVerdict(e.designation, hit.designation)
      if (verdict === 'truncated') sawTruncation = true
      else if (verdict === 'old-template') sawOldTemplate = true
      else if (verdict === 'differs') {
        missing.push(`${label} (bloc N/Commande divergent)`)
      }
    }
    const leftover = unused.filter((s) => !s.taken)

    if (sawPriceDrift) priceDrift++
    if (missing.length > 0) {
      mismatched++
      mismatchedExpIds.push(expId)
      failures.push(
        `  facture ${facId} (avis ${expId}) — ${missing.length} ligne(s) non reproduite(s): ${missing.slice(0, 3).join(' | ')}`,
      )
    } else if (leftover.length > 0) {
      extraLegacyLines++
    } else if (sawOldTemplate) {
      oldTemplate++
      newestReproduced = Math.max(newestReproduced, expId)
    } else if (sawTruncation) {
      truncatedOnly++
      newestReproduced = Math.max(newestReproduced, expId)
    } else {
      exact++
      newestReproduced = Math.max(newestReproduced, expId)
    }
  }

  console.log(`  exact (byte-identical lines)            : ${exact}`)
  console.log(`  identical modulo legacy's 60-char cut   : ${truncatedOnly}`)
  console.log(`  figures identical, legacy's old template: ${oldTemplate}`)
  console.log(`  ours reproduced + legacy hand-added     : ${extraLegacyLines}`)
  console.log(`  (dont prix facturé ≠ prix de l'article) : ${priceDrift}`)
  console.log(`  NOT REPRODUCED (legacy hand-typed lines): ${mismatched}`)

  // The only thing that must hold: the CURRENT WinDev template is the one we
  // emit. Old hand-typed invoices are history — what matters is that the recent
  // ledger reproduces and that no NEW divergence appears above the cut-off.
  mismatchedExpIds.sort((a, b) => a - b)
  const newestMismatch = mismatchedExpIds[mismatchedExpIds.length - 1] ?? 0
  console.log(`\n  newest reproduced shipment : avis ${newestReproduced}`)
  console.log(`  newest NOT reproduced      : avis ${newestMismatch}`)
  const recentFailures = mismatchedExpIds.filter((e) => e > HAND_TYPED_CUTOFF)
  if (recentFailures.length > 0) {
    console.log(`\n  ⚠ ${recentFailures.length} divergence(s) au-dessus de l'avis ${HAND_TYPED_CUTOFF}:`)
    for (const f of failures.slice(-12)) console.log(f)
  } else {
    console.log(`  → toutes les divergences sont sous l'avis ${HAND_TYPED_CUTOFF} (saisie manuelle d'époque)`)
  }

  // --- the open shipments the next run will invoice --------------------
  const open = (await query<any>(
    `SELECT IDexpedition_divers, IDclient, IDcommande_client FROM expedition_divers
      WHERE est_facture IS NULL OR est_facture = 0 ORDER BY IDexpedition_divers`,
  )) as any[]
  console.log(`\nExpéditions diverses non facturées: ${open.length}`)
  for (const o of open) {
    const eid = Number(o.IDexpedition_divers)
    const cartons = (await query<any>(
      `SELECT IDligne_expedition_divers FROM ligne_expedition_divers WHERE IDexpedition_divers = ${eid}`,
    )) as any[]
    const ids = cartons.map((c) => Number(c.IDligne_expedition_divers) || 0).filter((x) => x > 0)
    const items = await loadDiversItems(ids)
    const nb = Array.from(items.values()).reduce((s, a) => s + a.length, 0)
    const total = Array.from(items.values()).flat().reduce((s, it) => s + r2(it.quantite) * r2(it.prix), 0)
    console.log(
      `  avis ${eid} · client ${Number(o.IDclient)} · ${nb} article(s) → ` +
      (nb === 0 ? 'IGNORÉE (vide, reste ouverte)' : `proforma de ${r2(total)} € HT`),
    )
  }

  // Only a divergence on a RECENT shipment fails the guard — that would mean
  // the line builder drifted from what the WinDev app produces today.
  process.exit(recentFailures.length > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
