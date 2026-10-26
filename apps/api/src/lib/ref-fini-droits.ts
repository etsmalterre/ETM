// Who may change what on a finished reference (Finis › Références, decision
// Vincent 2026-10-26). The fiche's form sends EVERY field on « Enregistrer »,
// so a field's presence says nothing: the PUT compares each group with the
// stored row and only asks for the right of a group that really changed.
//
// edit_ref_fini is the parent: it opens « Modifier » and covers the general
// fields. Each other group needs the parent AND its own sub-key. Treatments
// and associated refs have their own routes, guarded on their key directly.

import type { PermissionKey } from './permission-keys.js'

export type GroupeRefFini = 'general' | 'specifications' | 'controles'

const TEXTE = [
  'reference', 'designation', 'conditionnement', 'observations',
  'observation_technique', 'description_commercial', 'responsable',
] as const
const BOOLEEN = [
  'en_developpement', 'controle_sst_rendement', 'controle_sst_stab',
  'controle_sst_allongement', 'controle_ennoblisseur', 'controle_malterre',
] as const

export const GROUPES_REF_FINI: Record<GroupeRefFini, { cle: PermissionKey; champs: readonly string[] }> = {
  general: {
    cle: 'edit_ref_fini',
    champs: [...TEXTE, 'en_developpement'],
  },
  specifications: {
    cle: 'edit_ref_fini_specifications',
    champs: [
      'IDref_ecru', 'rendement', 'freinte', 'temp_lavage',
      'poids_Moy', 'poids_Min', 'poids_Max',
      'laizeHT_Moy', 'laizeHT_Min', 'laizeHT_Max',
      'laizeUtile_Moy', 'laizeUtile_Min', 'laizeUtile_Max',
      'stab_hauteur', 'stab_largeur',
      'allongementH_Min', 'allongementH_Moy', 'allongementH_Max',
      'allongementL_Min', 'allongementL_Moy', 'allongementL_Max',
      'controle_sst_rendement', 'controle_sst_stab', 'controle_sst_allongement',
    ],
  },
  controles: {
    cle: 'edit_ref_fini_controles',
    champs: ['controle_ennoblisseur', 'controle_malterre'],
  },
}

export const LIBELLES_GROUPE: Record<GroupeRefFini, string> = {
  general: 'la référence',
  specifications: 'les spécifications',
  controles: 'les contrôles des lots',
}

/** Same value as stored? Text is compared trimmed with LF line ends (a
 *  textarea hands back LF for the legacy CRLF), an empty number is the 0 the
 *  PUT writes, a flag is its truthiness. */
function memeValeur(champ: string, stocke: unknown, recu: unknown): boolean {
  if ((TEXTE as readonly string[]).includes(champ)) {
    const t = (v: unknown) => String(v ?? '').replace(/\r\n?/g, '\n').trim()
    return t(stocke) === t(recu)
  }
  if ((BOOLEEN as readonly string[]).includes(champ)) {
    const b = (v: unknown) => (typeof v === 'boolean' ? v : Number(v) !== 0)
    return b(stocke) === b(recu)
  }
  const n = (v: unknown) => (v == null || v === '' ? 0 : Number(v))
  return Math.abs(n(stocke) - n(recu)) < 1e-6
}

/** The groups whose fields differ between the stored row and the body. A field
 *  the body leaves out (undefined) is unchanged — the PUT does not write it. */
export function groupesModifies(
  stocke: Record<string, unknown>,
  recu: Record<string, unknown>,
): GroupeRefFini[] {
  return (Object.keys(GROUPES_REF_FINI) as GroupeRefFini[]).filter((g) =>
    GROUPES_REF_FINI[g].champs.some(
      (c) => recu[c] !== undefined && !memeValeur(c, stocke[c], recu[c]),
    ),
  )
}

/** The keys a change of these groups needs: always the parent, plus each
 *  group's own sub-key. */
export function clesRequises(groupes: GroupeRefFini[]): PermissionKey[] {
  const cles = new Set<PermissionKey>(['edit_ref_fini'])
  for (const g of groupes) cles.add(GROUPES_REF_FINI[g].cle)
  return [...cles]
}
