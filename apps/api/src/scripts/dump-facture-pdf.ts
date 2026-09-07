// Render a Facture PDF with synthetic data (no DB) so we can inspect the
// layout visually. Usage: tsx src/scripts/dump-facture-pdf.ts [out]
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
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

async function main() {
  const out = process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'facture-preview.pdf')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const buf = await renderToBuffer(React.createElement(FacturePdf, { data }) as any)
  fs.writeFileSync(out, buf)
  console.log('wrote', out, buf.length, 'bytes')

  // Proforma variant — exercises the bank coordinates card at the bottom.
  const proData: FacturePdfData = { ...data, isProforma: true, numero: '87' }
  const proOut = path.join(path.dirname(out), path.basename(out, '.pdf') + '-proforma.pdf')
  const proBuf = await renderToBuffer(React.createElement(FacturePdf, { data: proData }) as any)
  fs.writeFileSync(proOut, proBuf)
  console.log('wrote', proOut, proBuf.length, 'bytes')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
