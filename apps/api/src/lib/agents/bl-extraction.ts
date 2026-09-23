// Agent « BL Ennoblisseur » — the pure half: prompt, JSON schema, normalisation of
// what the model returns, and the checks that decide whether a BL may be
// written without a human. No I/O here (tests: bl-extraction.test.ts).
//
// Benchmark 2026-09-22 (120 MATEL BLs from ged, reference checked by hand):
// OCR + mistral-small read 119/120 exactly and never produced a wrong BL that
// these checks let through. The miss was a fax scan where OCR read the
// commande « 8869 » as « SS69 » — caught by the format check below.
//
// Two MATEL layouts exist and both must pass:
//   - current: « BORDEREAU DE LIVRAISON N° 109152 A », « Ligne 1 », one piece
//     per row, totals « Nombre Pièces / Poids Total / Métrage Total »;
//   - older: « N° 108914 » (no letter), merged rolls « 3510/11+3510/2 » or the
//     shorthand « 3067/17+3 » (= 3067/17 + 3067/3), totals « Nbre roules /
//     Poids total en Kg / Métrage total ».

export const BL_PROMPT_V1 = `Tu extrais les données d'un bordereau de livraison (BL) du teinturier MATEL COULEURS TEXTILES adressé à Malterre.

Champs :
- numero_commande : le "Commande n°", 4 chiffres.
- numero_bordereau : le numéro après "BORDEREAU DE LIVRAISON N°" : 6 chiffres, parfois suivis d'une lettre. Sans espace (ex. "109152A", ou "108914" s'il n'y a pas de lettre).
- ligne : le numéro après "Ligne" dans l'en-tête (entier), null s'il est absent.
- pieces : une entrée par ligne du tableau des pièces (ou des rouleaux), dans l'ordre.
  - numero_piece : colonne "Numéro de pièce" (ou "Numéro de pièces", ou "Numéro de roule" quand elle contient des numéros comme 3476/80). Recopie-le exactement tel qu'imprimé, y compris les pièces assemblées avec "+" (ex. "3510/11+3510/2", "3067/17+3"). Ne mets jamais le numéro de rouleau "R1", "R2"…
  - poids : colonne "Poids" en kg, nombre décimal (virgule française convertie en point).
  - metrage : colonne "Métrage" en mètres, nombre décimal.
  - observations : colonne "Observations" (ou "Observations+N° de pièces"), texte tel quel, "" si vide. N'y mets JAMAIS le contenu de la colonne "Variante / Coloris" ni le numéro de bordereau du tricoteur.
- nombre_pieces : "Nombre Pièces" ou "Nbre roules" ; poids_total : "Poids Total" ou "Poids total en Kg" ; metrage_total : "Métrage Total". null s'ils sont absents.

Ne calcule rien, ne devine rien : recopie ce qui est imprimé. Réponds uniquement avec le JSON.`

export const BL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    numero_commande: { type: 'string' },
    numero_bordereau: { type: 'string' },
    ligne: { type: ['integer', 'null'] },
    pieces: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          numero_piece: { type: 'string' },
          poids: { type: 'number' },
          metrage: { type: 'number' },
          observations: { type: 'string' },
        },
        required: ['numero_piece', 'poids', 'metrage', 'observations'],
      },
    },
    nombre_pieces: { type: ['integer', 'null'] },
    poids_total: { type: ['number', 'null'] },
    metrage_total: { type: ['number', 'null'] },
  },
  required: ['numero_commande', 'numero_bordereau', 'ligne', 'pieces', 'nombre_pieces', 'poids_total', 'metrage_total'],
} as const

export interface BlPiece {
  /** As written into data_bl_tricotbot.num_piece: components joined by « + »,
   *  shorthand expanded (« 3067/17+3 » → « 3067/17+3067/3 »). */
  numero_piece: string
  /** The individual écru numeros (one, or several for a merged roll). */
  composants: string[]
  poids: number | null
  metrage: number | null
  observations: string
}

export interface BlExtraction {
  numero_commande: string
  numero_bordereau: string
  ligne: number | null
  pieces: BlPiece[]
  nombre_pieces: number | null
  poids_total: number | null
  metrage_total: number | null
}

