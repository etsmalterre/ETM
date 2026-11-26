// A maille on a piece that will be OPENED AT WIDTH (ouvert au large) — the
// workshop's own rule, structured here instead of typed into every consigne.
//
// The roll is slit open lengthwise before it ships, so ONE dropped stitch is
// not a defect: the bonnetier lets it run to the end of the piece and the roll
// is opened along it. A SECOND one cannot be absorbed the same way: the roll is
// cut there, the maille to open along is marked, and the needle is repaired
// before the next piece.
//
// History: the WinDev app appended « Max 1 maille jusqu'à la fin de la pièce.
// Réparer à chaque nouvelle pièce » to the consigne of every OF created with
// « Ouvert au large » ticked (197 of the 198 such OFs between 2024-11 and
// 2026-07). The web port of OF creation dropped it in 2026-08 and nobody
// noticed (0 of the next 32). Vincent, 2026-11-26: it is a rule of the trade,
// not a per-OF instruction — it belongs in the platform, and the consigne stays
// for what is particular to an OF (LIVA #1395).
//
// This file is the ONE place the rule and its wording live. The phone renders
// what it is handed (`contexte.maille`), the API re-decides on every write, and
// the visitage poste asks `estMailleCoulee()` — nobody else spells the strings.

/** How many mailles a piece opened at width may carry to its end. The legacy
 *  sentence's « Max 1 maille ». */
export const MAX_MAILLES_COULEES_PAR_PIECE = 1

/** What the bonnetier must do with the maille they are declaring. */
export type ConduiteMaille = 'couler' | 'couper'

/** Stored in `defaut_qualite.description`. `type_defaut` stays « Maille », so
 *  every reader keyed on the type (units, pies, prime) is untouched. */
export const DESCRIPTION_MAILLE_COULEE = 'Maille coulée'
/** Plain punctuation on purpose: an em dash does not survive the HFSQL
 *  round-trip (it reads back as a hyphen). */
export const DESCRIPTION_MAILLE_COUPEE = 'Maille (rouleau coupé)'

/** `taille_cm` of a maille left to run. The terminals have always written the
 *  bucket code of « Toute la pièce » for it (118 of the 167 mailles the
 *  visitage marked récupérée on open-width OFs) — same value, so the history
 *  and the new rows read alike. */
export const TAILLE_CM_MAILLE_COULEE = 999

export interface GuideMaille {
  conduite: ConduiteMaille
  /** The sheet's instruction block: a heading and one sentence. */
  titre: string
  consigne: string
  /** Label of the sheet's commit button. */
  bouton: string
  /** True when the roll is cut: the piece ends here, so the phone goes on to
   *  the fin de pièce confirmation once the maille is recorded. */
  puis_fin_de_piece: boolean
}

export interface ContexteMaille {
  /** `ordre_fabrication.ouvert_visiteuse = 1` — the OF's own box, not the
   *  reference's default it was seeded from. */
  ouvertLarge: boolean
  /** A piece is on the machine (the last piece row is not closed). */
  pieceOuverte: boolean
  /** Mailles already declared on that piece, whoever declared them and from
   *  which terminal. */
  mailles: number
}

/** The guide for the NEXT maille declared on this piece, or null when the rule
 *  does not apply (tubular OF, or no piece on the machine) and the phone asks
 *  for a length as it always has. */
export function guideMaille(ctx: ContexteMaille): GuideMaille | null {
  if (!ctx.ouvertLarge || !ctx.pieceOuverte) return null
  if (ctx.mailles < MAX_MAILLES_COULEES_PAR_PIECE) {
    return {
      conduite: 'couler',
      titre: 'Pièce ouverte au large',
      consigne:
        "Laissez couler la maille jusqu'à la fin de la pièce : le rouleau sera ouvert dedans. Réparez avant de lancer la pièce suivante.",
      bouton: 'Laisser couler la maille',
      puis_fin_de_piece: false,
    }
  }
  return {
    conduite: 'couper',
    titre: 'Deuxième maille sur cette pièce',
    consigne:
      'Coupez le rouleau maintenant et marquez la maille dans laquelle ouvrir. Réparez avant de relancer.',
    bouton: 'Couper le rouleau',
    puis_fin_de_piece: true,
  }
}

/** Shown on the fin de pièce confirmation of a piece that carries a maille:
 *  the other half of the legacy sentence (« Réparer à chaque nouvelle pièce »). */
export function rappelFinDePiece(ctx: ContexteMaille): string | null {
  if (!ctx.ouvertLarge || !ctx.pieceOuverte || ctx.mailles < 1) return null
  return 'Réparez la maille avant de lancer la pièce suivante.'
}

/** What a guided maille writes to `defaut_qualite`.
 *
 *  A maille left to run is the line the roll is opened along: it is recorded
 *  already « récupérée », the flag the visiteuse sets by hand today, and she
 *  can still take it back at the poste. A cut one is an ordinary maille of
 *  unknown length — the visiteuse measures what is left of it in the roll. */
export function ecritureMaille(conduite: ConduiteMaille): {
  description: string
  taille_cm: number
  recupere: 0 | 1
} {
  return conduite === 'couler'
    ? { description: DESCRIPTION_MAILLE_COULEE, taille_cm: TAILLE_CM_MAILLE_COULEE, recupere: 1 }
    : { description: DESCRIPTION_MAILLE_COUPEE, taille_cm: 0, recupere: 0 }
}

const plie = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/** True for a defect row written by the « laisser couler » rail — the visitage
 *  poste labels it « Maille coulée » rather than « Maille ». */
export function estMailleCoulee(description: string | null | undefined): boolean {
  return plie(description) === plie(DESCRIPTION_MAILLE_COULEE)
}
