// « Ajouter un coloris existant » on a finished reference (LIVA #1359).
//
// Until now a dyed coloris was born only from an accepted étude coloris on
// THAT reference (routes/etudes-coloris.ts). The legacy let people copy a
// coloris by hand, and they did: 351 recipes sit on several references. Here
// the copy is offered only between references whose écru has the same fibre
// families (lib/familles-fibres.ts), the dyer comes with the recipe (a MATEL
// recipe is not a TAD one), the dye level follows the TARGET reference, and
// the copy remembers where it came from (coloris_fini_reprise).

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { partsParEcru, signatureFamilles, libelleSignature, type Signature } from './familles-fibres.js'

export interface RefUtilisant {
  IDref_fini: number
  reference: string
  contexture: string | null
}

export interface ColorisReprenable {
  /** The coloris copied when this entry is picked (the most recent one). */
  IDref_fini_colori: number
  reference: string
  IDsous_traitant: number
  sous_traitant: string | null
  /** The reference the copy is taken from. */
  ref_source: string
  meme_contexture: boolean
  refs: RefUtilisant[]
}

export interface Reprenables {
  signature: Signature
  familles: string
  contexture: string | null
  candidats: ColorisReprenable[]
}

export class RepriseRefusee extends Error {
  constructor(public code: string, message: string) { super(message) }
}

const cleNom = (s: string): string => s.trim().toLowerCase()

/** A placeholder name, not a recipe (same pattern as scripts/nettoyer-coloris-fictifs.ts). */
export const COLORIS_FICTIF = /(^|\s)[àa] ([ée]tudier|d[ée]finir)|\ben [ée]tude\b|[ée]tude coloris/i

/** The dye level a new coloris takes from its reference (same rule as an
 *  accepted étude): simple → « Tous Coloris simple » (7), double → 5. */
export function teintureParDefaut(avecTeinture: number): number {
  return avecTeinture === 1 ? 7 : avecTeinture === 2 ? 5 : 0
}

interface RefCible { idref_fini: number; idref_ecru: number; avec_teinture: number; idcontexture: number; contexture: string | null }

async function refCible(idRefFini: number): Promise<RefCible> {
  const sql = mpsPg()
  const [r] = await sql<RefCible[]>`
    SELECT f.idref_fini, f.idref_ecru, f.avec_teinture, COALESCE(e.idcontexture, 0) AS idcontexture, ct.nom::text AS contexture
    FROM ref_fini f
    LEFT JOIN ref_ecru e ON e.idref_ecru = f.idref_ecru
    LEFT JOIN contexture ct ON ct.idcontexture = e.idcontexture
    WHERE f.idref_fini = ${idRefFini}`
  if (!r) throw new RepriseRefusee('introuvable', 'Référence introuvable.')
  if (!(Number(r.avec_teinture) > 0)) {
    throw new RepriseRefusee('sans_teinture', 'Cette référence n’est pas teinte : ses coloris sont ceux de son écru (Tombé Métier).')
  }
  return r
}

async function signatureEcru(idRefEcru: number): Promise<Signature> {
  const parts = await partsParEcru([idRefEcru])
  return signatureFamilles(parts.get(idRefEcru) ?? [])
}

/** The coloris another dyed reference with the same fibre families already
 *  carries, one entry per recipe (name) and dyer, minus what the target holds. */
export async function colorisReprenables(idRefFini: number): Promise<Reprenables> {
  const cible = await refCible(idRefFini)
  const signature = await signatureEcru(cible.idref_ecru)
  const base = { signature, familles: libelleSignature(signature), contexture: cible.contexture?.trim() || null }
  if (!signature.connue) return { ...base, candidats: [] }

  const parEcru = await partsParEcru()
  const ecrus: number[] = []
  for (const [id, parts] of parEcru) {
    const s = signatureFamilles(parts)
    if (s.connue && s.cle === signature.cle) ecrus.push(id)
  }
  if (ecrus.length === 0) return { ...base, candidats: [] }

  const sql = mpsPg()
  const [deja, rows] = await Promise.all([
    sql<{ reference: string | null }[]>`SELECT reference::text AS reference FROM ref_fini_colori WHERE idref_fini = ${idRefFini}`,
    sql<{
      idref_fini_colori: number; reference: string; idsous_traitant: number; sous_traitant: string | null
      idref_fini: number; ref_fini: string; idcontexture: number; contexture: string | null
    }[]>`
      SELECT c.idref_fini_colori, trim(c.reference::text) AS reference, c.idsous_traitant, st.nom::text AS sous_traitant,
             f.idref_fini, trim(f.reference::text) AS ref_fini, COALESCE(e.idcontexture, 0) AS idcontexture, ct.nom::text AS contexture
      FROM ref_fini_colori c
      JOIN ref_fini f ON f.idref_fini = c.idref_fini
      JOIN ref_ecru e ON e.idref_ecru = f.idref_ecru
      LEFT JOIN contexture ct ON ct.idcontexture = e.idcontexture
      LEFT JOIN sous_traitant st ON st.idsous_traitant = c.idsous_traitant
      WHERE f.idref_ecru = ANY(${ecrus}) AND f.avec_teinture > 0 AND f.idref_fini <> ${idRefFini}
        AND trim(COALESCE(c.reference::text, '')) <> ''
      ORDER BY c.idref_fini_colori DESC`,
  ])
  const presents = new Set(deja.map((d) => cleNom(d.reference ?? '')))

  const parCle = new Map<string, ColorisReprenable>()
  for (const r of rows) {
    if (presents.has(cleNom(r.reference)) || COLORIS_FICTIF.test(r.reference)) continue
    const cle = `${cleNom(r.reference)}|${r.idsous_traitant}`
    let c = parCle.get(cle)
    if (!c) {
      // Rows come newest first: the first one met is the copy's source.
      c = {
        IDref_fini_colori: r.idref_fini_colori,
        reference: r.reference,
        IDsous_traitant: r.idsous_traitant,
        sous_traitant: r.sous_traitant?.trim() || null,
        ref_source: r.ref_fini,
        meme_contexture: false,
        refs: [],
      }
      parCle.set(cle, c)
    }
    if (!c.refs.some((x) => x.IDref_fini === r.idref_fini)) {
      c.refs.push({ IDref_fini: r.idref_fini, reference: r.ref_fini, contexture: r.contexture?.trim() || null })
    }
    if (cible.idcontexture > 0 && r.idcontexture === cible.idcontexture) c.meme_contexture = true
  }
  const candidats = [...parCle.values()]
  for (const c of candidats) c.refs.sort((a, b) => a.reference.localeCompare(b.reference, 'fr'))
  candidats.sort((a, b) =>
    Number(b.meme_contexture) - Number(a.meme_contexture)
    || b.refs.length - a.refs.length
    || a.reference.localeCompare(b.reference, 'fr'))
  return { ...base, candidats }
}

