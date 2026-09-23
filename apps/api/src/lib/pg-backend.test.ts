import { describe, it, expect } from 'vitest'
import { translateSql, keyResolver, pgDateToHfsql, pgTimestampToHfsql, emptyDatesToNull } from './pg-backend.js'

describe('translateSql', () => {
  it('moves TOP n to a LIMIT at the end of its SELECT', () => {
    expect(translateSql('SELECT TOP 5 IDclient, nom FROM client ORDER BY nom'))
      .toBe('SELECT IDclient, nom FROM client ORDER BY nom NULLS FIRST LIMIT 5')
    expect(translateSql('SELECT DISTINCT TOP 10 nom FROM client'))
      .toBe('SELECT DISTINCT nom FROM client LIMIT 10')
  })

  it('puts a nested TOP inside its own parentheses', () => {
    expect(translateSql('SELECT * FROM a WHERE id IN (SELECT TOP 3 id FROM b ORDER BY id DESC) AND x = 1'))
      .toBe('SELECT * FROM a WHERE id IN (SELECT id FROM b ORDER BY id DESC NULLS LAST LIMIT 3) AND x = 1')
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

  it('spells HFSQL compact DATETIME literals the way PostgreSQL reads them', () => {
    // /api/trs/atelier and /api/trs/equipe both died on this one.
    expect(translateSql("SELECT * FROM evenement_machine WHERE DATE >= '20260923050000'"))
      .toBe("SELECT * FROM evenement_machine WHERE DATE >= '2026-09-23 05:00:00'")
    expect(translateSql("SELECT * FROM a WHERE d BETWEEN '20260921050000' AND '20260922045959'"))
      .toBe("SELECT * FROM a WHERE d BETWEEN '2026-09-21 05:00:00' AND '2026-09-22 04:59:59'")
  })

  it('leaves a 14-digit string that is not a real date and time alone', () => {
    // A lot number or a barcode must stay exactly what it is.
    expect(translateSql("SELECT * FROM stock_fil WHERE lot = '99999999999999'"))
      .toBe("SELECT * FROM stock_fil WHERE lot = '99999999999999'")
    expect(translateSql("SELECT * FROM a WHERE code = '20261332050000'"))  // month 13, day 32
      .toBe("SELECT * FROM a WHERE code = '20261332050000'")
    // The 8-digit DATE form already works on PostgreSQL: untouched.
    expect(translateSql("SELECT * FROM a WHERE d = '20260923'"))
      .toBe("SELECT * FROM a WHERE d = '20260923'")
  })

  it('leaves quotes, TOP and CONVERT inside string literals alone', () => {
    const s = "SELECT nom FROM client WHERE nom = 'TOP 5 l''usine CONVERT(x USING y)'"
    expect(translateSql(s)).toBe(s)
  })
})

describe('ORDER BY: NULL is the smallest value, as in HFSQL', () => {
  it('places NULLs on every item, direction written or not', () => {
    expect(translateSql('SELECT * FROM prospect ORDER BY date DESC, IDprospect DESC'))
      .toBe('SELECT * FROM prospect ORDER BY date DESC NULLS LAST, IDprospect DESC NULLS LAST')
    expect(translateSql('SELECT * FROM a ORDER BY nom, id ASC'))
      .toBe('SELECT * FROM a ORDER BY nom NULLS FIRST, id ASC NULLS FIRST')
  })

  it('closes the clause before LIMIT and inside parentheses, not inside function calls', () => {
    expect(translateSql('SELECT * FROM a ORDER BY COALESCE(x, y) DESC LIMIT 10'))
      .toBe('SELECT * FROM a ORDER BY COALESCE(x, y) DESC NULLS LAST LIMIT 10')
    expect(translateSql('SELECT (SELECT TOP 1 d FROM b ORDER BY d) AS last FROM a'))
      .toBe('SELECT (SELECT d FROM b ORDER BY d NULLS FIRST LIMIT 1) AS last FROM a')
  })

  it('keeps an explicit NULLS clause', () => {
    expect(translateSql('SELECT * FROM a ORDER BY d DESC NULLS FIRST')).toBe('SELECT * FROM a ORDER BY d DESC NULLS FIRST')
  })
})

describe("empty dates: HFSQL writes '', PostgreSQL wants NULL", () => {
  // The map the nightly copy generates; only these columns are ever touched.
  const cols = {
    'public.prospect': { cols: ['idprospect', 'nom', 'date', 'date_relance'], dates: ['date', 'date_relance'] },
    'public.client': { cols: ['idclient', 'nom', 'date_creation'], dates: ['date_creation'] },
  }

  it('turns an empty date into NULL in an UPDATE, and leaves text alone', () => {
    expect(emptyDatesToNull("UPDATE prospect SET date_relance = '', nom = '' WHERE IDprospect = 4", 'public', cols))
      .toBe("UPDATE prospect SET date_relance = NULL, nom = '' WHERE IDprospect = 4")
  })

  it('turns an empty date into NULL at its position in an INSERT', () => {
    expect(emptyDatesToNull("INSERT INTO prospect (nom, date, date_relance) VALUES ('x', '20260923', '')", 'public', cols))
      .toBe("INSERT INTO prospect (nom, date, date_relance) VALUES ('x', '20260923', NULL)")
  })

  it('leaves a table with no date column, and a real date, untouched', () => {
    const sql = "UPDATE transporteur SET nom = '' WHERE IDtransporteur = 6"
    expect(emptyDatesToNull(sql, 'public', cols)).toBe(sql)
    const ins = "INSERT INTO client (nom, date_creation) VALUES ('x', '20260923')"
    expect(emptyDatesToNull(ins, 'public', cols)).toBe(ins)
  })

  it('fixes a positional INSERT by position, using the copy column order', () => {
    // The accented-column pattern (setClientFlag, prospects.ts) emits this shape.
    expect(emptyDatesToNull("INSERT INTO prospect VALUES (1, '', '', '')", 'public', cols))
      .toBe("INSERT INTO prospect VALUES (1, '', NULL, NULL)")
  })

  it('leaves a positional INSERT alone when the value count does not match', () => {
    const sql = "INSERT INTO prospect VALUES (1, 'x')"
    expect(emptyDatesToNull(sql, 'public', cols)).toBe(sql)
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
