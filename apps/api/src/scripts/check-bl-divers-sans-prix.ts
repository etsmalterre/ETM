// Guard for LIVA #1127 — the avis d'expédition divers carries NO price.
//
// Isabelle's report (2026-09-03): the new AE divers printed a unit price and a
// line total on every priced item, and a euro grand total at the bottom —
// Unicycle must only read the number of pieces. The legacy
// ETAT_Expédition_diverse (model DIV632) prints designation + "N Pièce" and
// nothing else. This script pins that the PDF says nothing money-shaped and
// that the counts it prints instead are right.
//
// DB-free: it walks the element tree of the component fed with synthetic data
// (see claude_doc/pdf_email.md — "walk the element tree, never the rendered
// bytes"). Pass an expedition_divers id to also check a real document from the
// live data: tsx src/scripts/check-bl-divers-sans-prix.ts [id]

import 'dotenv/config'
import {
  BonLivraisonDiversPdf,
  quantiteParUnite,
  type BonLivraisonDiversPdfData,
} from '../lib/pdf/BonLivraisonDiversPdf.js'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
  if (!ok) failures++
}

/** Every string rendered by a PDF component (plain functions, no hooks). */
function pdfStrings(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) pdfStrings(c, out); return out }
  const el = node as { props?: { children?: unknown } }
  if (el.props?.children !== undefined) pdfStrings(el.props.children, out)
  return out
}

/** Anything a reader could take for a price: the euro sign, the two legacy
 *  column headers, or a "12,50"-shaped decimal that is not a quantity. */
function moneyShaped(strings: string[]): string[] {
  return strings.filter((s) => /€|P\.U\.|TOTAL \(|\bHT\b|\bTTC\b/i.test(s))
}

function checkDocument(label: string, data: BonLivraisonDiversPdfData) {
  const strings = pdfStrings(BonLivraisonDiversPdf({ data }))
  check(`${label} — money-shaped strings`, moneyShaped(strings), [])
  // Column headers are the all-caps strings; only two are allowed.
  const headers = new Set(strings.filter((s) => /^[A-ZÉ.() €]{4,}$/.test(s) && !s.startsWith('TOTAL EXP')))
  check(`${label} — table columns`, [...headers].sort(), ['DÉSIGNATION', 'QUANTITÉ'])
  return strings
}

// ── 1. synthetic document shaped like DIV632 (Unicycle, 2 cartons) ─────────
const unicycle: BonLivraisonDiversPdfData = {
  numero: 632,
  dateLong: '28 août 2026',
  clientNom: 'Unicycle',
  refClient: 'Commande C4144 du 26/08/2026',
  transporteurNom: 'DPD',
  adresseLivraison: { nom: 'Unicycle', adresse1: '3 impasse J. Dalou', adresse2: 'CS 80172', adresse3: null, cp: '91006', ville: 'EVRY CEDEX', pays: 'FRANCE' },
  cartons: [
    {
      detail: 'CARTON 1',
      items: [
        { designation: 'Tissu Voltige ®', variations: 'Blanche Titan · 20 Mètres', quantite: 1, unite: 4, unite_label: 'unité' },
        { designation: 'Tissu Voltige ®', variations: 'Rouge · 8 Mètres', quantite: 1, unite: 4, unite_label: 'unité' },
        { designation: 'Tissu Voltige ®', variations: 'Bleue · 20 Mètres', quantite: 2, unite: 4, unite_label: 'unité' },
      ],
    },
    {
      detail: 'CARTON 2',
      items: [
        { designation: 'Tissu Voltige ®', variations: 'Noir Titan · 18 Mètres', quantite: 2, unite: 4, unite_label: 'unité' },
        { designation: 'Coupon jersey', variations: null, quantite: 2.5, unite: 3, unite_label: 'Ml' },
      ],
    },
    { detail: 'enveloppe', items: [] },
  ],
}

const strings = checkDocument('DIV632-like', unicycle)
check('carton 1 count row', strings.includes('4 unités'), true)
check('carton 2 count row (mixed units)', strings.includes('2 unités · 2,50 Ml'), true)
check('grand total label', strings.find((s) => s.startsWith('TOTAL EXPÉDITION')), 'TOTAL EXPÉDITION - 3 CARTONS · 5 ARTICLES')
check('grand total value = pieces, not euros', strings.includes('6 unités · 2,50 Ml'), true)
check('quantiteParUnite singular', quantiteParUnite([{ designation: '', variations: null, quantite: 1, unite: 4, unite_label: 'unité' }]), '1 unité')
check('quantiteParUnite empty', quantiteParUnite([]), '')

// ── 2. the type itself refuses a price: a `prix` key is a compile error, and
//      at runtime an extra key changes nothing the document says ────────────
const smuggled = JSON.parse(JSON.stringify(unicycle)) as BonLivraisonDiversPdfData
for (const c of smuggled.cartons) for (const it of c.items) (it as unknown as Record<string, unknown>).prix = 12.5
check('extra prix key is ignored', pdfStrings(BonLivraisonDiversPdf({ data: smuggled })), strings)

// ── 3. optional: a real expedition from the live data ───────────────────────
const idArg = process.argv.slice(2).find((a) => /^\d+$/.test(a))
if (idArg) {
  const { buildBlDiversPdfData } = await import('../routes/expeditions.js')
  const { closeConnection } = await import('../lib/hfsql-auto.js')
  const data = await buildBlDiversPdfData(Number(idArg))
  if (!data) {
    console.log(`SKIP  expedition_divers ${idArg} not found`)
  } else {
    const real = checkDocument(`expedition_divers ${idArg}`, data)
    console.log(`      ${data.cartons.length} carton(s) · ${real.find((s) => s.startsWith('TOTAL EXP'))}`)
  }
  await closeConnection()
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures > 0 ? 1 : 0)
