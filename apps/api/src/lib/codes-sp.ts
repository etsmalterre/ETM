// Writes to `code_sp` (the Simone Pérèle EAN per coloris, LIVA #1200/#1209):
// the one place a code is allocated, so the « Ajouter un coloris » dialog of
// Clients › Gestion and the étude-acceptance hook of Finis › Études coloris
// number the same way and can never hand out the same code twice.
//
// Numbering (Vincent, 2026-09-24): Malterre has no GS1 subscription and owns
// the codes — a new coloris takes the highest code + 1. A code is never
// shared: SP's warehouse scans it, two coloris on one code ship as one.

import { query, fixEncoding } from './hfsql-auto.js'
import { sqlText } from './clients-common.js'
import { ean13FromStored } from './gs1-barcode.js'
import {
  eanKey, nextCodeEan, hasCodeForColoris, spColorisFromLibelle, bainFromLibelle, articleClientFor,
  listEtiquetteClients,
} from './etiquettes-sp.js'

export interface CodeSpFields {
  coloris: string
  code_ean_13: string
  article_client: string
  article_fournisseur: string
  libelle_article: string
  num_bain: string
}

interface StoredCode {
  IDcode_sp: number
  coloris: string
  code_ean_13: string
  article_client: string
  article_fournisseur: string
  libelle_article: string
}

/** Refusal of a code already held by another coloris. */
export class CodeEanPrisError extends Error {
  constructor(public readonly coloris: string, public readonly code: string) {
    super(`Le code ${code} est déjà celui du coloris « ${coloris} ».`)
  }
}

async function loadStored(): Promise<StoredCode[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT IDcode_sp, coloris, code_ean_13, article_client, article_fournisseur, libelle_article FROM code_sp`,
  )
  const fixed = await fixEncoding(rows, 'code_sp', 'IDcode_sp', ['coloris', 'article_client', 'article_fournisseur', 'libelle_article'])
  const str = (v: unknown) => (v ?? '').toString().trim()
  return fixed.map((r) => ({
    IDcode_sp: Number(r.IDcode_sp),
    coloris: str(r.coloris),
    code_ean_13: str(r.code_ean_13),
    article_client: str(r.article_client),
    article_fournisseur: str(r.article_fournisseur),
    libelle_article: str(r.libelle_article),
  }))
}

// Allocation is read-max-then-insert: serialise it in-process so two saves at
// the same moment cannot both take the same number. (A code typed in WinDev's
// « Codes SP » window meanwhile is outside the lock — the duplicate check
// re-reads the list inside it, which is as close as HFSQL lets us get.)
let chain: Promise<unknown> = Promise.resolve()
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn)
  chain = run.catch(() => {})
  return run
}

function assertFree(codes: StoredCode[], code: string, exceptId: number | null): void {
  const key = eanKey(code)
  const holder = codes.find((c) => c.IDcode_sp !== exceptId && eanKey(c.code_ean_13) === key)
  if (holder) throw new CodeEanPrisError(holder.coloris, key)
}

async function insert(d: CodeSpFields): Promise<number> {
  await query(
    `INSERT INTO code_sp (coloris, code_ean_13, article_client, article_fournisseur, libelle_article, num_bain)
     VALUES (${sqlText(d.coloris)}, ${sqlText(d.code_ean_13)}, ${sqlText(d.article_client)}, ${sqlText(d.article_fournisseur)}, ${sqlText(d.libelle_article)}, ${sqlText(d.num_bain)})`,
  )
  const idRows = await query<{ id: number }>(`SELECT MAX(IDcode_sp) AS id FROM code_sp`)
  return Number(idRows[0]?.id) || 0
}

/** The code the next new coloris would get — what the dialog pre-fills. */
export async function peekNextCode(): Promise<string | null> {
  return nextCodeEan((await loadStored()).map((c) => c.code_ean_13))
}

/** Create a code. `auto` = take the next free number now (the dialog's
 *  pre-filled value was only a preview); otherwise the typed code is kept,
 *  unless another coloris holds it. */
export function createCodeSp(d: CodeSpFields, auto: boolean): Promise<{ IDcode_sp: number; code_ean_13: string }> {
  return locked(async () => {
    const codes = await loadStored()
    let code = d.code_ean_13
    if (auto) {
      const next = nextCodeEan(codes.map((c) => c.code_ean_13))
      if (next) code = next
    }
    assertFree(codes, code, null)
    const id = await insert({ ...d, code_ean_13: code })
    return { IDcode_sp: id, code_ean_13: code }
  })
}

/** Update a code; the EAN may not be another coloris'. */
export function updateCodeSp(id: number, d: CodeSpFields): Promise<void> {
  return locked(async () => {
    assertFree(await loadStored(), d.code_ean_13, id)
    await query(
      `UPDATE code_sp SET coloris = ${sqlText(d.coloris)}, code_ean_13 = ${sqlText(d.code_ean_13)},
         article_client = ${sqlText(d.article_client)}, article_fournisseur = ${sqlText(d.article_fournisseur)},
         libelle_article = ${sqlText(d.libelle_article)}, num_bain = ${sqlText(d.num_bain)}
       WHERE IDcode_sp = ${id}`,
    )
  })
}

/** Accepted étude coloris → SP code (LIVA #1209). When the étude's client has
 *  the roll labels switched on and the list has no code for that coloris yet,
 *  add it with the next number, the article fields of the latest row and the
 *  bath implied by the lab/sample numbers. Returns what was created, or null.
 *  Never throws: the acceptance itself must not fail on a label side-effect. */
export async function addCodeForAcceptedEtude(
  idClient: number,
  libelle: string,
): Promise<{ coloris: string; code_ean_13: string; ean13: string | null } | null> {
  try {
    if (!(idClient > 0) || !(await listEtiquetteClients()).includes(idClient)) return null
    const coloris = spColorisFromLibelle(libelle)
    if (!coloris) return null
    return await locked(async () => {
      const codes = await loadStored()
      if (hasCodeForColoris(coloris, codes)) return null
      const code = nextCodeEan(codes.map((c) => c.code_ean_13))
      if (!code) return null
      // The latest row that has its article filled in (a row typed in a
      // hurry would otherwise blank every code created after it).
      const template = [...codes]
        .filter((c) => c.article_fournisseur !== '')
        .sort((a, b) => b.IDcode_sp - a.IDcode_sp)[0]
      await insert({
        coloris,
        code_ean_13: code,
        article_client: articleClientFor(template, coloris),
        article_fournisseur: template?.article_fournisseur ?? '',
        libelle_article: template?.libelle_article ?? '',
        num_bain: bainFromLibelle(libelle),
      })
      return { coloris, code_ean_13: code, ean13: ean13FromStored(code) }
    })
  } catch (err) {
    console.error('Error adding code_sp for accepted étude:', err)
    return null
  }
}
