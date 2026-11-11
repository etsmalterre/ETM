import { describe, expect, it } from 'vitest'
import { AGENTS } from './catalog.js'
import { NOTE_MAX, noteCourte, noteCourteDe, toutesLesNotesCourtes } from './notes-courtes.js'
import { estPublie } from './store.js'

describe('the short note of a stored version', () => {
  it('replaces the long note the version was published with', () => {
    const longue = 'Retours de la v3, prompt inchangé : un métrage sans rapport avec le poids (moins de la moitié…'
    expect(noteCourte('bl-ennoblisseur', 4, longue)).toBe(noteCourteDe('bl-ennoblisseur', 4))
  })
  it('leaves a state numbered otherwise alone, and a note already short', () => {
    expect(noteCourte('bl-ennoblisseur', 4, 'Une note écrite par un pilote.')).toBe('Une note écrite par un pilote.')
    expect(noteCourte('bl-ennoblisseur', 9, 'Retours de la v3, prompt inchangé')).toBe('Retours de la v3, prompt inchangé')
    const courte = noteCourteDe('superviseur', 4)
    expect(noteCourte('superviseur', 4, courte)).toBe(courte)
  })
  it('keeps a shipped version published: its stored copy is read with the same note', () => {
    const livre = AGENTS.find((a) => a.slug === 'bl-ennoblisseur')!.promptLivre!
    const stockee = { prompt: livre.prompt, note: noteCourte('bl-ennoblisseur', 4, 'Retours de la v3, prompt inchangé : un métrage sans rapport…') }
    expect(estPublie(livre, [stockee])).toBe(true)
  })
})

describe('a version note is one or two short sentences', () => {
  it('holds for every rewritten note', () => {
    for (const n of toutesLesNotesCourtes()) {
      expect(n.length, n).toBeLessThanOrEqual(NOTE_MAX)
      expect(n, n).not.toMatch(/[—–]/)
    }
  })
  it('holds for every version shipped with the code', () => {
    const livrees = AGENTS.flatMap((a) => [
      { qui: `${a.slug} (initiale)`, note: a.versionInitiale.note },
      ...(a.promptLivre ? [{ qui: `${a.slug} (livrée)`, note: a.promptLivre.note }] : []),
      ...(a.competences ?? []).flatMap((c) => (c.versionsLivrees ?? []).map((v, i) => ({ qui: `${a.slug}/${c.cle} v${i + 1}`, note: v.note }))),
    ])
    expect(livrees.length).toBeGreaterThan(5)
    for (const l of livrees) expect(l.note.length, l.qui).toBeLessThanOrEqual(NOTE_MAX)
  })
})
