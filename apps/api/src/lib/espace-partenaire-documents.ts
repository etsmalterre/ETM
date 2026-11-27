// The partner's OWN delivery papers on one of its orders, as the espace partenaire hands them back (Vincent
// 2026-11-27: « mettre le document BL à disposition ») — served inside the order's and the lot's detail and by
// GET /api/site/espace/partenaires/:id/commandes/:idCommande/documents/:idDoc (lib/espace-partenaire-commandes.ts
// scopes all three to the partner).
//
// A BL is filed on the ORDER (`ged`, type 3 « BL retour ennoblisseur »); nothing but its NAME ties it to a lot.
// Two hands file under that type:
//   - the agent « BL Ennoblisseur » (lib/agents/bl-ennoblisseur-db.ts `classerPdf`, n8n before it): the PDF the
//     dyer e-mailed, named after the lot — `MA109152.pdf`, `MA109269B.pdf` (a later bordereau of the same lot),
//     `…-reprise[N].pdf`, `…-rectifie.pdf`, `…-dispo.pdf` (TAD's mise à disposition), `…-2.pdf` (a further page);
//   - people, from the order's Documents tab, with a name of their own (« bl », « BL Matel », « 108084 - tableau
//     métrage 15 noir.doc »).
// Only the first kind is the partner's paper for sure. Measured on MATEL's orders of twelve months (2026-11-27):
// 747 documents of the type, 701 named the agent's way; of eight of the others opened that day, two were
// Malterre's own « tableau de métrage », one printing a CUSTOMER's order number.
//
// So this is a CLOSED list, like the journal's (lib/espace-partenaire-journal.ts): a document is handed out only
// when its name is exactly one the agent writes for a lot known on the order — `.pdf` included, which a name
// typed by hand does not carry — and its content is a PDF. Never add: a document of another type (invoices,
// « autre », certificates), one named any other way, the ged `commentaire`, who filed it. A new naming in
// `nomGed` / `resoudreBl` / `classerPdf` reaches the partner only once listed in `documentDuLot`.

import { mpsPg } from './mps-pg.js'
import { GED_TYPE_BL_ENNOBLISSEUR } from './agents/bl-ennoblisseur-db.js'

export type GenreDocumentPartenaire = 'bl' | 'bl_reprise' | 'bl_rectifie' | 'mise_a_dispo'

export interface DocumentPartenaire {
  /** IDged — the key the file is asked by. */
  id: number
  genre: GenreDocumentPartenaire
  /** The lot it is about, as the order knows it. */
  lot: string
  /** A later bordereau of the same lot: its letter (« B »); null for the first. */
  bordereau: string | null
  /** Which reprise it comes back from (2 = the second), when the name says so. */
  rang: number | null
  /** 1, or the page of a BL filed page by page. */
  page: number
}

const echappe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** What a ged name says, when it is one the BL agent writes for one of `lots`; null otherwise. Pure. */
export function documentDuLot(nom: string, lots: readonly string[]): Omit<DocumentPartenaire, 'id'> | null {
  const n = nom.trim()
  // The longest lot first: « MA10891 » must not claim « MA108914.pdf ».
  for (const lot of [...new Set(lots.map((l) => l.trim()).filter(Boolean))].sort((a, b) => b.length - a.length)) {
    const l = echappe(lot)
    let m = new RegExp(`^${l}-dispo(?:-(\\d+))?\\.pdf$`, 'i').exec(n)
    if (m) return { genre: 'mise_a_dispo', lot, bordereau: null, rang: null, page: page(m[1]) }
    m = new RegExp(`^${l}([B-Z])?(?:-(reprise)(\\d*)|-(rectifie))?(?:-(\\d+))?\\.pdf$`, 'i').exec(n)
    if (m) {
      return {
        genre: m[2] ? 'bl_reprise' : m[4] ? 'bl_rectifie' : 'bl',
        lot,
        bordereau: m[1] ? m[1].toUpperCase() : null,
        rang: m[3] ? Number(m[3]) : null,
        page: page(m[5]),
      }
    }
  }
  return null
}

/** `classerPdf` numbers the pages after the first from 2. */
function page(s: string | undefined): number {
  const n = Number(s)
  return Number.isInteger(n) && n >= 2 ? n : 1
}

/** The lots the BL agent read on the order's lines (data_bl_tricotbot): a BL is filed when its e-mail is read,
 *  before the reception gives the lot its suivi lot row. */
async function lotsLus(idsLignes: readonly number[]): Promise<string[]> {
  if (idsLignes.length === 0) return []
  const rows = await mpsPg()<{ lot: string | null }[]>`
    SELECT DISTINCT trim(lot::text) AS lot FROM data_bl_tricotbot WHERE idligne_commande_sous_traitant = ANY(${[...idsLignes]})`
  return rows.map((r) => (r.lot ?? '').trim()).filter(Boolean)
}

/** The partner's papers on the order, in the order they were filed. `lots`: the lots the order already knows;
 *  `idsLignes`: its lines. The caller has checked the order is this partner's. */
export async function documentsCommande(idCommande: number, lots: readonly string[], idsLignes: readonly number[]): Promise<DocumentPartenaire[]> {
  const [rows, lus] = await Promise.all([
    mpsPg()<{ id: number; nom: string | null }[]>`
      SELECT idged::bigint AS id, trim(nom::text) AS nom FROM ged
      WHERE idcommande_sous_traitant = ${idCommande} AND idtype_doc = ${GED_TYPE_BL_ENNOBLISSEUR} AND fichier IS NOT NULL
      ORDER BY idged`,
    lotsLus(idsLignes),
  ])
  const connus = [...lots, ...lus]
  return rows.flatMap((r) => {
    const d = documentDuLot(r.nom ?? '', connus)
    return d ? [{ id: Number(r.id), ...d }] : []
  })
}

/** The file of a document already found by documentsCommande, or null when it is not a PDF. */
export async function fichierDocument(idDoc: number): Promise<Buffer | null> {
  const [r] = await mpsPg()<{ fichier: Buffer | null }[]>`SELECT fichier FROM ged WHERE idged = ${idDoc}`
  const f = r?.fichier ? Buffer.from(r.fichier) : null
  return f && f.subarray(0, 5).toString('latin1') === '%PDF-' ? f : null
}

/** The name the file is handed out under: the partner's own lot, never the ged name. */
export function nomFichier(d: Omit<DocumentPartenaire, 'id'>): string {
  const lot = d.lot.replace(/[^A-Za-z0-9_-]/g, '') + (d.bordereau ?? '')
  const genre = d.genre === 'mise_a_dispo' ? 'mise-a-disposition' : d.genre === 'bl_reprise' ? 'bl-reprise' : d.genre === 'bl_rectifie' ? 'bl-rectifie' : 'bl'
  return `${genre}-${lot}${d.page > 1 ? `-p${d.page}` : ''}.pdf`
}
