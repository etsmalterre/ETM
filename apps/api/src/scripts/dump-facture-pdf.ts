// Render a Facture PDF with synthetic data (no DB) so we can inspect the
// layout visually. Usage: tsx src/scripts/dump-facture-pdf.ts [out] [rasterDir]
// Writes three files next to `out`: the 2-line preview, its proforma variant
// (bank card at the bottom) and the 6-line "9228" shape of LIVA #1148 (the
// table fits page 1 by a few points — page 1 must NOT come out blank).
// `rasterDir` = a temp dir holding `pdf-to-img` (see claude_doc/pdf_email.md)
// to also write one PNG per page.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { FacturePdf, FacturePdfData } from '../lib/pdf/FacturePdf.js'

const data: FacturePdfData = {
  numero: '9152',
  type: 1,
  dateFacture: '6 juillet 2026',
  clientNom: 'FATTON Orly',
  siren: '552 100 554',
  numTva: 'FR 12 345 678 901',
  adresseFacturation: {
    nom: 'FATTON Orly', adresse1: 'Zone de Fret Juliette', adresse2: 'Bâtiment 131 A BP 786', adresse3: null,
    cp: '94548', ville: 'ORLY AEROGARE CEDEX', pays: 'FRANCE',
  },
  modePaiement: 'VIREMENT',
  echeance: '45 jours, fin de mois',
  echeanceDate: '31/08/2026',
  tvaRate: 20,
  lignes: [
    { designation: 'Port', quantite: 1, unite: 'pièce', prix: 166, montant: 166 },
    {
      designation: 'TRICOT DIVERS\nV/ref :\nN/Commande : 3810 V/Commande : Commande du 02/07/2026\nAvis : 12089',
      quantite: 166.4, unite: 'Kg', prix: 3, montant: 499.2,
    },
  ],
}

// Facture 9228 (LIVA #1148): six lines, line 2's designation wraps, and the
// table ends ~3 pt above the page's bottom padding. Same shape as
// FacturePdf.test.ts — keep the two in sync.
const data1148: FacturePdfData = {
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
  lignes: Array.from({ length: 6 }, (_, i) => ({
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
  })),
}

async function rasterize(pdfPath: string, rasterDir: string) {
  const mod = await import(pathToFileURL(path.join(rasterDir, 'node_modules/pdf-to-img/dist/index.js')).href)
  const doc = await mod.pdf(pdfPath, { scale: 1.5 })
  let i = 0
  for await (const page of doc) {
    const png = pdfPath.replace(/\.pdf$/, `-p${++i}.png`)
    fs.writeFileSync(png, page)
    console.log('png', png)
  }
}

async function main() {
  const out = process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'facture-preview.pdf')
  const rasterDir = process.argv[3]
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const variants: Array<[string, FacturePdfData]> = [
    [out, data],
    // Proforma variant — exercises the bank coordinates card at the bottom.
    [path.join(path.dirname(out), path.basename(out, '.pdf') + '-proforma.pdf'), { ...data, isProforma: true, numero: '87' }],
    [path.join(path.dirname(out), path.basename(out, '.pdf') + '-1148.pdf'), data1148],
  ]
  for (const [file, d] of variants) {
    const buf = await renderToBuffer(React.createElement(FacturePdf, { data: d }) as any)
    fs.writeFileSync(file, buf)
    console.log('wrote', file, buf.length, 'bytes')
    if (rasterDir) await rasterize(file, rasterDir)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
