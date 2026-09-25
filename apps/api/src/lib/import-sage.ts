// ── Import de la balance Sage — pure rules ────────────────────────────────
//
// Ports the legacy WinDev window `FEN_upload_compta` (« Téléversement
// Comptabilité »), the button every Monday that feeds Rapports › Finance and
// the finance widgets of both apps. What the window did, recovered from its
// compile cache and proven on the 147 files it stored in prod (2026-09-25):
//
//   FILE    Sage balance export, Windows-1252 text, CRLF, no header line, one
//           account per line: `compte \t libellé \t débit \t crédit`, amounts
//           with a `.` decimal and no thousands separator (`54220.31`). The
//           whole balance is there (classes 1-5, auxiliary `40XXX` accounts);
//           only the 6-digit class 6 and class 7 accounts are kept.
//
//   WRITES  compte_compta  an account seen for the first time is created
//                          (frais_variable = 0, i.e. charge fixe);
//           releve_compta  one row per kept line: débit / crédit at the
//                          import date;
//           upload_compta  the header: `charges` = Σ(débit − crédit) of
//                          class 6, `produits` = Σ(crédit − débit) of class
//                          7, `frais_fixe` / `frais_variable` = class 6 split
//                          by the account's `frais_variable` flag, and the
//                          file itself in `fichier`.
//
//   Replaying these rules on every stored file reproduces `charges` and
//   `produits` to the cent for all TRM uploads and all ETM uploads of 2026
//   (`scripts/check-import-sage.ts`). ETM 2024-2025 differ by exactly the
//   legacy's stock step (`PriseEnCompteStockETM`: inventory variation +
//   depreciation added to the charges), which went dormant when
//   `inventaire_compta` stopped receiving points and is NOT ported — decision
//   Vincent 2026-09-25: `variation-stock.ts` estimates 603700 instead. The one
//   trace of that step we keep is the 0 € row it wrote on 603700 (see
//   `ImportSageScope.comptesToujoursReleves` in routes/import-sage.ts).
//
// Two things the legacy did NOT do and this module adds:
//   • a libellé containing a digit no longer drops the line (the legacy regex
//     `[^0-9]+` for the libellé did — no such line in any stored file yet);
//   • a file is compared with the company's previous exports before it is
//     written, so an ETM balance cannot land in TRM's books or the reverse
//     (`verifierSociete`).

/** One class 6 / class 7 account line of the balance. */
export interface LigneBalance {
  numero: number
  libelle: string
  debit: number
  credit: number
}

/** A line that looks like a class 6 / 7 account but cannot be read. */
export interface LigneIgnoree {
  ligne: number
  texte: string
  raison: string
}

export interface BalanceSage {
  /** Class 6 and 7 accounts, in file order. */
  lignes: LigneBalance[]
  /** Starts with 6 or 7 but is not a readable 6-digit account line. */
  ignorees: LigneIgnoree[]
  /** Every `compte \t libellé` pair of the file, all classes — the file's
   *  fingerprint for `verifierSociete`. */
  empreinte: Set<string>
  /** Number of 4-column lines, all classes (shown in the preview). */
  nbLignesFichier: number
}

const AMOUNT = /^\d+(?:\.\d+)?$/

// Windows-1252 differs from Latin-1 only on 0x80-0x9F. Mapped by hand: the
// server's Node may be built without the ICU data behind
// `TextDecoder('windows-1252')`, and then silently decodes as Latin-1 (0x92
// comes back as the control character U+0092, not `’`). Unassigned bytes stay
// as their Latin-1 code point.
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
}

/** Decode an export as the Windows code page Sage writes. */
export function decodeBalance(buf: Buffer): string {
  let out = ''
  for (const b of buf) out += String.fromCharCode(CP1252_HIGH[b] ?? b)
  return out
}

/** Parse a Sage balance export. Never throws: an unreadable file comes back
 *  with no `lignes`, and the caller refuses it. */
