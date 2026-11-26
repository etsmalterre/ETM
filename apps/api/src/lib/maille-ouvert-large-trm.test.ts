import { describe, expect, it } from 'vitest'
import {
  DESCRIPTION_MAILLE_COULEE,
  MAX_MAILLES_COULEES_PAR_PIECE,
  TAILLE_CM_MAILLE_COULEE,
  ecritureMaille,
  estMailleCoulee,
  guideMaille,
  rappelFinDePiece,
} from './maille-ouvert-large-trm.js'

const ouvert = (mailles: number) => ({ ouvertLarge: true, pieceOuverte: true, mailles })

describe('guideMaille', () => {
  it('does not apply to a tubular OF, whatever the piece carries', () => {
    expect(guideMaille({ ouvertLarge: false, pieceOuverte: true, mailles: 0 })).toBeNull()
    expect(guideMaille({ ouvertLarge: false, pieceOuverte: true, mailles: 3 })).toBeNull()
  })

  it('does not apply when no piece is on the machine', () => {
    expect(guideMaille({ ouvertLarge: true, pieceOuverte: false, mailles: 0 })).toBeNull()
  })

  it('lets the first maille of the piece run', () => {
    const g = guideMaille(ouvert(0))
    expect(g?.conduite).toBe('couler')
    expect(g?.bouton).toBe('Laisser couler la maille')
    expect(g?.puis_fin_de_piece).toBe(false)
  })

  it('cuts the roll on the second maille, and on any after it', () => {
    for (const n of [1, 2, 5]) {
      const g = guideMaille(ouvert(n))
      expect(g?.conduite).toBe('couper')
      expect(g?.puis_fin_de_piece).toBe(true)
    }
  })

  it('switches exactly at the legacy « Max 1 maille »', () => {
    expect(MAX_MAILLES_COULEES_PAR_PIECE).toBe(1)
    expect(guideMaille(ouvert(MAX_MAILLES_COULEES_PAR_PIECE - 1))?.conduite).toBe('couler')
    expect(guideMaille(ouvert(MAX_MAILLES_COULEES_PAR_PIECE))?.conduite).toBe('couper')
  })
})

describe('rappelFinDePiece', () => {
  it('reminds to repair only on an open-width piece that carries a maille', () => {
    expect(rappelFinDePiece(ouvert(0))).toBeNull()
    expect(rappelFinDePiece(ouvert(1))).toMatch(/Réparez/)
    expect(rappelFinDePiece({ ouvertLarge: false, pieceOuverte: true, mailles: 2 })).toBeNull()
    expect(rappelFinDePiece({ ouvertLarge: true, pieceOuverte: false, mailles: 1 })).toBeNull()
  })
})

describe('ecritureMaille', () => {
  it('records a maille left to run as the whole piece, already récupérée', () => {
    expect(ecritureMaille('couler')).toEqual({
      description: DESCRIPTION_MAILLE_COULEE,
      taille_cm: TAILLE_CM_MAILLE_COULEE,
      recupere: 1,
    })
  })

  it('records a cut maille with no length and not récupérée', () => {
    const e = ecritureMaille('couper')
    expect(e.taille_cm).toBe(0)
    expect(e.recupere).toBe(0)
    expect(estMailleCoulee(e.description)).toBe(false)
  })
})

describe('estMailleCoulee', () => {
  it('recognises its own description through HFSQL padding and case', () => {
    expect(estMailleCoulee(DESCRIPTION_MAILLE_COULEE)).toBe(true)
    expect(estMailleCoulee('  maille   coulée ')).toBe(true)
  })

  it('does not claim the terminals’ historical descriptions', () => {
    expect(estMailleCoulee('Maille Toute la pièce')).toBe(false)
    expect(estMailleCoulee('Maille Moins de 50 cm')).toBe(false)
    expect(estMailleCoulee('')).toBe(false)
    expect(estMailleCoulee(null)).toBe(false)
  })
})
