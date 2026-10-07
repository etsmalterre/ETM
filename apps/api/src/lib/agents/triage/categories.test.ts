import { describe, expect, it } from 'vitest'
import { categorie, CATEGORIES, libelleGmail, normaliserCategories } from './categories.js'
import { TRIAGE_PROMPT_V1, TRIAGE_PROMPT_V2, TRIAGE_SCHEMA } from './prompt.js'

describe('categories', () => {
  it('unknown keys dropped, duplicates removed, order kept, « autre » when empty', () => {
    expect(normaliserCategories(['qualite', 'bidon', 'qualite', 'transport'])).toEqual(['qualite', 'transport'])
    expect(normaliserCategories([])).toEqual(['autre'])
    expect(normaliserCategories([42, null])).toEqual(['autre'])
  })
  it('Gmail labels under ETM/, nested by dyer for BL and invoices only', () => {
    expect(libelleGmail(categorie('transport')!, 'DSV')).toBe('ETM/Transport')
    expect(libelleGmail(categorie('bl_ennoblisseur')!, 'MATEL')).toBe('ETM/BL ennoblisseur/MATEL')
    expect(libelleGmail(categorie('facture_sous_traitant')!, null)).toBe('ETM/Facture sous-traitant/Inconnu')
    expect(libelleGmail(categorie('bl_ennoblisseur')!, 'A/B')).toBe('ETM/BL ennoblisseur/A-B')
  })
  it('never a bare system label name (MFProd « Spam » outage)', () => {
    for (const c of CATEGORIES) expect(libelleGmail(c, 'X').startsWith('ETM/')).toBe(true)
    expect(CATEGORIES.some((c) => /^(spam|inbox|trash|sent|draft|important|starred)$/i.test(c.libelle))).toBe(false)
  })
  it('the prompt defines every category and the schema enumerates them all', () => {
    for (const c of CATEGORIES) expect(TRIAGE_PROMPT_V1).toContain(`- ${c.cle} :`)
    expect(TRIAGE_SCHEMA.properties.categories.items.enum).toEqual(CATEGORIES.map((c) => c.cle))
  })
})

describe('entreeTriage', () => {
  it('never sends a lone surrogate (an emoji cut at the body limit → Mistral 400)', async () => {
    const { entreeTriage, MAX_CORPS } = await import('./prompt.js')
    const texte = `${'a'.repeat(MAX_CORPS - 1)}😀 suite`
    const m = { id: 'm', threadId: 't', de: 'x@y.fr', a: '', cc: '', sujet: 's', date: '2026-10-05T00:00:00Z', envoye: false, libelles: [], texte, piecesJointes: [] }
    const out = entreeTriage(m, null, [])
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    // The unsanitised cut does contain one (the test is not vacuous).
    expect(`${texte.slice(0, MAX_CORPS)}`).toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(out).toContain('a…')
  })
})

describe('prompt v2', () => {
  it('is v1 with the two fixes of 06/10: an unannounced dyer PDF and our reply in a BL thread are no BL', () => {
    expect(TRIAGE_PROMPT_V2).not.toBe(TRIAGE_PROMPT_V1)
    expect(TRIAGE_PROMPT_V2).toContain('« TAD INFOS CLIENTS »')
    expect(TRIAGE_PROMPT_V2).toContain('sans nouveau document joint est interne')
    expect(TRIAGE_PROMPT_V2.split('\n').length).toBe(TRIAGE_PROMPT_V1.split('\n').length)
  })
})
