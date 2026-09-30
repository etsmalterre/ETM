/**
 * Guard for the client TVA rate on customer-facing documents
 * (apps/api/src/lib/tva.ts + the totals blocks of the commande / devis /
 * facture PDFs).
 *
 * The bug this pins: the confirmation de commande and the devis used to read
 * the société-1 `est_defaut` tva row (20 %) instead of `client.IDtva`, so a
 * client flagged "Exonération" in Clients › Gestion — export customers such as
 * AGAPE (Maroc) — was charged 20 % VAT on every printed document.
 *
 * Checks:
 *  1. loadClientTvaRate resolves an exonerated client to 0, a normal client to
 *     the catalog rate, and an unknown/unset client to the ETM default.
 *  2. buildClientPdfData / buildProformaPdfData / buildDevisPdfData carry that
 *     rate (0 for an exonerated client, 20 for a normal one).
 *  3. The totals block keeps « TVA (0 %) » and « TOTAL TTC » at 0 % and an
 *     exonerated document prints its exemption line under them (LIVA #1248 —
 *     before it the block collapsed to TOTAL HT with no legal reason); a
 *     taxed document prints no such line.
 *  4. tvaRowLabel formats the rate, 0 included.
 *
 * Read-only — never writes.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env' })
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` })
import React from 'react'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { loadClientTvaRate, loadDefaultTvaRate } from '../lib/tva.js'
import { tvaRowLabel } from '../lib/pdf/theme.js'
import { CommandeClientPdf } from '../lib/pdf/CommandeClientPdf.js'
import { DevisEtmPdf } from '../lib/pdf/DevisEtmPdf.js'
import { FacturePdf } from '../lib/pdf/FacturePdf.js'
import { buildClientPdfData, buildProformaPdfData } from '../routes/commandes-client.js'
import { buildDevisPdfData } from '../routes/devis.js'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}: ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`)
}

/** Every string rendered by a PDF component. The components are plain
 *  functions with no hooks, so calling them yields the element tree — which is
 *  cheaper (and far more readable) than parsing glyph-subset PDF output. */
function pdfStrings(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) pdfStrings(c, out); return out }
  const el = node as { props?: { children?: unknown } }
  if (el.props?.children !== undefined) pdfStrings(el.props.children, out)
  return out
}

/** The totals block: TVA row present? grand-total label? exemption line? */
function totalsShape(strings: string[]) {
  return {
    hasTva: strings.some((s) => s.startsWith('TVA (')),
    grandLabel: strings.find((s) => s.startsWith('TOTAL ')) ?? '(none)',
    subTotalRows: strings.filter((s) => s === 'Total HT').length,
    hasMention: strings.some((s) => /^(Exonération de TVA|Vente en franchise|Autoliquidation)/.test(s)),
  }
}

