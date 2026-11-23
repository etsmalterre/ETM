import { describe, expect, it } from 'vitest'
import { corpsMailSoumissionEtude, phraseEnvoiSoumission } from './mail-soumission-etude.js'

describe('phraseEnvoiSoumission', () => {
  it('names the person and the client (LIVA #1389)', () => {
    expect(phraseEnvoiSoumission('Le Slip Français', ['Judy SUBRYAN'])).toBe(
      "Merci de bien vouloir envoyer cette soumission avec les échantillons à l'attention de Judy SUBRYAN chez Le Slip Français.",
    )
  })

  it('lists several people, once each', () => {
    expect(phraseEnvoiSoumission('LSF', ['A', ' B ', 'A', '', 'C'])).toContain("à l'attention de A, B et C chez LSF.")
    expect(phraseEnvoiSoumission('LSF', ['A', 'B'])).toContain("à l'attention de A et B chez LSF.")
  })

  it('falls back to the address printed on the sheet when nobody is named', () => {
    expect(phraseEnvoiSoumission('Le Slip Français')).toBe(
      "Merci de bien vouloir envoyer cette soumission avec les échantillons chez Le Slip Français, à l'adresse indiquée sur le document joint.",
    )
    expect(phraseEnvoiSoumission(null)).toBe(
      "Merci de bien vouloir envoyer cette soumission avec les échantillons à l'adresse indiquée sur le document joint.",
    )
  })
})

describe('corpsMailSoumissionEtude', () => {
  it('writes to the lab, never asks it for comments on the samples', () => {
    const corps = corpsMailSoumissionEtude({
      numero: '1634',
      clientNom: 'Le slip Francais',
      refFini: '029A',
      codeClient: 'marron camel 17-1330TCX',
    })
    expect(corps).toBe(
      [
        'Bonjour,',
        '',
        'Veuillez trouver ci-joint notre soumission N°1634 à destination de Le slip Francais.',
        '',
        'Détails :',
        '  • Référence fini : 029A',
        '  • Code client : marron camel 17-1330TCX',
        '',
        "Merci de bien vouloir envoyer cette soumission avec les échantillons chez Le slip Francais, à l'adresse indiquée sur le document joint.",
        '',
        'Cordialement,',
      ].join('\n'),
    )
    expect(corps).not.toContain('vos commentaires')
  })

  it('drops the details block when there is none', () => {
    expect(corpsMailSoumissionEtude({ numero: '7' })).toBe(
      [
        'Bonjour,',
        '',
        'Veuillez trouver ci-joint notre soumission N°7.',
        '',
        "Merci de bien vouloir envoyer cette soumission avec les échantillons à l'adresse indiquée sur le document joint.",
        '',
        'Cordialement,',
      ].join('\n'),
    )
  })
})