export function parseBalanceSage(text: string): BalanceSage {
  const lignes: LigneBalance[] = []
  const ignorees: LigneIgnoree[] = []
  const empreinte = new Set<string>()
  let nbLignesFichier = 0

  const rows = text.replace(/^﻿/, '').split(/\r\n|\n|\r/)
  rows.forEach((raw, i) => {
    if (!raw.trim()) return
    const cols = raw.split('\t')
    if (cols.length >= 4) {
      nbLignesFichier++
      empreinte.add(`${cols[0].trim()}\t${cols[1].trim()}`)
    }
    if (!/^[67]/.test(raw)) return

    const texte = raw.trim()
    if (cols.length !== 4) {
      ignorees.push({ ligne: i + 1, texte, raison: 'la ligne n’a pas 4 colonnes' })
      return
    }
    const [compte, libelle, debit, credit] = cols.map((c) => c.trim())
    if (!/^\d{6}$/.test(compte)) {
      ignorees.push({ ligne: i + 1, texte, raison: 'numéro de compte hors plan (6 chiffres attendus)' })
      return
    }
    if (!AMOUNT.test(debit) || !AMOUNT.test(credit)) {
      ignorees.push({ ligne: i + 1, texte, raison: 'montant illisible' })
      return
    }
    lignes.push({ numero: Number(compte), libelle, debit: Number(debit), credit: Number(credit) })
  })

  return { lignes, ignorees, empreinte, nbLignesFichier }
}

/** Account numbers present more than once — a file carrying one is refused:
 *  `releve_compta` holds one row per (account, date). */
export function comptesEnDouble(lignes: LigneBalance[]): number[] {
  const seen = new Set<number>()
  const dup = new Set<number>()
  for (const l of lignes) {
    if (seen.has(l.numero)) dup.add(l.numero)
    seen.add(l.numero)
  }
  return [...dup].sort((a, b) => a - b)
}

export interface TotauxBalance {
  charges: number
  produits: number
  frais_fixe: number
  frais_variable: number
  provisions: number
}

const round2 = (x: number) => Math.round(x * 100) / 100

/** The `upload_compta` aggregates, the legacy way. `fraisVariable` answers the
 *  account's current flag; an account it does not know (created by this very
 *  import) counts as a charge fixe, which is what the legacy created it as. */
export function totauxBalance(
  lignes: LigneBalance[],
  fraisVariable: (numero: number) => boolean,
): TotauxBalance {
  let charges = 0
  let produits = 0
  let fixe = 0
  let variable = 0
  for (const l of lignes) {
    if (l.numero < 700000) {
      const montant = l.debit - l.credit
      charges += montant
      if (fraisVariable(l.numero)) variable += montant
      else fixe += montant
    } else {
      produits += l.credit - l.debit
    }
  }
  return {
    charges: round2(charges),
    produits: round2(produits),
    frais_fixe: round2(fixe),
    frais_variable: round2(variable),
    provisions: 0,
  }
}

// ── Which company does this file belong to? ─────────────────────────────────
//
// Measured on the 147 stored exports (2026-09-25), comparing each file's
// `compte \t libellé` pairs with the union of the company's previous 5
// exports: a file shares at least 68,9 % of its pairs with its own company and
// at most 43,5 % with the other, and never less than 36,9 points apart. The
// sets differ because each company has its own suppliers (the `40XXX`
// auxiliary accounts) and its own wording of the same PCG accounts. So the
// rule needs no threshold: the file must look more like the company it is
// being imported into than like the other one.

export const EMPREINTE_NB_FICHIERS = 5

export interface VerdictSociete {
  /** Share of the file's pairs found in the target company's recent exports. */
  ressemblanceCible: number
  /** Same, against the other company. */
  ressemblanceAutre: number
  /** False only when there is something to compare with on both sides and
   *  the file looks more like the other company. */
  ok: boolean
}

function part(fichier: Set<string>, reference: Set<string>): number {
  if (fichier.size === 0 || reference.size === 0) return 0
  let n = 0
  for (const k of fichier) if (reference.has(k)) n++
  return n / fichier.size
}

export function verifierSociete(
  fichier: Set<string>,
  referenceCible: Set<string>,
  referenceAutre: Set<string>,
): VerdictSociete {
  const ressemblanceCible = part(fichier, referenceCible)
  const ressemblanceAutre = part(fichier, referenceAutre)
  const comparable = referenceCible.size > 0 && referenceAutre.size > 0
  return {
    ressemblanceCible,
    ressemblanceAutre,
    ok: !comparable || ressemblanceCible > ressemblanceAutre,
  }
}

/** Today as HFSQL `YYYYMMDD`, in the factory's time zone. */
export function aujourdhuiHfsql(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}${get('month')}${get('day')}`
}
