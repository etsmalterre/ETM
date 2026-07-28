// Render a Demande de transport PDF with synthetic data (no DB) so we can
// inspect the layout visually.
// Usage: tsx src/scripts/dump-demande-transport-pdf.ts [out]
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { DemandeTransportPdf, type DemandeTransportPdfData } from '../lib/pdf/DemandeTransportPdf.js'

const data: DemandeTransportPdfData = {
  numero: 11651,
  dateLong: '28 juillet 2026',
  dateCourte: '28/07/2026',
  expediteur: 'Patricia - Ets Malterre',
  transporteurNom: null,
  clientNom: 'GANT MAILLE',
  commandeNumero: 3680,
  poids: 122.7,
  nbRouleaux: 6,
  enlevement: {
    nom: 'ETS MALTERRE SARL', adresse1: 'ZI Route de Thennes', adresse2: null, adresse3: null,
    cp: '80110', ville: 'MOREUIL', pays: 'France',
  },
  livraison: {
    nom: 'GANT MAILLE - LIVRER AVEC UN PORTEUR AVEC HAYON', adresse1: '26 rue René Caudron',
    adresse2: null, adresse3: null, cp: '60280', ville: 'Margny les Compiègne', pays: 'France',
  },
}

async function main() {
  const out = process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'demande-transport-preview.pdf')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const buf = await renderToBuffer(React.createElement(DemandeTransportPdf, { data }) as any)
  fs.writeFileSync(out, buf)
  console.log('wrote', out, buf.length, 'bytes')

  // Variant with a named carrier — exercises the destinataire card.
  const withCarrier: DemandeTransportPdfData = { ...data, transporteurNom: 'GEODIS Amiens' }
  const out2 = path.join(path.dirname(out), path.basename(out, '.pdf') + '-transporteur.pdf')
  const buf2 = await renderToBuffer(React.createElement(DemandeTransportPdf, { data: withCarrier }) as any)
  fs.writeFileSync(out2, buf2)
  console.log('wrote', out2, buf2.length, 'bytes')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