async function main() {
  // The exonération row of each société has valeur 0; société 1's is IDtva 4.
  const exoRows = await query<{ IDtva: number }>(
    `SELECT IDtva FROM tva WHERE IDsociete = 1 AND valeur = 0`,
  )
  const exoIds = exoRows.map((r) => Number(r.IDtva))
  if (exoIds.length === 0) throw new Error('no exonération row for IDsociete = 1 — check the tva catalog')

  const defaultRate = await loadDefaultTvaRate()
  check('ETM default rate', defaultRate, 20)

  // ── 1. rate resolution ────────────────────────────────────────────────
  const exoClient = (await query<{ IDclient: number }>(
    `SELECT IDclient FROM client WHERE IDtva IN (${exoIds.join(',')}) ORDER BY IDclient`,
  ))[0]
  if (!exoClient) throw new Error('no exonerated client in the data')
  check(`exonerated client ${exoClient.IDclient} rate`, await loadClientTvaRate(Number(exoClient.IDclient)), 0)

  const taxedClient = (await query<{ IDclient: number }>(
    `SELECT IDclient FROM client WHERE IDtva = 3 ORDER BY IDclient`,
  ))[0]
  if (!taxedClient) throw new Error('no client on the 20 % row')
  check(`taxed client ${taxedClient.IDclient} rate`, await loadClientTvaRate(Number(taxedClient.IDclient)), 20)
  check('unknown client falls back to the default', await loadClientTvaRate(0), defaultRate)

  // ── 2. document builders carry the client's rate ──────────────────────
  for (const [kind, ids, expected] of [
    ['exonerated', exoIds, 0],
    ['taxed', [3], 20],
  ] as const) {
    const cmd = (await query<{ IDcommande_client: number; numero: number }>(
      `SELECT cc.IDcommande_client, cc.numero FROM commande_client cc
       INNER JOIN client c ON cc.IDclient = c.IDclient
       WHERE c.IDtva IN (${ids.join(',')}) AND cc.IDsociete = 1
       ORDER BY cc.IDcommande_client DESC`,
    ))[0]
    if (cmd) {
      const id = Number(cmd.IDcommande_client)
      const cmdData = await buildClientPdfData(id)
      const proData = await buildProformaPdfData(id)
      check(`commande ${cmd.numero} (${kind}) tvaRate`, cmdData?.tvaRate, expected)
      check(`proforma ${cmd.numero} (${kind}) tvaRate`, proData?.tvaRate, expected)
      // …and the totals block that rate produces.
      const exo = expected === 0
      const cmdShape = totalsShape(pdfStrings(CommandeClientPdf({ data: cmdData! })))
      check(`commande ${cmd.numero} (${kind}) TVA row`, cmdShape.hasTva, true)
      check(`commande ${cmd.numero} (${kind}) grand label`, cmdShape.grandLabel, 'TOTAL TTC')
      check(`commande ${cmd.numero} (${kind}) mention printed`, cmdShape.hasMention, !!cmdData?.mentionTva)
      if (exo) console.log(`      mention: ${cmdData?.mentionTva ?? '(none — French client without a chosen mention)'}`)
      else check(`commande ${cmd.numero} (${kind}) no mention when taxed`, cmdData?.mentionTva ?? null, null)
      const proShape = totalsShape(pdfStrings(FacturePdf({ data: proData! })))
      check(`proforma ${cmd.numero} (${kind}) TVA row`, proShape.hasTva, true)
      check(`proforma ${cmd.numero} (${kind}) grand label`, proShape.grandLabel, 'TOTAL TTC')
      check(`proforma ${cmd.numero} (${kind}) mention`, proData?.mentionTva ?? null, cmdData?.mentionTva ?? null)
    } else {
      console.log(`SKIP  no ${kind} commande_client in the data`)
    }

    const dev = (await query<{ IDDevis_etm: number; numero: number }>(
      `SELECT d.IDDevis_etm, d.numero FROM devis_etm d
       INNER JOIN client c ON d.IDclient = c.IDclient
       WHERE c.IDtva IN (${ids.join(',')}) AND d.IDprospect = 0
       ORDER BY d.IDDevis_etm DESC`,
    ))[0]
    if (dev) {
      const devData = await buildDevisPdfData(Number(dev.IDDevis_etm))
      check(`devis ${dev.numero} (${kind}) tvaRate`, devData?.tvaRate, expected)
      const devShape = totalsShape(pdfStrings(DevisEtmPdf({ data: devData! })))
      check(`devis ${dev.numero} (${kind}) TVA row`, devShape.hasTva, true)
      check(`devis ${dev.numero} (${kind}) grand label`, devShape.grandLabel, 'TOTAL TTC')
      check(`devis ${dev.numero} (${kind}) mention`, devShape.hasMention, !!devData?.mentionTva)
      if (expected !== 0) check(`devis ${dev.numero} (${kind}) no mention when taxed`, devData?.mentionTva ?? null, null)
    } else {
      console.log(`SKIP  no ${kind} devis_etm in the data`)
    }
  }

  // ── 4. totals-row label ───────────────────────────────────────────────
  check('label at 0 %', tvaRowLabel(0), 'TVA (0 %)')
  check('label at 20 %', tvaRowLabel(20), 'TVA (20 %)')
  check('label at 5,5 %', tvaRowLabel(5.5), 'TVA (5,5 %)')

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  await closeConnection()
  if (failures > 0) process.exit(1)
}

main().catch(async (e) => { console.error(e); await closeConnection(); process.exit(1) })
