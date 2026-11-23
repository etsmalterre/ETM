// Catalog of Expe permission keys: the gated actions of the shipping and
// transfer tracking app (expe.intra.etsmalterre.com, repo expe), managed from
// the Console Administration › Utilisateurs › EXPE.
//
// A SEPARATE catalog from permission-keys.ts (ETM's) and permission-keys-trm.ts
// (TRM's), for the reason their headers give: each admin screen renders its
// whole catalog and replaces a user's whole key list on save, so a shared
// catalog or store would let one app strip another's grants. Grants live in
// their own store (lib/permissions-expe.ts, table `permission`, app = 'expe').
//
// Adding a gated Expe action (same contract as the two ERPs):
//   1. Append an entry to EXPE_PERMISSION_KEYS below
//   2. Gate the API route via expeUserHasPermission(...)
//   3. Hide the UI element via useHasPermission('...') in the Expe app (its
//      PermissionsProvider reads /api/permissions-expe/me)
//
// Keys are flat snake_case strings stored verbatim: never rename one without a
// migration. A name may coincide with an ERP's (the stores are separate).

export const EXPE_PERMISSION_KEYS = [
  // Agents IA: Expe's agents and automates, in the Console Administration.
  // Same keys as ETM's and TRM's, in Expe's store: reading needs only the
  // console (lib/console-acces.ts); every write of /api/agents-ia-expe and
  // /api/automates-expe checks these (lib/agents/app-scope.ts AGENTS_IA_EXPE).
  {
    key: 'edit_agents_ia',
    label: 'Piloter les agents IA et les automates',
    description:
      'Autorise, dans la console Administration › Agents IA et Automates, à mettre un agent ou un automate d’Expéditions en service, en essai ou à l’arrêt, à le relancer et à écrire les retours sur un automate. Sans ce droit les écrans sont en lecture seule.',
    category: 'Agents IA',
  },
  {
    key: 'evaluer_agents_ia',
    label: 'Évaluer les agents IA',
    description:
      'Réservé aux retours à Tricobot. Les agents IA ne se notent jamais dans Agents IA : chaque retour (juste, ou corrigé avec un pourquoi) se donne là où le travail se fait.',
    category: 'Agents IA',
  },
] as const

export type ExpePermissionKey = (typeof EXPE_PERMISSION_KEYS)[number]['key']

/** Set of all known Expe keys for fast membership checks during validation. */
export const KNOWN_EXPE_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  EXPE_PERMISSION_KEYS.map((p) => p.key),
)

export function isKnownExpePermissionKey(k: string): k is ExpePermissionKey {
  return KNOWN_EXPE_PERMISSION_KEYS.has(k)
}
