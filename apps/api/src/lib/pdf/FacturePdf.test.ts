// Pagination guard for the facture PDF (LIVA #1148): invoice 9228 — six
// lines whose designations run four to five printed lines each — came out
// with a BLANK first page. The lines table fitted page 1 by ~3 pt, but
// react-pdf's paginator counts a block's marginBottom as part of its
// "presence" (`shouldBreak`: `!shouldSplit && endOfPresence > height`), so
// the table's 16 pt bottom margin pushed the whole table to page 2. The gap
// now lives on the totals block's marginTop. This test renders that exact
// shape and pins the page count; it counts /Type /Page objects in the output
// (pdfkit writes object dictionaries uncompressed — only streams are
// deflated), so it needs no rasterizer.
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { FacturePdf, PROFORMA_NOTE, type FacturePdfData } from './FacturePdf.js'

function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
}

// Shape of facture 9228: line 2 has the longer designation, which wraps and
// is what pushed the table to within a few points of the page bottom.
function lignes9228(): FacturePdfData['lignes'] {
  return Array.from({ length: 6 }, (_, i) => ({
    designation: [
      i === 1
        ? '029A - 0612 marine pant. 19-3922 TCX 63052/1 Jersey coton bio elas'
        : '029B - Gris clair C5010 Jersey coton bio elas',
      'V/ref : 029B',
      'N/Commande : 3762 V/Commande : Commande 0006708LS révisée du 21/05/2026',
      `Avis : ${12280 + i}`,
    ].join('\n'),
    quantite: 3185.1,
    unite: 'Ml',
    prix: 4.79,
    montant: 15256.63,
  }))
}

const base: FacturePdfData = {
  numero: '9228',
  type: 1,
  dateFacture: '11 septembre 2026',
  clientNom: 'Le slip Francais',
  numTva: null,
  adresseFacturation: {
    nom: 'LE SLIP FRANCAIS', adresse1: '6 rue du Paradis', adresse2: null, adresse3: null,
    cp: '75010', ville: 'PARIS', pays: 'France',
  },
  modePaiement: 'VIREMENT',
  echeance: '45 jours',
  echeanceDate: '26/10/2026',
  tvaRate: 20,
  lignes: [],
}

describe('FacturePdf pagination (LIVA #1148)', () => {
  it('a six-line invoice keeps its lines table on page 1 (2 pages, not 3)', async () => {
    const buf = await renderToBuffer(
      React.createElement(FacturePdf, { data: { ...base, lignes: lignes9228() } }) as any,
    )
    // Table on page 1, totals + bank card on page 2. Three pages means the
    // table jumped whole to page 2 and page 1 is blank below the cards.
    expect(pageCount(buf)).toBe(2)
  }, 30_000)

  it('a one-line invoice is a single page', async () => {
    const buf = await renderToBuffer(
      React.createElement(FacturePdf, { data: { ...base, lignes: lignes9228().slice(0, 1) } }) as any,
    )
    expect(pageCount(buf)).toBe(1)
  }, 30_000)
})

// LIVA #1164 — the proforma carries an adjustment mention under the totals
// (the amount follows the metres actually produced and shipped); the
// definitive invoice and the avoir never do. Asserted on the element tree:
// the rendered bytes hold glyph indices, not text (claude_doc/pdf_email.md).
function collectStrings(node: any, out: string[] = []): string[] {
  if (node == null || typeof node === 'boolean') return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { node.forEach((n) => collectStrings(n, out)); return out }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return collectStrings(node.type(node.props), out)
    collectStrings(node.props?.children, out)
  }
  return out
}

describe('FacturePdf proforma mention (LIVA #1164)', () => {
  const lignes = lignes9228().slice(0, 1)
  it('prints the adjustment mention on the proforma only', () => {
    const proforma = collectStrings(FacturePdf({ data: { ...base, lignes, isProforma: true } })).join('\n')
    expect(proforma).toContain(PROFORMA_NOTE)
    const facture = collectStrings(FacturePdf({ data: { ...base, lignes } })).join('\n')
    expect(facture).not.toContain(PROFORMA_NOTE)
    const avoir = collectStrings(FacturePdf({ data: { ...base, lignes, type: 2 } })).join('\n')
    expect(avoir).not.toContain(PROFORMA_NOTE)
  })
  it('keeps the exact wording asked on the ticket', () => {
    expect(PROFORMA_NOTE).toBe(
      'Le montant définitif sera ajusté à la livraison selon les métrages réellement produits et livrés.',
    )
  })
})
