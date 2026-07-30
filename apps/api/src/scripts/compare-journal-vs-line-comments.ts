// For every open (est_soldee = 0) commande_sous_traitant, compare
//   commande_sous_traitant.journal  (the field the new app now binds to)
// against the union of
//   ligne_commande_sous_traitant.commentaire on its lines (what the legacy
//   "journal" UI showed).
//
// Migration intent: every non-empty line.commentaire should appear inside
// the header journal. Report:
//   - MATCH      : header journal contains every non-empty line comment
//                  (whitespace-collapsed substring check), and there are no
//                  surplus non-trivial tokens in the journal that don't
//                  appear in any line comment.
//   - MISSING    : at least one non-empty line comment is NOT present in
//                  the header journal (legacy info lost).
//   - EXTRA      : the header journal has non-empty content but NO line
//                  comment matches any of it (header-only data, possibly
//                  typed manually in ETM or pre-migration legacy).
//   - PARTIAL    : some line comments are present, others are missing.
//   - EMPTY_BOTH : both sides empty — trivially in sync.
//   - HEADER_ONLY_TRIVIAL : header has content but all line comments are
//                  empty — nothing to compare against, journal is content
//                  the user typed directly.
//
// Output is a compact summary + the full mismatch list grouped by category.
import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { stripRtf } from '../lib/rtf-utils.js'

/** Whitespace-collapse + lowercase normalize so accidental whitespace
 *  differences (line wraps, double spaces) don't cause false mismatches.
 *  Keeps accents — the data is now UTF-8 after fixEncoding. */
function normalize(s: string | null | undefined): string {
  if (!s) return ''
  return String(s)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

type Verdict =
  | 'MATCH'
  | 'EMPTY_BOTH'
  | 'HEADER_ONLY_TRIVIAL'
  | 'MISSING'
  | 'EXTRA'
  | 'PARTIAL'

interface Row {
  IDcommande_sous_traitant: number
  journal: string
  lineComments: { lineId: number; text: string }[]
  verdict: Verdict
  details: string
}

async function main() {
  // 1) Headers
  const headers = (await query(
    `SELECT IDcommande_sous_traitant, journal
     FROM commande_sous_traitant
     WHERE est_soldee = 0
     ORDER BY IDcommande_sous_traitant`,
  )) as any[]
  const headersFixed = await fixEncoding(headers as any[], 'commande_sous_traitant', 'IDcommande_sous_traitant', ['journal'])

  // Quick lookup of all open commande ids — used to scope the line query.
  const openIds = (headersFixed as any[]).map((h) => Number(h.IDcommande_sous_traitant)).filter((x) => x > 0)
  console.log(`open commandes: ${openIds.length}`)
  if (openIds.length === 0) return

  // 2) All lines for those commandes, in a single batched query.
  //    HFSQL has no IN-list length cap we've hit, but to be safe we chunk.
  const lineRowsAll: any[] = []
  const CHUNK = 500
  for (let i = 0; i < openIds.length; i += CHUNK) {
    const chunk = openIds.slice(i, i + CHUNK)
    const rows = (await query(
      `SELECT IDligne_commande_sous_traitant, IDcommande_sous_traitant, commentaire
       FROM ligne_commande_sous_traitant
       WHERE IDcommande_sous_traitant IN (${chunk.join(',')})`,
    )) as any[]
    const fixed = await fixEncoding(rows as any[], 'ligne_commande_sous_traitant', 'IDligne_commande_sous_traitant', ['commentaire'])
    for (const r of fixed) lineRowsAll.push(r)
  }

  // Group lines by commande.
  const linesByCmd = new Map<number, { lineId: number; text: string }[]>()
  for (const r of lineRowsAll as any[]) {
    const cmdId = Number(r.IDcommande_sous_traitant)
    const lineId = Number(r.IDligne_commande_sous_traitant)
    const text = stripRtf(r.commentaire ?? null) ?? ''
    const arr = linesByCmd.get(cmdId) ?? []
    arr.push({ lineId, text })
    linesByCmd.set(cmdId, arr)
  }

  // 3) Compare per commande.
  const results: Row[] = []
  for (const h of headersFixed as any[]) {
    const cmdId = Number(h.IDcommande_sous_traitant)
    const journal = stripRtf(h.journal ?? null) ?? ''
    const journalN = normalize(journal)
    const lines = linesByCmd.get(cmdId) ?? []
    const nonEmptyLines = lines.filter((l) => normalize(l.text).length > 0)
    const journalHas = nonEmptyLines.map((l) => journalN.includes(normalize(l.text)))

    let verdict: Verdict
    let details = ''
    if (journalN.length === 0 && nonEmptyLines.length === 0) {
      verdict = 'EMPTY_BOTH'
    } else if (journalN.length > 0 && nonEmptyLines.length === 0) {
      // Header has content but no line comment to compare against.
      verdict = 'HEADER_ONLY_TRIVIAL'
      details = `journal="${journal.slice(0, 80)}"`
    } else if (journalN.length === 0 && nonEmptyLines.length > 0) {
      verdict = 'MISSING'
      details = `journal empty, ${nonEmptyLines.length} line comment(s) lost. e.g. line ${nonEmptyLines[0].lineId}: "${nonEmptyLines[0].text.slice(0, 60)}"`
    } else {
      const missing = nonEmptyLines.filter((_l, i) => !journalHas[i])
      const allPresent = missing.length === 0
      if (allPresent) {
        verdict = 'MATCH'
      } else if (missing.length === nonEmptyLines.length) {
        verdict = 'EXTRA' // none of the line comments survived
        details = `journal="${journal.slice(0, 60)}", missing line ${missing[0].lineId}: "${missing[0].text.slice(0, 50)}"`
      } else {
        verdict = 'PARTIAL'
        details = `${missing.length}/${nonEmptyLines.length} line comment(s) missing. e.g. line ${missing[0].lineId}: "${missing[0].text.slice(0, 50)}"`
      }
    }
    results.push({ IDcommande_sous_traitant: cmdId, journal, lineComments: lines, verdict, details })
  }

  // 4) Summary.
  const counts = new Map<Verdict, number>()
  for (const r of results) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1)
  console.log('\n=== Summary ===')
  for (const v of ['MATCH', 'EMPTY_BOTH', 'HEADER_ONLY_TRIVIAL', 'MISSING', 'EXTRA', 'PARTIAL'] as Verdict[]) {
    console.log(`  ${v.padEnd(20)} ${counts.get(v) ?? 0}`)
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${results.length}`)

  // 5) Mismatches in detail (grouped by category).
  for (const v of ['MISSING', 'EXTRA', 'PARTIAL'] as Verdict[]) {
    const rows = results.filter((r) => r.verdict === v)
    if (rows.length === 0) continue
    console.log(`\n=== ${v} (${rows.length}) ===`)
    for (const r of rows) {
      console.log(`  sst ${r.IDcommande_sous_traitant} — ${r.details}`)
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