/** Copy one coloris onto the reference. Every check is redone here: the
 *  dialog's list may be stale, and a direct call must not bypass the rule. */
export async function reprendreColoris(
  idRefFini: number,
  idSource: number,
  par: { id: number; nom: string | null },
): Promise<{ IDref_fini_colori: number; reference: string }> {
  const cible = await refCible(idRefFini)
  const sql = mpsPg()
  const [source] = await sql<{ idref_fini_colori: number; idref_fini: number; reference: string; idsous_traitant: number; idref_ecru: number; avec_teinture: number }[]>`
    SELECT c.idref_fini_colori, c.idref_fini, trim(c.reference::text) AS reference, c.idsous_traitant, f.idref_ecru, f.avec_teinture
    FROM ref_fini_colori c JOIN ref_fini f ON f.idref_fini = c.idref_fini
    WHERE c.idref_fini_colori = ${idSource}`
  if (!source || !source.reference) throw new RepriseRefusee('source_introuvable', 'Ce coloris n’existe plus.')
  if (COLORIS_FICTIF.test(source.reference)) throw new RepriseRefusee('fictif', `« ${source.reference} » n’est pas une recette : il faut une étude coloris.`)
  if (source.idref_fini === idRefFini) throw new RepriseRefusee('deja_present', 'Ce coloris est déjà sur cette référence.')

  const [sCible, sSource] = await Promise.all([signatureEcru(cible.idref_ecru), signatureEcru(source.idref_ecru)])
  if (!sCible.connue || !sSource.connue || sCible.cle !== sSource.cle) {
    throw new RepriseRefusee(
      'familles_differentes',
      `Les fibres ne sont pas de la même famille (${libelleSignature(sCible) || 'inconnues'} ici, ${libelleSignature(sSource) || 'inconnues'} sur la référence d’origine) : il faut une étude coloris.`,
    )
  }

  return sql.begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    // Serialise copies onto the same reference so two clicks cannot both pass
    // the duplicate check.
    await tx`SELECT pg_advisory_xact_lock(1359, ${idRefFini}::int)`
    const deja = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ref_fini_colori
      WHERE idref_fini = ${idRefFini} AND lower(trim(reference::text)) = ${cleNom(source.reference)}`
    if (deja[0].n > 0) throw new RepriseRefusee('deja_present', `« ${source.reference} » est déjà sur cette référence.`)
    const [cree] = await tx<{ idref_fini_colori: number }[]>`
      INSERT INTO ref_fini_colori (idref_fini, idsous_traitant, idteinture, reference, observations)
      VALUES (${idRefFini}, ${source.idsous_traitant}, ${teintureParDefaut(Number(cible.avec_teinture))}, ${source.reference}, '')
      RETURNING idref_fini_colori`
    await tx`
      INSERT INTO coloris_fini_reprise (idref_fini_colori, idref_fini, idref_fini_colori_source, idref_fini_source, reference_source, par_id, par)
      VALUES (${cree.idref_fini_colori}, ${idRefFini}, ${source.idref_fini_colori}, ${source.idref_fini},
              (SELECT trim(reference::text) FROM ref_fini WHERE idref_fini = ${source.idref_fini}), ${par.id}, ${par.nom})`
    return { IDref_fini_colori: cree.idref_fini_colori, reference: source.reference }
  }) as Promise<{ IDref_fini_colori: number; reference: string }>
}

/** Where each copied coloris of a reference came from: id → « 224A ». */
export async function originesColoris(idRefFini: number): Promise<Map<number, { reference_source: string; le: string; par: string | null }>> {
  const rows = await mpsPg()<{ idref_fini_colori: number; reference_source: string; le: Date; par: string | null }[]>`
    SELECT idref_fini_colori, reference_source, le, par FROM coloris_fini_reprise WHERE idref_fini = ${idRefFini}`
  return new Map(rows.map((r) => [r.idref_fini_colori, { reference_source: r.reference_source, le: r.le.toISOString(), par: r.par }]))
}