const toNum = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null
}
const toInt = (v: unknown): number | null => {
  const n = toNum(v)
  return n == null ? null : Math.trunc(n)
}

const PIECE_RE = /^\d+\/\d+(-\d+)?$/

/** Split a printed piece number into écru numeros. A bare number after a
 *  « + » is a shorthand for another piece of the previous OF:
 *  « 3067/17+3 » → ['3067/17', '3067/3'], « 3532/2+3 » → ['3532/2', '3532/3']. */
export function composantsDe(numero: string): string[] {
  const parts = numero.replace(/\s/g, '').split('+').filter(Boolean)
  const out: string[] = []
  let of: string | null = null
  for (const p of parts) {
    if (/^\d+$/.test(p) && of) {
      out.push(`${of}/${p}`)
    } else {
      out.push(p)
      const m = /^(\d+)\//.exec(p)
      if (m) of = m[1]
    }
  }
  return out
}

/** Normalise the model's JSON into a BlExtraction. Never throws on a
 *  missing field — the checks report what is wrong. */
export function normaliserExtraction(raw: unknown): BlExtraction {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pieces = Array.isArray(o.pieces) ? o.pieces : []
  return {
    numero_commande: String(o.numero_commande ?? '').replace(/\s/g, ''),
    numero_bordereau: String(o.numero_bordereau ?? '').replace(/\s/g, '').toUpperCase(),
    ligne: toInt(o.ligne),
    pieces: pieces.map((p) => {
      const r = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
      const composants = composantsDe(String(r.numero_piece ?? ''))
      return {
        numero_piece: composants.join('+'),
        composants,
        poids: toNum(r.poids),
        metrage: toNum(r.metrage),
        observations: String(r.observations ?? '').trim(),
      }
    }),
    nombre_pieces: toInt(o.nombre_pieces),
    poids_total: toNum(o.poids_total),
    metrage_total: toNum(o.metrage_total),
  }
}

/** « 109152A » → « MA109152 », « 108914 » → « MA108914 » — the lot the n8n
 *  workflow wrote (the réception dialog pre-fills it on every roll). */
export function lotDuBordereau(numeroBordereau: string): string {
  const m = /^(\d{6})/.exec(numeroBordereau)
  return m ? `MA${m[1]}` : ''
}

/** Indexes of the attachments that belong to the same BL, in order. A BL
 *  scanned as several PDFs (ged 10620 + 10621) carries one bordereau number
 *  on each page; an unreadable number stays on its own. */
export function grouperPages(pages: readonly BlExtraction[]): number[][] {
  const groupes: number[][] = []
  const parNumero = new Map<string, number[]>()
  pages.forEach((p, i) => {
    const k = p.numero_bordereau
    if (!k) { groupes.push([i]); return }
    const g = parNumero.get(k)
    if (g) g.push(i)
    else { const n = [i]; parNumero.set(k, n); groupes.push(n) }
  })
  return groupes
}

/** One extraction per BL: pieces concatenated, header from the first page
 *  that has it, printed totals from the page that carries them. */
export function fusionnerPages(pages: readonly BlExtraction[]): BlExtraction[] {
  return grouperPages(pages).map((idx) => {
    const ps = idx.map((i) => pages[i])
    if (ps.length === 1) return ps[0]
    const premier = <T,>(f: (p: BlExtraction) => T | null | '') => ps.map(f).find((v) => v != null && v !== '') ?? null
    const dernier = <T,>(f: (p: BlExtraction) => T | null) => [...ps].reverse().map(f).find((v) => v != null) ?? null
    return {
      numero_commande: (premier((p) => p.numero_commande) as string | null) ?? '',
      numero_bordereau: ps[0].numero_bordereau,
      ligne: premier((p) => p.ligne) as number | null,
      pieces: ps.flatMap((p) => p.pieces),
      nombre_pieces: dernier((p) => p.nombre_pieces),
      poids_total: dernier((p) => p.poids_total),
      metrage_total: dernier((p) => p.metrage_total),
    }
  })
}

export type Gravite = 'bloquant' | 'avertissement'

export interface Controle {
  code: string
  gravite: Gravite
  message: string
}

/** Checks on the extraction alone (no database). A « bloquant » check sends
 *  the BL to a human; an « avertissement » is shown but does not block. */
