// Documents attached to a yarn reference (Fils › Références, « Documents » tab):
// supplier technical sheets, certificates, anything tied to the yarn itself
// rather than to one order or one lot.
//
// Stored in the shared `ged` table like every other document, with
// `IDreference = IDref_fil` and IDcommande_client = IDcommande_sous_traitant =
// IDdossier = 0. `ged.IDreference` is polymorphic and its meaning is decided by
// `IDtype_doc` (claude_doc/hfsql_odbc.md), so a ref fil document needs type_doc
// values used by NO other parent — reusing `2 autre` would mix these rows with
// commande_fil documents whose IDcommande_fil happens to equal the IDref_fil.
// The legacy had no documents on a ref fil, so these types are ours:
//   31 fiche technique fil · 32 certificat fil · 33 autre ref fil
// 30 is deliberately skipped: `scripts/migrate-revert-type-doc-30.ts` (idempotent,
// "safe to re-run") deletes type_doc 30.
//
// The rows are created on first use (`ensureRefFilDocTypes`) with explicit ids,
// so no deploy step can be forgotten and every environment gets the same ids.

import { query } from './hfsql-auto.js'

export const REF_FIL_DOC_TYPES = [
  { IDtype_doc: 31, nom: 'fiche technique fil', libelle: 'Fiche technique' },
  { IDtype_doc: 32, nom: 'certificat fil', libelle: 'Certificat' },
  { IDtype_doc: 33, nom: 'autre ref fil', libelle: 'Autre' },
] as const

export const REF_FIL_DOC_TYPE_IDS = REF_FIL_DOC_TYPES.map((t) => t.IDtype_doc)
export const REF_FIL_DOC_TYPES_SQL = REF_FIL_DOC_TYPE_IDS.join(', ')
export const DEFAULT_REF_FIL_DOC_TYPE = 31

/** UI label of a ref fil document type (type_doc.nom is a technical name). */
export function refFilDocTypeLabel(id: number): string | null {
  return REF_FIL_DOC_TYPES.find((t) => t.IDtype_doc === id)?.libelle ?? null
}

export function isRefFilDocType(id: number): boolean {
  return (REF_FIL_DOC_TYPE_IDS as readonly number[]).includes(id)
}

let ensured: Promise<void> | null = null

/** Create the missing type_doc rows. Refuses (throws) when an id is already
 *  taken by a different type — writing ged rows under someone else's type
 *  would silently mix two parents. Memoised; a failure is retried next call. */
export function ensureRefFilDocTypes(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      const rows = await query<{ IDtype_doc: number; nom: string | null }>(
        `SELECT IDtype_doc, nom FROM type_doc WHERE IDtype_doc IN (${REF_FIL_DOC_TYPES_SQL})`,
      )
      const existing = new Map(rows.map((r) => [Number(r.IDtype_doc), (r.nom ?? '').trim()]))
      for (const t of REF_FIL_DOC_TYPES) {
        const nom = existing.get(t.IDtype_doc)
        if (nom === undefined) {
          await query(`INSERT INTO type_doc (IDtype_doc, nom) VALUES (${t.IDtype_doc}, '${t.nom}')`)
        } else if (nom !== t.nom) {
          throw new Error(`type_doc ${t.IDtype_doc} is "${nom}", expected "${t.nom}"`)
        }
      }
    })().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}
