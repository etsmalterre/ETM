// Read-only guard for rectiligne order lines (type 4 — cols / bandes, LIVA #1185).
//
//   npx tsx src/scripts/check-rectiligne-lines.ts
//
// Checks, on both ledgers (ligne_commande_sous_traitant, ligne_commande_client):
//   1. every type-4 line names an existing ref_rectiligne and, when it has a
//      coloris, a coloris_rectiligne OF THAT reference (report — the legacy
//      delete cascaded blindly, 4 prod sst lines point at a deleted coloris);
//   2. no ordre_fabrication hangs off a type-4 TRM line (an OF would write a
//      ref_rectiligne id into IDref_ecru);
//   3. no stock_ecru piece nor ligne_expedition hangs off a type-4 TRM line;
//   4. every mirror line has the TYPE of the sst line it mirrors (the bridge
//      used to hardcode 1).
// Exits 1 when 2, 3 or 4 fail; 1 is reported only.
import dotenv from 'dotenv'
dotenv.config({ path: process.env.DOTENV_PATH ?? '.env.development' })
const { query } = await import('../lib/hfsql-auto.js')
const { LINE_TYPE_RECTILIGNE } = await import('../lib/sst-line-kind.js')

const T = LINE_TYPE_RECTILIGNE
const ids = (rows: Array<Record<string, unknown>>, k: string) => rows.map((r) => Number(r[k]) || 0).filter((x) => x > 0)

async function main() {
  let failures = 0
  const refs = new Set(ids(await query(`SELECT IDref_rectiligne FROM ref_rectiligne`), 'IDref_rectiligne'))
  const colorisRef = new Map<number, number>()
  for (const r of await query<{ IDcoloris_rectiligne: number; IDref_rectiligne: number }>(
    `SELECT IDcoloris_rectiligne, IDref_rectiligne FROM coloris_rectiligne`,
  )) colorisRef.set(Number(r.IDcoloris_rectiligne), Number(r.IDref_rectiligne))

  const sst = await query<{ id: number; ref: number; col: number }>(
    `SELECT IDligne_commande_sous_traitant AS id, IDreference AS ref, IDColoris AS col
     FROM ligne_commande_sous_traitant WHERE TYPE = ${T}`,
  )
  const trm = await query<{ id: number; ref: number; col: number; etm: number }>(
    `SELECT IDligne_commande_client AS id, IDreference AS ref, IDcolori AS col, IDligne_commande_ETM AS etm
     FROM ligne_commande_client WHERE TYPE = ${T}`,
  )
  console.log(`type-4 lines: ${sst.length} sst, ${trm.length} TRM (${trm.filter((l) => Number(l.etm) > 0).length} mirrors)`)

  // 1 — catalog integrity (report).
  for (const [label, rows] of [['sst', sst], ['TRM', trm]] as const) {
    const badRef = rows.filter((l) => !refs.has(Number(l.ref)))
    const badCol = rows.filter((l) => Number(l.col) > 0 && colorisRef.get(Number(l.col)) !== Number(l.ref))
    console.log(`[1] ${label}: ${badRef.length} unknown reference(s), ${badCol.length} coloris missing or of another reference`)
    for (const l of [...badRef, ...badCol].slice(0, 10)) console.log(`      line ${l.id}: ref ${l.ref}, coloris ${l.col}`)
  }

  const trmIds = ids(trm, 'id')
  if (trmIds.length > 0) {
    const inList = trmIds.join(',')
    // 2 — no OF.
    const ofs = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ordre_fabrication WHERE IDligne_commande_client IN (${inList})`)
    const nOf = Number(ofs[0]?.n) || 0
    console.log(`[2] OF on a type-4 line: ${nOf}`)
    if (nOf > 0) failures++
    // 3 — no piece, no shipment line.
    const [pieces, les] = await Promise.all([
      query<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_ecru WHERE IDLigne_Commande_TRM IN (${inList})`),
      query<{ n: number }>(`SELECT COUNT(*) AS n FROM ligne_expedition WHERE IDligne_commande_client IN (${inList})`),
    ])
    const nP = Number(pieces[0]?.n) || 0
    const nL = Number(les[0]?.n) || 0
    console.log(`[3] stock_ecru pieces: ${nP}, ligne_expedition rows: ${nL}`)
    if (nP + nL > 0) failures++
  }

  // 4 — mirror TYPE parity, both directions.
  const mismatches = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ligne_commande_client l
     JOIN ligne_commande_sous_traitant s ON s.IDligne_commande_sous_traitant = l.IDligne_commande_ETM
     WHERE l.IDligne_commande_ETM > 0
       AND ((l.TYPE = ${T} AND s.TYPE <> ${T}) OR (l.TYPE <> ${T} AND s.TYPE = ${T}))`,
  )
  const nM = Number(mismatches[0]?.n) || 0
  console.log(`[4] mirror lines whose rectiligne-ness differs from their sst line: ${nM}`)
  if (nM > 0) failures++

  console.log(failures === 0 ? 'OK' : `${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
