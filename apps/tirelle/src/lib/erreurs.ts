// API refusals → a sentence Laetitia can act on (inline text, never a raw
// code, never a toast). The API already says most of them in French
// (lib/tirelle-labo.ts RefusLabo): its message wins.
import type { ApiError } from '@/lib/api'

export function messagePourErreur(e: ApiError): string {
  switch (e.code) {
    case 'appareil_non_enrole':
      return "Cette tablette n'est pas enrôlée. Prévenez le bureau."
    case 'code_invalide':
      return 'Code inconnu ou expiré. Demandez un nouveau code au bureau.'
    case 'trop_d_essais':
      return "Trop d'essais. Attendez un quart d'heure avant de réessayer."
  }
  if (e.detail) return e.detail
  switch (e.status) {
    case 401:
      return "Cette tablette n'est pas enrôlée. Prévenez le bureau."
    case 409:
      return "Le lot a changé entre-temps. Vérifiez l'écran, puis recommencez."
    default:
      return "Ce n'a pas été enregistré. Réessayez ; si ça recommence, prévenez le bureau."
  }
}
