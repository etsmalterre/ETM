// A document attached to a sous-traitant order (`ged`). Shared by the upload
// route (routes/commandes-sous-traitant.ts) and the BL agent
// (lib/agents/bl-ennoblisseur-db.ts), so both write the same row shape — the one the
// legacy and the WebDev service wrote: IDreference = the order id,
// IDcommande_client = 0, IDdossier = 0.

import { query, queryRaw } from './hfsql-auto.js'
import { esc } from './sst-shared.js'

/** Insert a ged row on sst order `commandeId` and store `fichier` in it.
 *  Returns the new IDged. No RETURNING on HFSQL: the newest matching row is read back. */
export async function insertGedSst(opts: {
  commandeId: number
  nom: string
  commentaire?: string
  idTypeDoc: number
  fichier?: Buffer | null
}): Promise<number> {
  const id = Math.trunc(opts.commandeId)
  const typeDoc = Math.trunc(opts.idTypeDoc)
  await query(
    `INSERT INTO ged (nom, commentaire, IDtype_doc, IDreference, IDcommande_client, IDcommande_sous_traitant, IDdossier)
     VALUES ('${esc(opts.nom)}', '${esc(opts.commentaire ?? '')}', ${typeDoc}, ${id}, 0, ${id}, 0)`,
  )
  const rows = await query<{ IDged: number }>(
    `SELECT IDged FROM ged
     WHERE IDcommande_sous_traitant = ${id}
       AND IDcommande_client = 0
       AND IDtype_doc = ${typeDoc}
     ORDER BY IDged DESC`,
  )
  if (rows.length === 0) throw new Error('ged insert lookup failed')
  const newId = Number(rows[0].IDged)
  if (opts.fichier && opts.fichier.length > 0) {
    await queryRaw(`UPDATE ged SET fichier = x'${opts.fichier.toString('hex')}' WHERE IDged = ${newId}`)
  }
  return newId
}
