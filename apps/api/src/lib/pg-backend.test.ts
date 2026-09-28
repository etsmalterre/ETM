import { describe, it, expect } from 'vitest'
import { translateSql, keyResolver, pgDateToHfsql, pgTimestampToHfsql, emptyDatesToNull, emptyDateComparisons, sortContext, inListOrder, hexLiteralsAsText } from './pg-backend.js'

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

describe('ORDER BY on text: the HFSQL order of each column (R14)', () => {
  const cols = {
    'public.sous_traitant': { pk: ['idsous_traitant'], text: ['nom'] },
    'public.client': { pk: ['idclient'], text: ['nom', 'ville'] },
    'public.commande_client': { pk: ['idcommande_client'], text: ['reference'] },
  }
  const rules = { 'public.client.nom': 'cip_as' }
  const ctx = (sql: string) => sortContext(sql, 'public', cols, rules)

  it('builds the collations and the tie-break from the tables the query names', () => {
    const c = ctx('SELECT nom FROM client ORDER BY nom')
    expect(c.collate.get('nom')).toBe('public.hf_cip_as')
    expect(c.collate.get('ville')).toBe('"C"') // never measured: byte order
    expect(c.tiebreak).toEqual(['idclient'])
    expect(ctx('SELECT c.nom FROM client c JOIN commande_client cc ON cc.IDclient = c.IDclient ORDER BY c.nom').tiebreak)
      .toEqual(['c.idclient'])
  })

  it('sorts a bare text column with its collation and ends with the key', () => {
    const sql = 'SELECT IDsous_traitant, nom FROM sous_traitant ORDER BY nom'
    expect(translateSql(sql, ctx(sql)))
      .toBe('SELECT IDsous_traitant, nom FROM sous_traitant ORDER BY nom::text COLLATE "C" NULLS FIRST, idsous_traitant')
    const q = 'SELECT TOP 5 c.nom FROM client c WHERE c.nom <> \'\' ORDER BY c.nom DESC, IDclient'
    expect(translateSql(q, ctx(q)))
      .toBe('SELECT c.nom FROM client c WHERE c.nom <> \'\' ORDER BY c.nom::text COLLATE public.hf_cip_as DESC NULLS LAST, IDclient NULLS FIRST LIMIT 5')
  })

  it('leaves numbers, expressions, DISTINCT and UNION alone; no tie-break under GROUP BY', () => {
    const num = 'SELECT * FROM client ORDER BY IDclient'
    expect(translateSql(num, ctx(num))).toBe('SELECT * FROM client ORDER BY IDclient NULLS FIRST')
    const expr = 'SELECT * FROM client ORDER BY UPPER(nom)'
    expect(translateSql(expr, ctx(expr))).toBe('SELECT * FROM client ORDER BY UPPER(nom) NULLS FIRST, idclient')
    const grp = 'SELECT nom, COUNT(*) FROM client GROUP BY nom ORDER BY nom'
    expect(translateSql(grp, ctx(grp))).toBe('SELECT nom, COUNT(*) FROM client GROUP BY nom ORDER BY nom::text COLLATE public.hf_cip_as NULLS FIRST')
    const dis = 'SELECT DISTINCT nom FROM client ORDER BY nom'
    expect(translateSql(dis, ctx(dis))).toBe('SELECT DISTINCT nom FROM client ORDER BY nom NULLS FIRST')
  })
})

