/**
 * Read-only probe for the TRM Qualité › Retour client port
 * (routes/retours-client-trm.ts, legacy FI_Retour_ClientTRM.wdw).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/probe-retour-client-trm.ts
 *
 * Re-run it against prod after an /etm_deploy: several of the router's paths
 * differ between the Windows ODBC driver and the Linux bridge, and this script
 * is what tells you which half is broken.
 *
 * What it verifies:
 *   1. `retour_client` shape + the archivé split (the En cours / Terminé filter).
 *   2. Physical column order from SELECT * — the ONLY trustworthy source for the
 *      positional rewrite that writes the accented `archivé` on Linux. It does
 *      NOT match the MPS.xdd analysis order (same trap as controle_titrage).
 *   3. The FNC mirror: every retour_client column that is a copy of its ETM
 *      dossier_qualite (messageFNC → message_client, envoiFNC → DATE,
 *      reponseFNC → résolution + réponse). If this drifts, the write-back in
 *      PUT /:id is writing into the wrong column.
 *   4. Reference resolution — Type_Reference '1' → stock_ecru.numero (NOT
 *      unique, and 6 historical rows resolve to nothing), '2' → stock_fini.lot
 *      (the TRM discriminator means *lot fini*, where the ETM dossier screen's
 *      '2' means *lot de fil* — different table, same code).
 *   5. Traçabilité reachability: commande sous-traitant (Bon de commande) and
 *      expédition TRM (Bon de livraison) per referenced piece.
 *   6. Dead columns — `defaut` and `impact_prime`. The screen must not offer an
 *      input for either; the PDF prints impact_prime at 0,00 € by design.
 *   7. doc_qualite reachability. Its PK *and* its dossier FK are accented, so
 *      the Linux bridge cannot scope a query to one dossier — the Documents tab
 *      reports `degraded` there rather than pretending the dossier is empty.
 *      This probe is how you find out if that ever changes.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'

const IS_WINDOWS = process.platform === 'win32'

function head(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`)
}

function ok(cond: boolean, label: string, extra = '') {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
}

const n = (v: unknown): number => Number(v) || 0
const s = (v: unknown): string => (v ?? '').toString().trim()

/** Column order the router's positional rewrite depends on. */
const EXPECTED_COLUMN_ORDER = [
  'IDretour_client',
  'message_client',
  'reponse',
  'impact_prime',
  'IDclient',
  'DATE',
  'Type_Reference',
  'reference',
  'archivé',
  'defaut',
  'IDdossier_qualite',
  'IDdefaut_textile',
  'journal',
  'message_resp_atelier',
  'IDresolution_qualite',
  'IDbonnetier',
  'IDmachine',
]

/** `archivé` → `archiv` on the Linux bridge (name truncated at the accent). */
function accentTrunc(name: string): string {
  const m = name.match(/[^\x00-\x7F]/)
  return m && m.index !== undefined ? name.slice(0, m.index) : name
}

function sameColumn(actual: string, expected: string): boolean {
  const a = actual.toLowerCase()
  return a === expected.toLowerCase() || a === accentTrunc(expected).toLowerCase()
}

