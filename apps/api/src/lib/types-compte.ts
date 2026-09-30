// The three kinds of account (`utilisateur.type_compte`, migrations 0001 +
// 0005) and what each may hold. Pure rules, tested in types-compte.test.ts.
//
//   personne  — a person: password login, apps, rights, e-mails.
//   poste     — a station PC that USES an app (Visitage…): no password, it
//               enrols through a one-time code (lib/postes.ts); its Écrans /
//               Permissions decide what whoever sits there sees.
//   appareils — devices that run their OWN app (atelier phones, pointeuses —
//               lib/appareils-atelier.ts). No login, member of NO app, no
//               rights: an enrolled device acts as its account on every route
//               (lib/auth.ts attachUser), so the account must carry nothing
//               into the ERP. Being enrolled is the device's right to write.

import type { AppCode } from './utilisateur-apps.js'

export type TypeCompte = 'personne' | 'poste' | 'appareils'
export const TYPES_COMPTE: readonly TypeCompte[] = ['personne', 'poste', 'appareils']

/** What can be enrolled under an account: a PC only under a poste; a phone or
 *  a pointeuse under an appareils account — or, until the régleurs' phones
 *  move under it (plan « point 4 », on site), under a person who is a TRM
 *  member. Never under a poste: the device would carry its screens' rights. */
export type TypeEnrolement = 'pc' | 'atelier' | 'pointeuse'

export function enrolementsPossibles(type: TypeCompte, apps: readonly AppCode[]): TypeEnrolement[] {
  if (type === 'poste') return ['pc']
  if (type === 'appareils') return ['atelier', 'pointeuse']
  return apps.includes('trm') ? ['atelier', 'pointeuse'] : []
}

/** Why this account cannot hold `apps`, or null. An appareils account holds
 *  none; the others at least one (to shut one out of both, deactivate it). */
export function refusAppsDuType(type: TypeCompte, apps: readonly AppCode[]): string | null {
  if (type === 'appareils') {
    return apps.length ? 'Un compte d’appareils n’appartient à aucune application : ses appareils ont la leur.' : null
  }
  if (apps.length === 0) {
    return 'Un compte appartient au moins à une application. Pour lui retirer tout accès, désactivez le compte.'
  }
  return null
}