describe('record order: ties and unordered queries come back by key, as in HFSQL (R15)', () => {
  const cols = {
    'public.envoi_email': { pk: ['idenvoi_email'], text: ['adresse'] },
    'public.client': { pk: ['idclient'], text: ['nom'] },
  }
  const ctx = (sql: string) => sortContext(sql, 'public', cols, {})

  it('ends every outer ORDER BY with the key', () => {
    const q = 'SELECT * FROM envoi_email WHERE IDreference = 8966 ORDER BY DATE DESC'
    expect(translateSql(q, ctx(q))).toBe('SELECT * FROM envoi_email WHERE IDreference = 8966 ORDER BY DATE DESC NULLS LAST, idenvoi_email')
  })

  it('orders a SELECT without ORDER BY by the key, before the moved TOP', () => {
    const q = "SELECT TOP 3 adresse FROM envoi_email WHERE notes = 'x'"
    expect(translateSql(q, ctx(q))).toBe("SELECT adresse FROM envoi_email WHERE notes = 'x' ORDER BY idenvoi_email LIMIT 3")
  })

  it('takes the key of the OUTER table, never one inside a subquery or a literal', () => {
    const q = "SELECT (SELECT TOP 1 nom FROM client c WHERE c.IDclient = e.IDreference) AS n, adresse FROM envoi_email e JOIN client k ON k.IDclient = e.IDreference WHERE adresse <> 'FROM client'"
    expect(sortContext(q, 'public', cols, {}).tiebreak).toEqual(['e.idenvoi_email'])
  })

  it('keeps the order of an IN list, as HFSQL does (measured: IN (426,425) → 426, 425)', () => {
    const q = 'SELECT IDenvoi_email, adresse FROM envoi_email WHERE IDenvoi_email IN (426, 425)'
    expect(translateSql(q, ctx(q))).toBe(
      'SELECT IDenvoi_email, adresse FROM envoi_email WHERE IDenvoi_email IN (426, 425) ORDER BY array_position(ARRAY[426, 425]::numeric[], IDenvoi_email::numeric), idenvoi_email')
    const s = "SELECT * FROM envoi_email WHERE IDtype_doc = 2 AND notes IN ('b','a''x')"
    expect(inListOrder(s)).toBe("array_position(ARRAY['b','a''x']::citext[], notes::citext)")
    // a list that is a subquery, or an IN inside a subquery, is not a literal list
    expect(inListOrder('SELECT * FROM a WHERE x IN (SELECT y FROM b)')).toBeUndefined()
    expect(inListOrder('SELECT * FROM a WHERE z = (SELECT 1 FROM b WHERE y IN (1,2))')).toBeUndefined()
  })

  it('leaves aggregates, GROUP BY, DISTINCT, writes and native LIMIT alone', () => {
    for (const q of [
      'SELECT COUNT(*) FROM envoi_email',
      'SELECT IDtype_doc, COUNT(*) FROM envoi_email GROUP BY IDtype_doc',
      'SELECT DISTINCT adresse FROM envoi_email',
      'UPDATE envoi_email SET notes = 1 WHERE IDenvoi_email = 2',
      'SELECT adresse FROM envoi_email LIMIT 5',
    ]) expect(translateSql(q, ctx(q))).not.toContain('idenvoi_email')
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

  it("turns a comparison with '' on a date column into IS [NOT] NULL", () => {
    expect(emptyDateComparisons("SELECT TOP 1 date FROM prospect WHERE date <> '' AND date < '20260928'", 'public', cols))
      .toBe("SELECT TOP 1 date FROM prospect WHERE date IS NOT NULL AND date < '20260928'")
    expect(emptyDateComparisons("SELECT nom FROM prospect p WHERE p.date_relance = '' OR p.date_relance > ''", 'public', cols))
      .toBe("SELECT nom FROM prospect p WHERE p.date_relance IS NULL OR p.date_relance IS NOT NULL")
    expect(emptyDateComparisons("SELECT c.nom FROM prospect p JOIN client c ON c.IDclient = p.IDprospect WHERE c.date_creation != ''", 'public', cols))
      .toBe("SELECT c.nom FROM prospect p JOIN client c ON c.IDclient = p.IDprospect WHERE c.date_creation IS NOT NULL")
    expect(emptyDateComparisons("SELECT nom FROM prospect p, client c WHERE c.date_creation <> ''", 'public', cols))
      .toBe("SELECT nom FROM prospect p, client c WHERE c.date_creation IS NOT NULL")
  })

  it("leaves text columns, and '' inside a literal, alone", () => {
    const text = "SELECT nom FROM prospect WHERE nom <> ''"
    expect(emptyDateComparisons(text, 'public', cols)).toBe(text)
    const lit = "UPDATE prospect SET nom = 'date = '''' ok' WHERE date_relance <> ''"
    expect(emptyDateComparisons(lit, 'public', cols))
      .toBe("UPDATE prospect SET nom = 'date = '''' ok' WHERE date_relance IS NOT NULL")
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

describe("x'…' literals: cp1252 text unless the column is a blob (R16)", () => {
  const cols = {
    'public.message_of': { pk: ['idmessage_of'], cols: ['idmessage_of', 'observation', 'idordre_fabrication'], text: ['observation'], blob: [] },
    'public.ged': { pk: ['idged'], cols: ['idged', 'nom', 'document'], text: ['nom'], blob: ['document'] },
  }
  const T = (sql: string) => hexLiteralsAsText(translateSql(sql), 'public', cols)
  const txt = (h: string) => `convert_from('\\x${h}'::bytea, 'WIN1252')`

  it('decodes text everywhere in a statement with no blob column', () => {
    expect(T("INSERT INTO message_of VALUES (1, x'e93f27', 2)")).toBe(`INSERT INTO message_of VALUES (1, ${txt('e93f27')}, 2)`)
    expect(T("SELECT * FROM message_of WHERE observation LIKE x'25e925'")).toBe(`SELECT * FROM message_of WHERE observation LIKE ${txt('25e925')}`)
  })

  it('keeps a document as bytea and decodes the text beside it, by name or by position', () => {
    expect(T("INSERT INTO ged (nom, document) VALUES (x'e9', x'255044')"))
      .toBe(`INSERT INTO ged (nom, document) VALUES (${txt('e9')}, '\\x255044'::bytea)`)
    expect(T("INSERT INTO ged VALUES (7, x'e9', x'255044')"))
      .toBe(`INSERT INTO ged VALUES (7, ${txt('e9')}, '\\x255044'::bytea)`)
    expect(T("UPDATE ged SET nom = x'e9', document = x'2550' WHERE IDged = 7"))
      .toBe(`UPDATE ged SET nom = ${txt('e9')}, document = '\\x2550'::bytea WHERE IDged = 7`)
  })
})
