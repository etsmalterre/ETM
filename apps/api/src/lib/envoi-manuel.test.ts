import { describe, it, expect } from 'vitest'
import {
  MANUAL_MARK_PREFIX,
  MANUAL_MARK_NOTES_MAX,
  buildManualMarkNotes,
  isManualMarkNotes,
  parseManualMarkNotes,
} from './envoi-manuel.js'

describe('envoi-manuel — manual « envoyée » marker (LIVA #1174)', () => {
  it('round-trips author and reason', () => {
    const notes = buildManualMarkNotes('Isabelle Malterre', 'Envoyée groupée avec la 9231 par Gmail')
    expect(notes.startsWith(MANUAL_MARK_PREFIX)).toBe(true)
    expect(parseManualMarkNotes(notes)).toEqual({
      auteur: 'Isabelle Malterre',
      motif: 'Envoyée groupée avec la 9231 par Gmail',
    })
  })

  it('keeps the prefix pure ASCII so the LIKE never carries an accent', () => {
    expect(/^[\x20-\x7e]+$/.test(MANUAL_MARK_PREFIX)).toBe(true)
  })

  it('neutralises the separator and newlines inside the free text', () => {
    const notes = buildManualMarkNotes('A|B', 'ligne 1\r\nligne 2 | fin')
    expect(parseManualMarkNotes(notes)).toEqual({ auteur: 'A B', motif: 'ligne 1 ligne 2 fin' })
  })

  it('caps the stored text without ever cutting the prefix or the author', () => {
    const notes = buildManualMarkNotes('Pierrot', 'x'.repeat(1000))
    expect(notes.length).toBe(MANUAL_MARK_NOTES_MAX)
    expect(parseManualMarkNotes(notes)?.auteur).toBe('Pierrot')
  })

  it('ignores real sends and the July backfill marker', () => {
    expect(isManualMarkNotes(null)).toBe(false)
    expect(isManualMarkNotes('')).toBe(false)
    expect(isManualMarkNotes('backfill marque envoyee 2026-07-23')).toBe(false)
    expect(parseManualMarkNotes('backfill marque envoyee 2026-07-23')).toBeNull()
  })

  it('tolerates a bare prefix written by hand', () => {
    expect(parseManualMarkNotes(MANUAL_MARK_PREFIX)).toEqual({ auteur: '', motif: '' })
    expect(parseManualMarkNotes(`${MANUAL_MARK_PREFIX}|Vincent`)).toEqual({ auteur: 'Vincent', motif: '' })
  })
})
