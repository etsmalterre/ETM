// The rapport de contrôle rides with the stabilités soumission (LIVA #1349,
// decision Vincent 2026-11-05). Lemahieu's lab wanted our measures in the
// parcel of the tirelle: the soumission mail to the dyer then carries the
// client's RC, and asks the dyer to print it and put it with the tirelle.
//
// Rules:
//  - Only a STABILITÉS soumission: the coloris one leaves before the reception,
//    no measure exists yet.
//  - Only when the client is OWED the RC (switched « rapport de contrôle »,
//    pieces of the lot, none valid since the last reprise, not dispensed —
//    lib/rapport-controle-lot.ts) and our own control of the tirelle is
//    complete (the RC prints the Malterre measures).
//  - Offered pre-ticked in the dialog, with one sentence in the body; the person
//    may untick it and delete the sentence.
//  - The send counts as the RC sent to the client only when one of the client's
//    addresses is in To / Cc (the client's soumission contacts are in Cc by
//    default): the client then has the PDF by mail too. Removed from the copy,
//    the RC stays owed — the dyer's parcel is no proof the client got it.

import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { mpsPg } from './mps-pg.js'
import { cleLot, lireCommandesEnnoblissement } from './cycle-ennoblissement.js'
import { clientsDesLots, cleLotLigne, rapportControleLot, type RapportControleLot } from './rapport-controle-lot.js'
import { RapportControlePdf } from './pdf/RapportControlePdf.js'
import type { NatureSoumission } from './soumission-lot.js'

/** The sentence added to the soumission mail when the RC is attached. */
export const PHRASE_RC_SOUMISSION = 'Merci d’imprimer le rapport de contrôle ci-joint et de le joindre à la tirelle.'

/** Id of the dialog's optional attachment (web QualiteSuiviLots). */
export const PIECE_RC = 'rapport-controle'

/** Does the soumission carry the RC? Pure. */
export function rcJointASoumission(f: {
  nature: NatureSoumission
  recu: boolean
  tirelleMesuree: boolean
  clientDoitRc: boolean
}): boolean {
  return f.nature === 'stabilites' && f.recu && f.tirelleMesuree && f.clientDoitRc
}

/** The client is among the recipients: one of its addresses in To / Cc. Pure. */
export function clientEnCopie(destinataires: readonly string[], adressesClient: ReadonlySet<string>): boolean {
  return destinataires.some((d) => adressesClient.has(d.trim().toLowerCase()))
}

/** The RC to attach to this soumission, or null (see the rules above). */
export async function rcPourSoumission(p: {
  commandeId: number
  ligneId: number
  lot: string
  idclient: number
  nature: NatureSoumission
}): Promise<RapportControleLot | null> {
  if (p.nature !== 'stabilites' || !(p.ligneId > 0) || !(p.idclient > 0)) return null
  const cmd = (await lireCommandesEnnoblissement([p.commandeId])).get(p.commandeId)
  const fait = cmd?.lots.find((l) => l.idligne === p.ligneId && cleLot(l.lot) === cleLot(p.lot))
  if (!fait || !(fait.idsuivilot > 0)) return null
  const clients = (await clientsDesLots([{ ligne: p.ligneId, lot: fait.lot }])).get(cleLotLigne(p.ligneId, fait.lot)) ?? []
  const client = clients.find((c) => c.idclient === p.idclient)
  const joint = rcJointASoumission({
    nature: p.nature,
    recu: !!fait.reception,
    tirelleMesuree: fait.tirelleMesuree,
    clientDoitRc: client?.du === true,
  })
  return joint ? rapportControleLot(fait.idsuivilot, p.idclient) : null
}

/** Every address of the client's contacts, lower-cased. */
export async function adressesDuClient(idclient: number): Promise<Set<string>> {
  const rows = await mpsPg()<{ mail: string | null }[]>`
    SELECT mail::text AS mail FROM contact WHERE idclient = ${idclient}`
  return new Set(rows.map((r) => (r.mail ?? '').trim().toLowerCase()).filter(Boolean))
}

export async function renderRapportControle(rc: RapportControleLot): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(RapportControlePdf, { data: rc.data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

export const nomFichierRc = (rc: RapportControleLot) => `rapport-controle-${rc.lot.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`