export function controlerExtraction(e: BlExtraction): Controle[] {
  const out: Controle[] = []
  const bloque = (code: string, message: string) => out.push({ code, gravite: 'bloquant', message })
  const avertit = (code: string, message: string) => out.push({ code, gravite: 'avertissement', message })

  if (!/^\d{4}$/.test(e.numero_commande)) bloque('commande_format', `Numéro de commande illisible (« ${e.numero_commande || '—'} »).`)
  if (!/^\d{6}[A-Z]?$/.test(e.numero_bordereau)) bloque('bordereau_format', `Numéro de bordereau illisible (« ${e.numero_bordereau || '—'} »).`)
  if (e.pieces.length === 0) bloque('aucune_piece', 'Aucune pièce lue sur le BL.')

  // A piece the dyer cut in two is printed twice under the same number, one
  // part unweighed: « 3351/18 | 0,00 | 40,00 | Client » then « 3351/18 | 21,10 |
  // 65,00 ». Legitimate (the réception splits it into -1 / -2), so it only warns.
  const lignesPar = new Map<string, BlPiece[]>()
  for (const p of e.pieces) lignesPar.set(p.numero_piece, [...(lignesPar.get(p.numero_piece) ?? []), p])
  const coupees = new Set(
    [...lignesPar].filter(([, ls]) => ls.length === 2 && ls.some((l) => l.poids === 0) && ls.some((l) => (l.poids ?? 0) > 0)).map(([n]) => n),
  )
  for (const n of coupees) {
    avertit('piece_coupee', `La pièce ${n} a été coupée en deux par le teinturier (une partie non pesée) : à scinder à la réception.`)
  }

  const vus = new Set<string>()
  for (const p of e.pieces) {
    if (p.composants.length === 0 || !p.composants.every((c) => PIECE_RE.test(c))) {
      bloque('piece_format', `Numéro de pièce illisible (« ${p.numero_piece || '—'} »).`)
    }
    const coupee = coupees.has(p.numero_piece)
    if (p.poids == null || p.poids < 0 || (p.poids === 0 && !coupee)) bloque('piece_poids', `Poids manquant pour la pièce ${p.numero_piece}.`)
    if (p.metrage == null || p.metrage < 0) bloque('piece_metrage', `Métrage manquant pour la pièce ${p.numero_piece}.`)
    if (coupee && vus.has(p.composants[0])) continue
    for (const c of p.composants) {
      if (vus.has(c)) bloque('piece_double', `La pièce ${c} apparaît deux fois sur le BL.`)
      vus.add(c)
    }
  }

  // The printed totals are the model-independent check. The BL itself is
  // sometimes inconsistent (« Nbre roules 10 » above 11 rows) and a BL scanned
  // as two attachments carries its totals on the last page only, so a missing
  // or mismatched total is a warning when the rest is clean — but a sum that
  // disagrees is a strong signal, so it blocks.
  const somme = (k: 'poids' | 'metrage') => Math.round(e.pieces.reduce((s, p) => s + (p[k] ?? 0), 0) * 100) / 100
  if (e.poids_total != null && Math.abs(somme('poids') - e.poids_total) > 0.051) {
    bloque('total_poids', `La somme des poids (${somme('poids')} kg) ne correspond pas au total imprimé (${e.poids_total} kg).`)
  }
  if (e.metrage_total != null && Math.abs(somme('metrage') - e.metrage_total) > 0.051) {
    bloque('total_metrage', `La somme des métrages (${somme('metrage')} m) ne correspond pas au total imprimé (${e.metrage_total} m).`)
  }
  if (e.nombre_pieces != null && e.nombre_pieces !== e.pieces.length) {
    avertit('total_nombre', `Le BL annonce ${e.nombre_pieces} pièce(s), ${e.pieces.length} ligne(s) lue(s).`)
  }
  if (e.poids_total == null && e.metrage_total == null) {
    avertit('totaux_absents', 'Aucun total imprimé sur ce document (BL sur plusieurs pages ?) : les pièces n’ont pas pu être recoupées.')
  }
  return out
}

export const estBloquant = (cs: readonly Controle[]) => cs.some((c) => c.gravite === 'bloquant')
