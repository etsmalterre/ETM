// ETS Malterre CGV (conditions générales de vente) — one place for everything
// that makes them enforceable against a client:
//   - the PDF itself (text in pdf/CgvPdf.tsx), attached to every devis and
//     confirmation-de-commande email;
//   - the acceptance mention printed on the devis and the confirmation, which
//     names the version so a client cannot argue about which CGV applied.
// ETS Malterre only: Tricotage Malterre shares the confirmation / facture
// templates but has no CGV of its own here — never pass these to a TRM render.
//
// Changing the CGV text = edit CgvPdf.tsx AND bump CGV_VERSION (the mention
// must name the version the client actually received).

import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { CgvPdf, layoutCgv } from './pdf/CgvPdf.js'

/** Version label of the CGV in force, printed on the PDF and in the mention. */
export const CGV_VERSION = 'septembre 2026'

/** Acceptance mention for devis and confirmations de commande (wording
 *  provided by Isabelle Malterre, 2026-09-08). */
export const CGV_MENTION =
  `La commande est soumise aux Conditions Générales de Vente ETS MALTERRE, version ${CGV_VERSION}, ` +
  `dont le Client reconnaît avoir reçu et accepté un exemplaire avant la conclusion de la vente.`

/** Payment mentions required on every invoice (C. com. L. 441-9): late
 *  penalties, the 40 € recovery indemnity and the escompte terms. Values match
 *  article 3 of the CGV. */
export const MENTIONS_PAIEMENT_FACTURE =
  `Pas d'escompte pour paiement anticipé. En cas de retard de paiement, pénalités exigibles de plein droit ` +
  `dès le lendemain de l'échéance au taux égal à trois fois le taux d'intérêt légal, ` +
  `et indemnité forfaitaire pour frais de recouvrement de 40 € (art. L. 441-10 et D. 441-5 du Code de commerce).`

export const CGV_ATTACHMENT_FILENAME = 'CGV - ETS Malterre.pdf'

// The content is static per process lifetime, so render once and cache.
let cgvPdfCache: Promise<Buffer> | null = null

function countPages(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0
}

/** Renders the two-column CGV. The column fill is an estimate (CgvPdf.tsx):
 *  when a column overflowed, react-pdf adds pages beyond the plan, so lay out
 *  again with less text per column until the page count matches. */
async function renderCgv(): Promise<Buffer> {
  let last: Buffer | null = null
  // Fullest columns first (fewest pages); the estimate runs ~15 % high.
  for (let fill = 1.15; fill >= 0.7; fill -= 0.03) {
    const plan = layoutCgv(fill)
    last = await renderToBuffer(
      React.createElement(CgvPdf, { version: CGV_VERSION, plan }) as unknown as React.ReactElement<
        import('@react-pdf/renderer').DocumentProps
      >,
    )
    if (countPages(last) === plan.length) return last
  }
  console.warn('CGV PDF: no column fill matched the page plan — serving the last render')
  return last!
}

export function getCgvPdf(): Promise<Buffer> {
  if (!cgvPdfCache) {
    cgvPdfCache = renderCgv()
    cgvPdfCache.catch(() => { cgvPdfCache = null })
  }
  return cgvPdfCache
}

export async function cgvAttachment(): Promise<{ filename: string; content: Buffer; contentType: string }> {
  return { filename: CGV_ATTACHMENT_FILENAME, content: await getCgvPdf(), contentType: 'application/pdf' }
}
