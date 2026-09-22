import { describe, it, expect } from 'vitest'
import { translateSql, keyResolver, pgDateToHfsql, pgTimestampToHfsql } from './pg-backend.js'

describe('translateSql', () => {
  it('moves TOP n to a LIMIT at the end of its SELECT', () => {
    expect(translateSql('SELECT TOP 5 IDclient, nom FROM client ORDER BY nom'))
      .toBe('SELECT IDclient, nom FROM client ORDER BY nom LIMIT 5')
    expect(translateSql('SELECT DISTINCT TOP 10 nom FROM client'))
      .toBe('SELECT DISTINCT nom FROM client LIMIT 10')
  })

  it('puts a nested TOP inside its own parentheses', () => {
    expect(translateSql('SELECT * FROM a WHERE id IN (SELECT TOP 3 id FROM b ORDER BY id DESC) AND x = 1'))
      .toBe('SELECT * FROM a WHERE id IN (SELECT id FROM b ORDER BY id DESC LIMIT 3) AND x = 1')
  })

  it('drops CONVERT(… USING …): PostgreSQL text is already UTF-8', () => {
    expect(translateSql("SELECT CONVERT(nom USING 'UTF-8') AS nom FROM client"))
      .toBe('SELECT (nom) AS nom FROM client')
  })

  it('turns x\'hex\' into a bytea literal', () => {
    expect(translateSql("UPDATE ged SET fichier = x'89504e47' WHERE IDged = 1"))
      .toBe("UPDATE ged SET fichier = '\\x89504e47'::bytea WHERE IDged = 1")
  })

  it('unaccents identifiers but never string literals', () => {
    expect(translateSql("SELECT prénom FROM contact WHERE nom = 'Hélène'"))
      .toBe("SELECT prenom FROM contact WHERE nom = 'Hélène'")
  })

  it('leaves quotes, TOP and CONVERT inside string literals alone', () => {
    const s = "SELECT nom FROM client WHERE nom = 'TOP 5 l''usine CONVERT(x USING y)'"
    expect(translateSql(s)).toBe(s)
  })
})

describe('keyResolver', () => {
  const keymap = {
    'public.recommandation': { idrecommandation: 'IDrecommandation', identreprise: 'IDentreprise', date: 'DATE' },
    'public.client': { idclient: 'IDclient', nom: 'nom' },
  }

  it('gives SELECT * the table spelling', () => {
    const k = keyResolver('SELECT * FROM recommandation WHERE identreprise = 7', 'public', keymap)
    expect(k('idrecommandation')).toBe('IDrecommandation')
    expect(k('identreprise')).toBe('IDentreprise')
  })

  it('gives named columns the spelling written in the query, aliases first', () => {
    const k = keyResolver('SELECT idclient, c.nom AS NomClient FROM client c', 'public', keymap)
    expect(k('idclient')).toBe('idclient')
    expect(k('nomclient')).toBe('NomClient')
  })

  it('uppercases DATE and TYPE like HFSQL, unless aliased', () => {
    expect(keyResolver('SELECT date FROM recommandation', 'public', keymap)('date')).toBe('DATE')
    expect(keyResolver('SELECT DATE AS dexp FROM expedition', 'public', keymap)('dexp')).toBe('dexp')
  })
})

describe('value shapes', () => {
  it('formats dates and timestamps like the HFSQL bridge', () => {
    expect(pgDateToHfsql('2024-11-22')).toBe('20241122')
    expect(pgTimestampToHfsql('2020-10-21 00:00:00')).toBe('2020-10-21 00:00:00.000')
    expect(pgTimestampToHfsql('2026-09-22 17:22:10.5')).toBe('2026-09-22 17:22:10.500')
  })
})