async function main() {
  console.log(`platform: ${process.platform} (${IS_WINDOWS ? 'ODBC' : 'Linux bridge'})`)

  // ── 1. Shape + archivé split ────────────────────────────
  head('1. retour_client — volume and archivé split')
  const total = n((await query<any>(`SELECT COUNT(*) AS n FROM retour_client`))[0]?.n)
  console.log(`  ${total} dossiers`)
  const split = await query<any>(
    `SELECT archivé AS a, COUNT(*) AS n FROM retour_client GROUP BY archivé`,
  ).catch((e) => {
    console.log(`  (accented GROUP BY unavailable here: ${e.message})`)
    return [] as any[]
  })
  for (const r of split as any[]) {
    console.log(`  archivé=${n(r.a)} → ${n(r.n)} (${n(r.a) === 1 ? 'Terminé' : 'En cours'})`)
  }

  // ── 2. Physical column order ────────────────────────────
  head('2. SELECT * column order (drives the positional rewrite)')
  const sample = await query<any>(`SELECT * FROM retour_client ORDER BY IDretour_client DESC LIMIT 3`)
  const keys = Object.keys((sample as any[])[0] ?? {})
  console.log(`  runtime: ${keys.join(', ')}`)
  const orderOk =
    keys.length === EXPECTED_COLUMN_ORDER.length &&
    keys.every((k, i) => sameColumn(k, EXPECTED_COLUMN_ORDER[i]))
  ok(orderOk, 'order matches RC_COLUMNS in retours-client-trm.ts')
  if (!orderOk) {
    console.log('  >>> STOP: fix RC_COLUMNS before any write runs on this platform.')
  }

  // ── 3. The FNC mirror ───────────────────────────────────
  head('3. FNC mirror — retour_client vs its ETM dossier_qualite')
  const linked = n(
    (await query<any>(`SELECT COUNT(*) AS n FROM retour_client WHERE IDdossier_qualite > 0`))[0]?.n,
  )
  ok(linked === total, `every retour comes from an ETM FNC`, `${linked}/${total}`)

  const pairs = await query<any>(
    `SELECT r.IDretour_client, r.DATE AS rdate, r.message_client, r.IDdefaut_textile AS rdef,
            r.Type_Reference AS rtype, r.reference AS rref,
            d.IDdossier_qualite, d.envoiFNC, d.messageFNC, d.IDdefaut_textile AS ddef,
            d.Type_Reference AS dtype, d.reference AS dref, d.IDSociétéFNC AS soc
     FROM retour_client r
     LEFT JOIN dossier_qualite d ON d.IDdossier_qualite = r.IDdossier_qualite
     WHERE r.IDdossier_qualite > 0
     ORDER BY r.IDretour_client DESC LIMIT 25`,
  ).catch((e) => {
    console.log(`  (accented join column unavailable here: ${e.message})`)
    return [] as any[]
  })
  if ((pairs as any[]).length > 0) {
    const rows = pairs as any[]
    const eq = (a: unknown, b: unknown) => s(a) === s(b)
    ok(rows.every((r) => eq(r.rdate, r.envoiFNC)), 'DATE  ==  envoiFNC')
    ok(rows.every((r) => eq(r.message_client, r.messageFNC)), 'message_client  ==  messageFNC')
    ok(rows.every((r) => n(r.rdef) === n(r.ddef)), 'IDdefaut_textile mirrored')
    ok(rows.every((r) => n(r.soc) === 1), 'IDSociétéFNC = 1 (Tricotage Malterre) on every linked dossier')
  }

  // Affectation is SEEDED from the FNC and then owned by TRM: the atelier
  // routinely re-points it at the roll it actually found (or narrows ETM's lot
  // to one piece). A divergence here is normal — it is the reason the field
  // stays editable on the TRM screen and is NOT written back to the dossier.
  const drift = await query<any>(
    `SELECT r.IDretour_client, r.Type_Reference AS rtype, r.reference AS rref,
            d.Type_Reference AS dtype, d.reference AS dref
     FROM retour_client r JOIN dossier_qualite d ON d.IDdossier_qualite = r.IDdossier_qualite`,
  ).catch(() => [] as any[])
  const diverged = (drift as any[]).filter(
    (r) => s(r.rtype) !== s(r.dtype) || s(r.rref) !== s(r.dref),
  )
  console.log(
    `  affectation re-pointed by TRM on ${diverged.length}/${(drift as any[]).length} dossiers ` +
      `(e.g. ${diverged.slice(0, 3).map((r) => `${s(r.dtype)}:${s(r.dref)} → ${s(r.rtype)}:${s(r.rref)}`).join(', ')})`,
  )
  console.log('  → seeded at creation, TRM-owned afterwards: never write it back to dossier_qualite')

  // The reponseFNC encoding the write-back has to reproduce.
  const reponses = await query<any>(
    `SELECT r.IDretour_client, r.IDresolution_qualite, r.reponse, d.reponseFNC
     FROM retour_client r
     JOIN dossier_qualite d ON d.IDdossier_qualite = r.IDdossier_qualite
     WHERE r.reponse IS NOT NULL
     ORDER BY r.IDretour_client DESC LIMIT 5`,
  ).catch(() => [] as any[])
  for (const r of reponses as any[]) {
    console.log(
      `  #${n(r.IDretour_client)} résolution=${n(r.IDresolution_qualite)} → reponseFNC starts ${JSON.stringify(
        s(r.reponseFNC).slice(0, 40),
      )}`,
    )
  }

  // Not every FNC produces a TRM dossier — the legacy asks first.
  const sent = n((await query<any>(`SELECT COUNT(*) AS n FROM dossier_qualite WHERE envoiFNC IS NOT NULL`))[0]?.n)
  console.log(`  ${sent} dossiers with an envoiFNC, ${linked} with a retour_client — creation is a choice, not a trigger`)

  // ── 4. Reference resolution ─────────────────────────────
  head('4. Affectation — reference resolution')
  const byType = await query<any>(
    `SELECT Type_Reference AS t, COUNT(*) AS n FROM retour_client GROUP BY Type_Reference`,
  )
  for (const r of byType as any[]) {
    console.log(`  Type_Reference '${s(r.t)}' → ${n(r.n)} (${s(r.t) === '1' ? 'numéro de pièce' : s(r.t) === '2' ? 'numéro de lot fini' : '?'})`)
  }
  const unresolved = await query<any>(
    `SELECT r.IDretour_client, r.reference
     FROM retour_client r
     WHERE r.Type_Reference = '1'
       AND NOT EXISTS (SELECT 1 FROM stock_ecru s WHERE s.numero = r.reference)`,
  )
  console.log(
    `  ${(unresolved as any[]).length} pièce-references resolve to nothing (${(unresolved as any[])
      .map((r) => s(r.reference))
      .join(', ')}) — the Traçabilité tab must render an honest empty state`,
  )
  const dupes = await query<any>(
    `SELECT s.numero, COUNT(*) AS n FROM stock_ecru s
     WHERE s.numero IN (SELECT reference FROM retour_client WHERE Type_Reference = '1')
     GROUP BY s.numero HAVING COUNT(*) > 1`,
  )
  console.log(`  ${(dupes as any[]).length} referenced numéros match MORE than one roll — resolve to a list, never to one row`)

  const lots = await query<any>(`SELECT IDretour_client, reference FROM retour_client WHERE Type_Reference = '2'`)
  for (const l of lots as any[]) {
    const hits = n(
      (await query<any>(`SELECT COUNT(*) AS n FROM stock_fini WHERE lot = '${s(l.reference).replace(/'/g, "''")}'`))[0]?.n,
    )
    const filHits = n(
      (await query<any>(`SELECT COUNT(*) AS n FROM stock_fil WHERE lot = '${s(l.reference).replace(/'/g, "''")}'`))[0]?.n,
    )
    console.log(`  lot '${s(l.reference)}' → ${hits} stock_fini / ${filHits} stock_fil`)
  }
  console.log("  (stock_fini wins: on retour_client, '2' is the LOT FINI — the ETM dossier screen's '2' is a lot de fil)")

  // ── 5. Traçabilité reachability ─────────────────────────
  head('5. Traçabilité — BC / BL reachability per referenced piece')
  const cov = (await query<any>(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN s.IDref_commande_source > 0 THEN 1 ELSE 0 END) AS with_bc,
            SUM(CASE WHEN s.IDligne_expedition_TRM > 0 THEN 1 ELSE 0 END) AS with_bl,
            SUM(CASE WHEN s.IDordre_fabrication > 0 THEN 1 ELSE 0 END) AS with_of
     FROM retour_client r JOIN stock_ecru s ON s.numero = r.reference
     WHERE r.Type_Reference = '1'`,
  ))[0]
  console.log(`  ${n(cov?.n)} pieces — ${n(cov?.with_bc)} with a commande source (BC), ${n(cov?.with_bl)} with an expédition TRM (BL), ${n(cov?.with_of)} with an OF`)

  const societes = await query<any>(
    `SELECT s.IDsociete AS soc, COUNT(*) AS n FROM retour_client r
     JOIN stock_ecru s ON s.numero = r.reference WHERE r.Type_Reference = '1'
     GROUP BY s.IDsociete`,
  )
  console.log(
    `  IDsociete of the referenced rolls: ${(societes as any[]).map((r) => `${n(r.soc)}→${n(r.n)}`).join(', ')}`,
  )
  ok(
    (societes as any[]).some((r) => n(r.soc) === 1),
    'rolls sit on société 1 after the ETM handover — reads must NOT filter IDsociete',
  )

  // ── 6. Dead columns ─────────────────────────────────────
  head('6. Dead columns (no input must exist for these)')
  const impact = n((await query<any>(`SELECT COUNT(*) AS n FROM retour_client WHERE impact_prime <> 0`))[0]?.n)
  ok(impact === 0, 'impact_prime is 0 everywhere', `${impact} non-zero`)
  const defaut = n((await query<any>(`SELECT COUNT(*) AS n FROM retour_client WHERE defaut <> ''`))[0]?.n)
  console.log(`  defaut (text) non-empty on ${defaut} row(s) — the live label comes from IDdefaut_textile`)

  // ── 7. Catalogs ─────────────────────────────────────────
  head('7. Catalogs')
  const resolutions = await query<any>(`SELECT IDresolution_qualite, libelle, id_societe FROM resolution_qualite`)
  for (const r of resolutions as any[]) {
    console.log(`  résolution ${n(r.IDresolution_qualite)} [société ${n(r.id_societe)}] ${s(r.libelle)}`)
  }
  ok(
    (resolutions as any[]).some((r) => n(r.id_societe) === 2),
    'resolution_qualite is société-partitioned — serve id_societe IN (2, 0) to TRM',
  )
  const defauts = n((await query<any>(`SELECT COUNT(*) AS n FROM defaut_textile`))[0]?.n)
  console.log(`  ${defauts} défauts textiles`)
  const clients = await query<any>(
    `SELECT r.IDclient, c.nom, c.IDsociete, COUNT(*) AS n FROM retour_client r
     LEFT JOIN client c ON c.IDclient = r.IDclient
     GROUP BY r.IDclient, c.nom, c.IDsociete ORDER BY n DESC`,
  ).catch(() => [] as any[])
  for (const c of clients as any[]) {
    console.log(`  client ${n(c.IDclient)} « ${s(c.nom)} » (société ${n(c.IDsociete)}) → ${n(c.n)} dossiers`)
  }

  // ── 8. doc_qualite reachability ─────────────────────────
  head('8. doc_qualite — the Documents tab (ETM photos of the defect)')
  try {
    const docs = n(
      (await query<any>(
        `SELECT COUNT(*) AS n FROM doc_qualite
         WHERE IDdossier_qualité IN (SELECT IDdossier_qualite FROM retour_client WHERE IDdossier_qualite > 0)`,
      ))[0]?.n,
    )
    ok(true, `scoping by the accented FK works here`, `${docs} documents on linked dossiers`)
    if (!IS_WINDOWS) {
      console.log('  >>> The Linux bridge now accepts the accented identifier — drop the `degraded` path')
      console.log('  >>> in BOTH retours-client-trm.ts and dossiers-qualite.ts.')
    }
  } catch (e) {
    ok(false, 'cannot scope doc_qualite to one dossier', (e as Error).message)
    console.log('  → expected on the Linux bridge: the Documents tab returns { degraded: true }.')
  }

  await closeConnection()
}

main().catch(async (e) => {
  console.error(e)
  await closeConnection()
  process.exitCode = 1
})
