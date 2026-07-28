// Rapports — read-only reporting endpoints.
//
// `/commandes-sst` ports the legacy WinDev "Rapport commandes
// sous-traitants" screen: a flat, line-level tracking table of every
// sous-traitant order line, with computed status, quantities (ordered /
// affected / received), the deadline chain (initial / current / client),
// the resulting delay & margin (in days), the end client, and a comment.
//
// `/commandes-clients` ports the legacy "Rapport commandes clients"
// (FEN_Rapport_commandes_clients.wdw) — the mirror screen on the client
// side: one row per `ligne_commande_client`, with the order identity
// (numéro / client / réf client / adresses facturation+livraison), the
// article (référence / coloris / désignation), the four-way quantity
// split (expédiée / affectée / en sst / stock libre), the money left to
// invoice, the deadline and the three comment levels.
//
// `/commandes-fil` is the yarn-purchasing twin (legacy `FI_Rapport_fil.wdw`,
// Rapports › "Commandes de fils"): one row per `ref_fil_commande` line with
// the fournisseur, ref/coloris, quantities (ordered / received / remaining),
// the delivery date, the relance ("délai notification") date and the
// resulting overdue day count.
//
// It is READ-ONLY and intentionally denormalised: it reuses the same
// domain primitives as `commandes-sous-traitant.ts` (status state machine,
// ref/coloris polymorphism, the stock_ecru/stock_fini ↔ line links, the
// ligne_commande_client → commande_client → client chain) but flattens
// everything to one row per `ligne_commande_sous_traitant`.
//
// HFSQL discipline (see CLAUDE.md): no parameterized queries; only a
// BOUNDED, constant number of set-based queries regardless of row count
// (per-line query fan-out would storm the shared Linux bridge); IN-lists
// are chunked to stay under the statement-length limit; accent repair is
// batched via fixEncoding; reserved-word column `type` is aliased.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { repairAliased } from './stock-fini.js'
import { stripRtf } from '../lib/rtf-utils.js'
import { n, dateDigits, addWorkingDays, isLineDone, lineStatutRank, esc } from '../lib/sst-shared.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'

export const rapportsRouter: RouterType = Router()

// Cap the number of commandes scanned when including soldées (the full
// history is several thousand lines). Open-only is naturally bounded.
const MAX_COMMANDES = 2000
// Chunk size for IN-list queries — keeps each SQL statement well under the
// HFSQL length limit even at MAX_COMMANDES.
const CHUNK = 400

/** Run `fn` over `ids` in CHUNK-sized batches and concatenate the rows.
 *  Returns [] for an empty id list (never emits a `WHERE col IN ()`). */
async function inChunks<T>(ids: number[], fn: (chunk: string) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    if (slice.length === 0) continue
    out.push(...(await fn(slice.join(','))))
  }
  return out
}

/** Days between today (midnight) and a YYYYMMDD date; positive = date is in
 *  the future, negative = past. Null when the input isn't a valid date. */
function daysFromToday(yyyymmdd: string | null): number | null {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return null
  const target = new Date(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8)))
  target.setHours(0, 0, 0, 0)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / 86_400_000)
}

interface RapportLineRow {
  IDligne_commande_sous_traitant: number
  IDcommande_sous_traitant: number
  sstatut: string | null
  sous_traitant_nom: string
  reference: string
  coloris: string
  type_kind: number
  unite_label: 'Ml' | 'Kg'
  qte_commandee: number
  qte_affectee: number
  qte_receptionnee: number
  date_commande: string | null
  delai_initial: string | null
  delai_actuel: string | null
  delai_client: string | null
  date_relance: string | null
  retard_jours: number | null
  marge_jours: number | null
  client_nom: string
  commentaire: string
  journal: string
  urgency: 'late' | 'soon' | null
  est_soldee: number
}

// GET /api/rapports/commandes-sst?soldees=0|1
//   soldees=0 (default) → only open commandes (est_soldee = 0)
//   soldees=1           → also include soldées (closed) commandes
rapportsRouter.get('/commandes-sst', async (req: Request, res: Response) => {
  try {
    const includeSoldees = String(req.query.soldees ?? '0') === '1'

    // ── 1) Commande headers (the scope). Most recent first; capped.
    const headerRows = await query<{
      IDcommande_sous_traitant: number
      IDsous_traitant: number
      date_commande: string | null
      est_soldee: number | null
      date_notif: string | null
      commentaire: string | null
      journal: string | null
    }>(
      `SELECT TOP ${MAX_COMMANDES}
              IDcommande_sous_traitant, IDsous_traitant, date_commande,
              est_soldee, date_notif, commentaire, journal
       FROM commande_sous_traitant
       ${includeSoldees ? '' : 'WHERE est_soldee = 0'}
       ORDER BY IDcommande_sous_traitant DESC`,
    )
    if (headerRows.length === 0) { res.json([]); return }

    const cmdIds = headerRows.map((h) => n(h.IDcommande_sous_traitant)).filter((x) => x > 0)
    interface Hdr {
      IDsous_traitant: number
      date_commande: string
      est_soldee: number
      date_notif: string
      commentaire: string
      journal: string
    }
    const hdrById = new Map<number, Hdr>()
    for (const h of headerRows) {
      hdrById.set(n(h.IDcommande_sous_traitant), {
        IDsous_traitant: n(h.IDsous_traitant),
        date_commande: dateDigits(h.date_commande),
        est_soldee: n(h.est_soldee),
        date_notif: dateDigits(h.date_notif),
        // Header commentaire is RTF (legacy still reads it); strip for fallback.
        commentaire: stripRtf((h.commentaire ?? '').toString()).trim(),
        // Header journal is plain text (RTF rows migrated 2026-05-26); strip
        // defensively in case any legacy RTF survives.
        journal: stripRtf((h.journal ?? '').toString()).trim(),
      })
    }

    // ── 2) Sous-traitant names (accent-repaired).
    const stIds = Array.from(new Set(headerRows.map((h) => n(h.IDsous_traitant)).filter((x) => x > 0)))
    const stNomById = new Map<number, string>()
    {
      const rows = await inChunks(stIds, (chunk) =>
        query<{ IDsous_traitant: number; nom: string | null }>(
          `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${chunk})`,
        ),
      )
      for (const r of await fixEncoding(rows as any[], 'sous_traitant', 'IDsous_traitant', ['nom']))
        stNomById.set(n((r as any).IDsous_traitant), ((r as any).nom ?? '').toString().trim())
    }

    // ── 3) Lines (the report rows). `type` is reserved → alias to type_kind.
    const lineRows = await inChunks(cmdIds, (chunk) =>
      query<{
        IDligne_commande_sous_traitant: number
        IDcommande_sous_traitant: number
        type_kind: number | null
        IDreference: number | null
        IDColoris: number | null
        quantite: number | null
        date_livraison: string | null
        date_delai: string | null
        commentaire: string | null
        sstatut: string | null
      }>(
        `SELECT lcs.IDligne_commande_sous_traitant, lcs.IDcommande_sous_traitant,
                lcs.type AS type_kind, lcs.IDreference, lcs.IDColoris,
                lcs.quantite, lcs.date_livraison, lcs.date_delai,
                lcs.commentaire, lcs.sstatut
         FROM ligne_commande_sous_traitant lcs
         WHERE lcs.IDcommande_sous_traitant IN (${chunk})`,
      ),
    )
    if (lineRows.length === 0) { res.json([]); return }

    const fixedLines = (await fixEncoding(
      lineRows as any[],
      'ligne_commande_sous_traitant',
      'IDligne_commande_sous_traitant',
      ['commentaire', 'sstatut'],
    )) as any[]

    const lineIds = fixedLines.map((l) => n(l.IDligne_commande_sous_traitant)).filter((x) => x > 0)

    // ── 4) Ref + coloris label maps (polymorphic by line type).
    const refIds = Array.from(new Set(fixedLines.map((l) => n(l.IDreference)).filter((x) => x > 0)))
    const colorisIds = Array.from(new Set(fixedLines.map((l) => n(l.IDColoris)).filter((x) => x > 0)))

    const ecruMap = new Map<number, string>()
    const finiMap = new Map<number, string>()
    const filMap = new Map<number, string>()
    const finiAvecTeintureMap = new Map<number, number>()
    if (refIds.length > 0) {
      const [ecruRows, finiRows, filRows] = await Promise.all([
        inChunks(refIds, (c) =>
          query<{ IDref_ecru: number; reference: string | null }>(
            `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${c})`,
          ),
        ),
        inChunks(refIds, (c) =>
          query<{ IDref_fini: number; reference: string | null; avec_teinture: number | null }>(
            `SELECT IDref_fini, reference, avec_teinture FROM ref_fini WHERE IDref_fini IN (${c})`,
          ),
        ),
        inChunks(refIds, (c) =>
          query<{ IDref_fil: number; reference: string | null }>(
            `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${c})`,
          ),
        ),
      ])
      for (const r of await fixEncoding(ecruRows as any[], 'ref_ecru', 'IDref_ecru', ['reference']))
        ecruMap.set(n((r as any).IDref_ecru), ((r as any).reference ?? '').toString())
      for (const r of await fixEncoding(finiRows as any[], 'ref_fini', 'IDref_fini', ['reference'])) {
        finiMap.set(n((r as any).IDref_fini), ((r as any).reference ?? '').toString())
        finiAvecTeintureMap.set(n((r as any).IDref_fini), n((r as any).avec_teinture))
      }
      for (const r of await fixEncoding(filRows as any[], 'ref_fil', 'IDref_fil', ['reference']))
        filMap.set(n((r as any).IDref_fil), ((r as any).reference ?? '').toString())
    }

    const colorisFiniMap = new Map<number, string>()
    const colorisEcruMap = new Map<number, string>()
    if (colorisIds.length > 0) {
      const [finiC, ecruC] = await Promise.all([
        inChunks(colorisIds, (c) =>
          query<{ IDref_fini_colori: number; reference: string | null }>(
            `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${c})`,
          ),
        ),
        inChunks(colorisIds, (c) =>
          query<{ IDcolori_ecru: number; reference: string | null }>(
            `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${c})`,
          ),
        ),
      ])
      for (const c of await fixEncoding(finiC as any[], 'ref_fini_colori', 'IDref_fini_colori', ['reference']))
        colorisFiniMap.set(n((c as any).IDref_fini_colori), ((c as any).reference ?? '').toString())
      for (const c of await fixEncoding(ecruC as any[], 'colori_ecru', 'IDcolori_ecru', ['reference']))
        colorisEcruMap.set(n((c as any).IDcolori_ecru), ((c as any).reference ?? '').toString())
    }

    // Per-type resolvers — mirror commandes-sous-traitant.ts: route by the
    // line's `type` (2=ennoblisseur/fini, 1=tricoteur/ecru, 0=legacy/ecru),
    // fall back to the other catalogs only if the primary lacks the id.
    function resolveRef(IDref: number, typeKind: number): string {
      if (IDref <= 0) return ''
      const order = typeKind === 2 ? [finiMap, ecruMap, filMap] : [ecruMap, finiMap, filMap]
      for (const m of order) if (m.has(IDref)) return m.get(IDref)!
      return ''
    }
    function resolveColoris(IDcoloris: number, typeKind: number, IDref: number): string {
      if (IDcoloris <= 0) return ''
      if (typeKind === 2) {
        const dyed = (finiAvecTeintureMap.get(IDref) ?? 1) !== 0
        return dyed
          ? (colorisFiniMap.get(IDcoloris) ?? colorisEcruMap.get(IDcoloris) ?? '')
          : (colorisEcruMap.get(IDcoloris) ?? colorisFiniMap.get(IDcoloris) ?? '')
      }
      return colorisEcruMap.get(IDcoloris) ?? colorisFiniMap.get(IDcoloris) ?? ''
    }

    // ── 5) Quantity aggregates + client-line links (one query each, chunked).
    interface Agg { affecteeMetrage: number; affecteePoids: number; recuFiniMetrage: number; recuEcruPoids: number }
    const newAgg = (): Agg => ({ affecteeMetrage: 0, affecteePoids: 0, recuFiniMetrage: 0, recuEcruPoids: 0 })
    const aggByLine = new Map<number, Agg>()
    const lccByLine = new Map<number, Set<number>>() // line → set of IDligne_commande_client

    // 5a) Écru affected to the line (ennoblisseur: the greige sent out).
    const ecruAffected = await inChunks(lineIds, (c) =>
      query<{ IDref_commande_affectation: number; poids: number | null; metrage: number | null; IDligne_commande_client: number | null }>(
        `SELECT IDref_commande_affectation, poids, metrage, IDligne_commande_client
         FROM stock_ecru WHERE IDref_commande_affectation IN (${c})`,
      ),
    )
    for (const r of ecruAffected) {
      const lid = n(r.IDref_commande_affectation)
      if (lid === 0) continue
      const a = aggByLine.get(lid) ?? newAgg()
      a.affecteeMetrage += n(r.metrage)
      a.affecteePoids += n(r.poids)
      aggByLine.set(lid, a)
      const lcc = n(r.IDligne_commande_client)
      if (lcc > 0) { const s = lccByLine.get(lid) ?? new Set(); s.add(lcc); lccByLine.set(lid, s) }
    }

    // 5b) Fini received back (ennoblisseur: dyed rolls returned).
    const finiReceived = await inChunks(lineIds, (c) =>
      query<{ IDref_commande_source: number; metrage: number | null; IDligne_commande_client: number | null }>(
        `SELECT IDref_commande_source, metrage, IDligne_commande_client
         FROM stock_fini WHERE IDref_commande_source IN (${c})`,
      ),
    )
    for (const r of finiReceived) {
      const lid = n(r.IDref_commande_source)
      if (lid === 0) continue
      const a = aggByLine.get(lid) ?? newAgg()
      a.recuFiniMetrage += n(r.metrage)
      aggByLine.set(lid, a)
      const lcc = n(r.IDligne_commande_client)
      if (lcc > 0) { const s = lccByLine.get(lid) ?? new Set(); s.add(lcc); lccByLine.set(lid, s) }
    }

    // 5c) Écru produced by the line (tricoteur: knitted greige delivered).
    const ecruProduced = await inChunks(lineIds, (c) =>
      query<{ IDref_commande_source: number; poids: number | null }>(
        `SELECT IDref_commande_source, poids FROM stock_ecru WHERE IDref_commande_source IN (${c})`,
      ),
    )
    for (const r of ecruProduced) {
      const lid = n(r.IDref_commande_source)
      if (lid === 0) continue
      const a = aggByLine.get(lid) ?? newAgg()
      a.recuEcruPoids += n(r.poids)
      aggByLine.set(lid, a)
    }

    // ── 6) Resolve the client chain for every linked client-order line:
    //   ligne_commande_client → (IDcommande_client, date_livraison)
    //   commande_client       → IDclient
    //   client                → nom
    const allLccIds = Array.from(new Set(Array.from(lccByLine.values()).flatMap((s) => Array.from(s))))
    const lccInfo = new Map<number, { ccId: number; delai: string }>()
    if (allLccIds.length > 0) {
      const rows = await inChunks(allLccIds, (c) =>
        query<{ IDligne_commande_client: number; IDcommande_client: number; date_livraison: string | null }>(
          `SELECT IDligne_commande_client, IDcommande_client, date_livraison
           FROM ligne_commande_client WHERE IDligne_commande_client IN (${c})`,
        ),
      )
      for (const r of rows)
        lccInfo.set(n(r.IDligne_commande_client), { ccId: n(r.IDcommande_client), delai: dateDigits(r.date_livraison) })
    }
    const ccToClient = new Map<number, number>()
    const ccIds = Array.from(new Set(Array.from(lccInfo.values()).map((v) => v.ccId).filter((x) => x > 0)))
    if (ccIds.length > 0) {
      const rows = await inChunks(ccIds, (c) =>
        query<{ IDcommande_client: number; IDclient: number }>(
          `SELECT IDcommande_client, IDclient FROM commande_client WHERE IDcommande_client IN (${c})`,
        ),
      )
      for (const r of rows) ccToClient.set(n(r.IDcommande_client), n(r.IDclient))
    }
    const clientNomById = new Map<number, string>()
    const clientIds = Array.from(new Set(Array.from(ccToClient.values()).filter((x) => x > 0)))
    if (clientIds.length > 0) {
      const rows = await inChunks(clientIds, (c) =>
        query<{ IDclient: number; nom: string | null }>(
          `SELECT IDclient, nom FROM client WHERE IDclient IN (${c})`,
        ),
      )
      for (const r of await fixEncoding(rows as any[], 'client', 'IDclient', ['nom']))
        clientNomById.set(n((r as any).IDclient), ((r as any).nom ?? '').toString().trim())
    }

    /** For a line, pick the client-order line with the earliest valid
     *  delivery date (matches legacy "earliest valid" disambiguation) and
     *  return its deadline + client name. */
    function clientFor(lineId: number): { delai: string | null; nom: string } {
      const set = lccByLine.get(lineId)
      if (!set || set.size === 0) return { delai: null, nom: '' }
      let bestDelai: string | null = null
      let bestNom = ''
      for (const lccId of set) {
        const info = lccInfo.get(lccId)
        if (!info) continue
        const nom = clientNomById.get(ccToClient.get(info.ccId) ?? 0) ?? ''
        if (nom && !bestNom) bestNom = nom
        if (info.delai && (bestDelai === null || info.delai < bestDelai)) {
          bestDelai = info.delai
          if (nom) bestNom = nom
        }
      }
      return { delai: bestDelai, nom: bestNom }
    }

    // ── 7) Assemble one row per line.
    const today0 = new Date(); today0.setHours(0, 0, 0, 0)
    const nextWorkingDay = addWorkingDays(today0, 1)

    const out: RapportLineRow[] = fixedLines.map((l) => {
      const lineId = n(l.IDligne_commande_sous_traitant)
      const cmdId = n(l.IDcommande_sous_traitant)
      const hdr = hdrById.get(cmdId)
      const typeKind = n(l.type_kind)
      const sstatut = (l.sstatut ?? '').toString().trim() || null
      const estSoldee = hdr?.est_soldee ?? 0
      const isEnnob = typeKind === 2
      const agg = aggByLine.get(lineId) ?? newAgg()
      const { delai: delaiClient, nom: clientNom } = clientFor(lineId)

      const delaiActuel = dateDigits(l.date_livraison) || null
      const delaiInitial = dateDigits(l.date_delai) || null
      const done = isLineDone(sstatut) || estSoldee === 1

      // Retard = positive overdue days vs the current deadline (blank when
      // no deadline or the line is done / on-time).
      let retard: number | null = null
      if (!done && delaiActuel) {
        const d = daysFromToday(delaiActuel)
        if (d !== null && d < 0) retard = -d
      }
      // Marge = client deadline − current deadline, in days (signed).
      let marge: number | null = null
      if (delaiClient && delaiActuel) {
        const dc = daysFromToday(delaiClient)
        const da = daysFromToday(delaiActuel)
        if (dc !== null && da !== null) marge = dc - da
      }

      // Urgency tint (MPS_NG language: red late / amber soon / none).
      let urgency: 'late' | 'soon' | null = null
      if (!done) {
        const rank = lineStatutRank(sstatut)
        const anchor = rank === 1 ? (hdr?.date_notif || '') : (delaiActuel ?? '')
        if (anchor && /^\d{8}$/.test(anchor)) {
          const target = new Date(Number(anchor.slice(0, 4)), Number(anchor.slice(4, 6)) - 1, Number(anchor.slice(6, 8)))
          target.setHours(0, 0, 0, 0)
          if (target.getTime() <= today0.getTime()) urgency = 'late'
          else if (rank === 1 ? target.getTime() <= nextWorkingDay.getTime() : (target.getTime() - today0.getTime()) / 86_400_000 <= 3) urgency = 'soon'
        }
      }

      // Commentaire column = the commande sst header commentaire (RTF), NOT
      // the per-line lcsst.commentaire — legacy stored unrelated notes (e.g.
      // the literal word "journal") on the line comment, so the header note
      // is the one the user means by "the order's commentaire".
      const commentaire = hdr?.commentaire || ''

      return {
        IDligne_commande_sous_traitant: lineId,
        IDcommande_sous_traitant: cmdId,
        sstatut,
        sous_traitant_nom: stNomById.get(hdr?.IDsous_traitant ?? 0) ?? '',
        reference: resolveRef(n(l.IDreference), typeKind),
        coloris: resolveColoris(n(l.IDColoris), typeKind, n(l.IDreference)),
        type_kind: typeKind,
        unite_label: isEnnob ? 'Ml' : 'Kg',
        qte_commandee: n(l.quantite),
        qte_affectee: isEnnob ? agg.affecteeMetrage : agg.affecteePoids,
        qte_receptionnee: isEnnob ? agg.recuFiniMetrage : agg.recuEcruPoids,
        date_commande: hdr?.date_commande || null,
        delai_initial: delaiInitial,
        delai_actuel: delaiActuel,
        delai_client: delaiClient,
        date_relance: hdr?.date_notif || null,
        retard_jours: retard,
        marge_jours: marge,
        client_nom: clientNom,
        commentaire,
        journal: hdr?.journal || '',
        urgency,
        est_soldee: estSoldee,
      }
    })

    // Default order: most recent commande first, then line id.
    out.sort((a, b) =>
      b.IDcommande_sous_traitant - a.IDcommande_sous_traitant ||
      a.IDligne_commande_sous_traitant - b.IDligne_commande_sous_traitant,
    )

    res.json(out)
  } catch (err) {
    console.error('[rapports/commandes-sst]', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// ════════════════════════════════════════════════════════════════════════
//  RAPPORT COMMANDES CLIENTS
// ════════════════════════════════════════════════════════════════════════
//
// One row per `ligne_commande_client`, scoped to the ETM client ledger
// (IDsociete = 1 AND IDcommande_ETM = 0 — IDsociete=2 rows are the TRM
// mirrors owned by the sister-company view).
//
// The four quantity columns decompose the line's supply pipeline. Each one
// was reverse-engineered from the legacy screen and verified figure-for-
// figure against live rows (commandes 3616 / 3617 / 3643):
//
//   qte_expediee — rolls already shipped: stock_fini with état Expédié (4)
//                  or attached to a ligne_expedition; stock_ecru attached
//                  to a ligne_expedition_ETM. Divers lines read the
//                  expedition_divers ledger instead (no rolls).
//   qte_affectee — rolls RESERVED to the line and still on site, i.e. not
//                  shipped and not out at a sous-traitant.
//   qte_en_sst   — écru RESERVED to the line but currently out at an
//                  ennoblisseur (IDref_commande_affectation > 0) and not
//                  yet dyed back. Fini lines only: on an écru line the
//                  écru IS the deliverable, so it counts as affectée.
//   qte_stock    — FREE stock of the same article (ref + coloris) — rolls
//                  reserved to no line, on no expedition, not état Expédié.
//                  This is the "could I serve this from the shelf?" column.
//
// Écru rolls carry metrage = 0, so on an Ml line their contribution is
// poids × rendement (same conversion as the Commandes clients gauge).
// Écru already dyed into a stock_fini is skipped entirely — the fini roll
// represents it, and counting both double-counts the line.
//
// Deliberate divergence from the Commandes clients affectation gauge:
// `affectation_cmd_tricotage` (yarn planned for knitting) is NOT counted
// here. It is a planning allocation, not physical stock, and the legacy
// report has no column for it — the verified rows confirm it is excluded.
//
// total_ht_non_facture = quantite × prix − Σ(ligne_facture.quantite × prix)
// over the definitive invoices reached through
// ligne_commande_client → ligne_expedition → ligne_facture. Proformas
// (ligne_facture_prov) are drafts and do NOT reduce the outstanding amount.
// Negative values are normal and meaningful: more was shipped and invoiced
// than was ordered.

/**
 * Batched accent repair for plainly-named text columns.
 *
 * `fixEncoding` issues ONE `CONVERT` query per corrupted row per field — an
 * N+1 that floods the shared HFSQL bridge on a report-sized result set (the
 * full-history scope is ~5 000 lines). `repairAliased` batches into one
 * `CONVERT … WHERE id IN (…)` per column instead; this wrapper adds the
 * CHUNK-sized id slicing so the statement stays under the length limit.
 * See CLAUDE.md §Encoding (reads).
 */
async function repairText<T extends Record<string, unknown>>(
  rows: T[],
  table: string,
  idField: string,
  fields: string[],
): Promise<T[]> {
  if (rows.length === 0) return rows
  const aliasMap = Object.fromEntries(fields.map((f) => [f, f]))
  const out: T[] = []
  for (let i = 0; i < rows.length; i += CHUNK) {
    out.push(...(await repairAliased(rows.slice(i, i + CHUNK), table, idField, aliasMap)))
  }
  return out
}

/** Line unit enum (hardcoded WinDev combo, same mapping as commandes-client.ts). */
function uniteLabel(u: number): string {
  switch (u) {
    case 1: return 'Kg'
    case 3: return 'Ml'
    case 4: return 'U'
    case 5: return 'm²'
    default: return ''
  }
}
/** Which roll dimension a line's quantite is measured in. */
const isMetrage = (unite: number): boolean => unite === 3
/** Article key for a divers line / stock row — ref + both variation axes. */
const diversKey = (refId: number, v1: number, v2: number): string => `${refId}|${v1}|${v2}`
const round2 = (v: number): number => Math.round(v * 100) / 100

interface RapportClientLineRow {
  IDligne_commande_client: number
  IDcommande_client: number
  numero: number | null
  client_nom: string
  ref_client: string
  facturation_nom: string
  livraison_nom: string
  reference: string
  coloris: string
  designation: string
  type_kind: number
  unite_label: string
  poids: number
  qte_commandee: number
  qte_expediee: number
  qte_stock: number
  qte_affectee: number
  qte_en_sst: number
  prix: number
  total_ht: number
  total_ht_non_facture: number
  delai: string | null
  retard_jours: number | null
  commentaire_ligne: string
  commentaire_client: string
  commentaire_interne: string
  urgency: 'late' | 'soon' | null
  est_soldee: number
}

// GET /api/rapports/commandes-clients?soldees=0|1
//   soldees=0 (default) → only open commandes (est_soldee = 0)
//   soldees=1           → also include soldées (closed) commandes
rapportsRouter.get('/commandes-clients', async (req: Request, res: Response) => {
  try {
    const includeSoldees = String(req.query.soldees ?? '0') === '1'

    // ── 1) Commande headers (the scope). Most recent first; capped.
    // Explicit ASCII columns only — archivé / expedié / envoyé_client are
    // accented and must never be named (Linux bridge respawn storm).
    const headerRows = await query<any>(
      `SELECT TOP ${MAX_COMMANDES}
              IDcommande_client, IDclient, numero, date_commande, est_soldee,
              ref_client, IDadresse_facturation, IDadresse_livraison,
              commentaire, commentaire_interne
       FROM commande_client
       WHERE IDsociete = 1 AND IDcommande_ETM = 0${includeSoldees ? '' : ' AND est_soldee = 0'}
       ORDER BY IDcommande_client DESC`,
    )
    if (headerRows.length === 0) { res.json([]); return }

    const fixedHeaders = (await repairText(
      headerRows, 'commande_client', 'IDcommande_client',
      ['ref_client', 'commentaire', 'commentaire_interne'],
    )) as any[]

    interface Hdr {
      IDclient: number
      numero: number | null
      est_soldee: number
      ref_client: string
      IDadresse_facturation: number
      IDadresse_livraison: number
      commentaire: string
      commentaire_interne: string
    }
    const hdrById = new Map<number, Hdr>()
    for (const h of fixedHeaders) {
      hdrById.set(n(h.IDcommande_client), {
        IDclient: n(h.IDclient),
        numero: h.numero != null ? n(h.numero) : null,
        est_soldee: n(h.est_soldee),
        ref_client: (h.ref_client ?? '').toString().trim(),
        IDadresse_facturation: n(h.IDadresse_facturation),
        IDadresse_livraison: n(h.IDadresse_livraison),
        // Legacy reads both comment fields as plain text; stripRtf defensively.
        commentaire: stripRtf((h.commentaire ?? '').toString()).trim(),
        commentaire_interne: stripRtf((h.commentaire_interne ?? '').toString()).trim(),
      })
    }
    const cmdIds = Array.from(hdrById.keys()).filter((x) => x > 0)

    // ── 2) Client names + address labels (accent-repaired, batched).
    //  `SELECT *` on `client` returns 0 rows on this driver — explicit columns.
    const clientNomById = new Map<number, string>()
    {
      const ids = Array.from(new Set(Array.from(hdrById.values()).map((h) => h.IDclient).filter((x) => x > 0)))
      const rows = await inChunks(ids, (c) =>
        query<any>(`SELECT IDclient, nom FROM client WHERE IDclient IN (${c})`),
      )
      for (const r of await repairText(rows, 'client', 'IDclient', ['nom']))
        clientNomById.set(n((r as any).IDclient), ((r as any).nom ?? '').toString().trim())
    }
    const adresseNomById = new Map<number, string>()
    {
      const ids = Array.from(new Set(
        Array.from(hdrById.values()).flatMap((h) => [h.IDadresse_facturation, h.IDadresse_livraison]),
      )).filter((x) => x > 0)
      const rows = await inChunks(ids, (c) =>
        query<any>(`SELECT IDadresse, nom FROM adresse WHERE IDadresse IN (${c})`),
      )
      for (const r of await repairText(rows, 'adresse', 'IDadresse', ['nom']))
        adresseNomById.set(n((r as any).IDadresse), ((r as any).nom ?? '').toString().trim())
    }

    // ── 3) Lines (the report rows). TYPE is reserved → alias; IDcolori is
    //  lowercase; delai_annoncé / déverrouiller are accented → never named.
    const lineRows = await inChunks(cmdIds, (c) =>
      query<any>(
        `SELECT IDligne_commande_client, IDcommande_client, TYPE AS type_kind,
                IDreference, IDcolori, IDVariation1, IDVariation2,
                quantite, unite, prix, poids, date_livraison, commentaire
         FROM ligne_commande_client WHERE IDcommande_client IN (${c})`,
      ),
    )
    if (lineRows.length === 0) { res.json([]); return }

    const lines = (await repairText(
      lineRows, 'ligne_commande_client', 'IDligne_commande_client', ['commentaire'],
    )) as any[]
    const lineIds = lines.map((l) => n(l.IDligne_commande_client)).filter((x) => x > 0)

    // ── 4) Catalog maps — ref label + désignation + rendement, polymorphic
    //  by line type (1 = écru, 2 = fini, 3 = divers).
    const refIds = Array.from(new Set(lines.map((l) => n(l.IDreference)).filter((x) => x > 0)))
    const coloriIds = Array.from(new Set(lines.map((l) => n(l.IDcolori)).filter((x) => x > 0)))

    interface RefMeta { reference: string; designation: string; rendement: number; avecTeinture: number }
    const finiRefs = new Map<number, RefMeta>()
    const ecruRefs = new Map<number, RefMeta>()
    const diversRefs = new Map<number, string>()
    if (refIds.length > 0) {
      const [finiRows, ecruRows, diversRows] = await Promise.all([
        inChunks(refIds, (c) =>
          query<any>(
            `SELECT IDref_fini, reference, designation, rendement, avec_teinture
             FROM ref_fini WHERE IDref_fini IN (${c})`,
          ),
        ),
        inChunks(refIds, (c) =>
          query<any>(
            `SELECT IDref_ecru, reference, designation, rendement FROM ref_ecru WHERE IDref_ecru IN (${c})`,
          ),
        ),
        inChunks(refIds, (c) =>
          query<any>(`SELECT IDref_divers, designation FROM ref_divers WHERE IDref_divers IN (${c})`),
        ),
      ])
      for (const r of await repairText(finiRows, 'ref_fini', 'IDref_fini', ['reference', 'designation']))
        finiRefs.set(n((r as any).IDref_fini), {
          reference: ((r as any).reference ?? '').toString().trim(),
          designation: ((r as any).designation ?? '').toString().trim(),
          rendement: n((r as any).rendement),
          avecTeinture: n((r as any).avec_teinture),
        })
      for (const r of await repairText(ecruRows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation']))
        ecruRefs.set(n((r as any).IDref_ecru), {
          reference: ((r as any).reference ?? '').toString().trim(),
          designation: ((r as any).designation ?? '').toString().trim(),
          rendement: n((r as any).rendement),
          avecTeinture: 0,
        })
      for (const r of await repairText(diversRows, 'ref_divers', 'IDref_divers', ['designation']))
        diversRefs.set(n((r as any).IDref_divers), ((r as any).designation ?? '').toString().trim())
    }

    const colorisFini = new Map<number, string>()
    const colorisEcru = new Map<number, string>()
    if (coloriIds.length > 0) {
      const [finiC, ecruC] = await Promise.all([
        inChunks(coloriIds, (c) =>
          query<any>(
            `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${c})`,
          ),
        ),
        inChunks(coloriIds, (c) =>
          query<any>(`SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${c})`),
        ),
      ])
      for (const c of await repairText(finiC, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))
        colorisFini.set(n((c as any).IDref_fini_colori), ((c as any).reference ?? '').toString().trim())
      for (const c of await repairText(ecruC, 'colori_ecru', 'IDcolori_ecru', ['reference']))
        colorisEcru.set(n((c as any).IDcolori_ecru), ((c as any).reference ?? '').toString().trim())
    }

    // Divers variation axes (the article's identity beyond its ref).
    const variationLabels = new Map<number, string>()
    {
      const ids = Array.from(new Set(
        lines.filter((l) => n(l.type_kind) === 3).flatMap((l) => [n(l.IDVariation1), n(l.IDVariation2)]),
      )).filter((x) => x > 0)
      if (ids.length > 0) {
        const rows = await inChunks(ids, (c) =>
          query<any>(
            `SELECT IDref_divers_variation, designation FROM ref_divers_variation WHERE IDref_divers_variation IN (${c})`,
          ),
        )
        for (const v of await repairText(rows, 'ref_divers_variation', 'IDref_divers_variation', ['designation']))
          variationLabels.set(n((v as any).IDref_divers_variation), ((v as any).designation ?? '').toString().trim())
      }
    }

    /** Per-line catalog view: label, désignation and the kg→Ml rendement. */
    function refMetaFor(typeKind: number, refId: number): RefMeta & { kind: 'ecru' | 'fini' | 'divers' | null } {
      const empty = { reference: '', designation: '', rendement: 0, avecTeinture: 0 }
      if (refId <= 0) return { ...empty, kind: null }
      if (typeKind === 2 && finiRefs.has(refId)) return { ...finiRefs.get(refId)!, kind: 'fini' }
      if (typeKind === 1 && ecruRefs.has(refId)) return { ...ecruRefs.get(refId)!, kind: 'ecru' }
      if (typeKind === 3 && diversRefs.has(refId))
        return { ...empty, reference: diversRefs.get(refId)!, kind: 'divers' }
      // Unknown / mistyped line — best effort across the catalogs.
      if (finiRefs.has(refId)) return { ...finiRefs.get(refId)!, kind: 'fini' }
      if (ecruRefs.has(refId)) return { ...ecruRefs.get(refId)!, kind: 'ecru' }
      if (diversRefs.has(refId)) return { ...empty, reference: diversRefs.get(refId)!, kind: 'divers' }
      return { ...empty, kind: null }
    }
    /** Coloris label — dyed finis read ref_fini_colori, wash-only finis and
     *  écru lines read colori_ecru (project_avec_teinture_coloris_rule). */
    function colorisFor(typeKind: number, coloriId: number, refId: number): string {
      if (coloriId <= 0) return ''
      if (typeKind === 2) {
        const dyed = (finiRefs.get(refId)?.avecTeinture ?? 1) !== 0
        return dyed
          ? (colorisFini.get(coloriId) ?? colorisEcru.get(coloriId) ?? '')
          : (colorisEcru.get(coloriId) ?? colorisFini.get(coloriId) ?? '')
      }
      return colorisEcru.get(coloriId) ?? colorisFini.get(coloriId) ?? ''
    }

    // ── 5) Rolls reserved to each line (fini + écru), one flat query each.
    interface Agg { expMetrage: number; expPoids: number; affMetrage: number; affPoids: number; sstMetrage: number; sstPoids: number }
    const newAgg = (): Agg => ({ expMetrage: 0, expPoids: 0, affMetrage: 0, affPoids: 0, sstMetrage: 0, sstPoids: 0 })
    const aggByLine = new Map<number, Agg>()
    const acc = (lid: number): Agg => {
      const a = aggByLine.get(lid) ?? newAgg()
      aggByLine.set(lid, a)
      return a
    }
    // Rendement per line, so écru poids can be converted to Ml.
    const rdtByLine = new Map<number, number>()
    const finiLineIds = new Set<number>()
    for (const l of lines) {
      const lid = n(l.IDligne_commande_client)
      rdtByLine.set(lid, refMetaFor(n(l.type_kind), n(l.IDreference)).rendement)
      if (n(l.type_kind) === 2) finiLineIds.add(lid)
    }

    const finiReserved = await inChunks(lineIds, (c) =>
      query<any>(
        `SELECT IDstock_fini, IDligne_commande_client, metrage, poids,
                IDligne_expedition, IDetat_stock_fini
         FROM stock_fini WHERE IDligne_commande_client IN (${c})`,
      ),
    )
    for (const r of finiReserved as any[]) {
      const lid = n(r.IDligne_commande_client)
      if (lid === 0) continue
      const a = acc(lid)
      const metrage = n(r.metrage)
      const poids = n(r.poids)
      // Shipped = état Expédié (4) or attached to an expedition line.
      if (n(r.IDetat_stock_fini) === 4 || n(r.IDligne_expedition) > 0) {
        a.expMetrage += metrage; a.expPoids += poids
      } else {
        a.affMetrage += metrage; a.affPoids += poids
      }
    }

    const ecruReserved = await inChunks(lineIds, (c) =>
      query<any>(
        `SELECT IDstock_ecru, IDligne_commande_client, metrage, poids,
                IDligne_expedition_ETM, IDref_commande_affectation
         FROM stock_ecru WHERE IDligne_commande_client IN (${c})`,
      ),
    )
    // An écru roll already dyed into a stock_fini is represented by that fini
    // roll — counting its écru form too double-counts the line.
    //
    // The whole set of dyed écru ids comes back in ONE unfiltered query
    // (~45 k single-column rows, ~180 ms). Chunking a `WHERE IDstock_ecru
    // IN (…)` over the 20 k+ reserved ids instead cost 5.9 s across 54 round
    // trips — the dominant cost of the full-history scope, and 54 avoidable
    // hits on the HFSQL server ETM shares with mfprod.
    const dyedEcru = new Set<number>()
    {
      const rows = await query<any>(`SELECT IDstock_ecru FROM stock_fini WHERE IDstock_ecru > 0`)
      for (const r of rows as any[]) dyedEcru.add(n(r.IDstock_ecru))
    }
    for (const r of ecruReserved as any[]) {
      const lid = n(r.IDligne_commande_client)
      if (lid === 0 || dyedEcru.has(n(r.IDstock_ecru))) continue
      const a = acc(lid)
      const poids = n(r.poids)
      const rdt = rdtByLine.get(lid) ?? 0
      const metrage = rdt > 0 ? poids * rdt : n(r.metrage)
      if (n(r.IDligne_expedition_ETM) > 0) {
        a.expMetrage += metrage; a.expPoids += poids
      } else if (n(r.IDref_commande_affectation) > 0 && finiLineIds.has(lid)) {
        // Out at an ennoblisseur, not back yet — "En SST". Only meaningful on
        // a fini line: on an écru line the écru IS what the client ordered.
        a.sstMetrage += metrage; a.sstPoids += poids
      } else {
        a.affMetrage += metrage; a.affPoids += poids
      }
    }

    // ── 6) Free stock of each article (ref + coloris), pre-filtered in SQL so
    //  only genuinely unreserved rolls come back.
    const freeFini = new Map<string, { metrage: number; poids: number }>()
    {
      const ids = Array.from(new Set(
        lines.filter((l) => n(l.type_kind) === 2).map((l) => n(l.IDreference)),
      )).filter((x) => x > 0)
      const rows = await inChunks(ids, (c) =>
        query<any>(
          `SELECT IDref_fini, IDColoris, metrage, poids FROM stock_fini
           WHERE IDref_fini IN (${c})
             AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0)
             AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)
             AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)
             AND IDetat_stock_fini <> 4`,
        ),
      )
      for (const r of rows as any[]) {
        const k = `${n(r.IDref_fini)}|${n(r.IDColoris)}`
        const a = freeFini.get(k) ?? { metrage: 0, poids: 0 }
        a.metrage += n(r.metrage); a.poids += n(r.poids)
        freeFini.set(k, a)
      }
    }
    const freeEcru = new Map<string, { metrage: number; poids: number }>()
    {
      const ids = Array.from(new Set(
        lines.filter((l) => n(l.type_kind) === 1).map((l) => n(l.IDreference)),
      )).filter((x) => x > 0)
      const rows = await inChunks(ids, (c) =>
        query<any>(
          `SELECT IDstock_ecru, IDref_ecru, IDcolori_ecru, metrage, poids FROM stock_ecru
           WHERE IDref_ecru IN (${c})
             AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0)
             AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0)
             AND (IDligne_expedition_TRM IS NULL OR IDligne_expedition_TRM = 0)
             AND (IDref_commande_affectation IS NULL OR IDref_commande_affectation = 0)
             AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)`,
        ),
      )
      for (const r of rows as any[]) {
        // Free écru that has since been dyed is no longer écru on the shelf
        // (same global set as the reserved-écru pass above).
        if (dyedEcru.has(n(r.IDstock_ecru))) continue
        const k = `${n(r.IDref_ecru)}|${n(r.IDcolori_ecru)}`
        const a = freeEcru.get(k) ?? { metrage: 0, poids: 0 }
        a.metrage += n(r.metrage); a.poids += n(r.poids)
        freeEcru.set(k, a)
      }
    }
    // Divers articles carry no rolls: on-hand comes from stock_divers keyed on
    // the (ref, variation1, variation2) triple.
    const freeDivers = new Map<string, number>()
    {
      const ids = Array.from(new Set(
        lines.filter((l) => n(l.type_kind) === 3).map((l) => n(l.IDreference)),
      )).filter((x) => x > 0)
      const rows = await inChunks(ids, (c) =>
        query<any>(
          `SELECT IDref_divers, quantite, IDVariation1, IDVariation2 FROM stock_divers WHERE IDref_divers IN (${c})`,
        ),
      )
      for (const r of rows as any[]) {
        const k = diversKey(n(r.IDref_divers), n(r.IDVariation1), n(r.IDVariation2))
        freeDivers.set(k, (freeDivers.get(k) ?? 0) + n(r.quantite))
      }
    }

    // ── 7) Divers shipments: expedition_divers (per commande) → cartons →
    //  items, summed per article key. Three flat queries for the whole report.
    const diversShipped = new Map<string, number>() // `${cmdId}|${articleKey}`
    if (lines.some((l) => n(l.type_kind) === 3)) {
      const expHeaders = await inChunks(cmdIds, (c) =>
        query<any>(
          `SELECT IDexpedition_divers, IDcommande_client FROM expedition_divers WHERE IDcommande_client IN (${c})`,
        ),
      )
      const cmdByExp = new Map<number, number>()
      for (const e of expHeaders as any[]) cmdByExp.set(n(e.IDexpedition_divers), n(e.IDcommande_client))
      const expIds = Array.from(cmdByExp.keys()).filter((x) => x > 0)
      if (expIds.length > 0) {
        const cartons = await inChunks(expIds, (c) =>
          query<any>(
            `SELECT IDligne_expedition_divers, IDexpedition_divers FROM ligne_expedition_divers WHERE IDexpedition_divers IN (${c})`,
          ),
        )
        const cmdByCarton = new Map<number, number>()
        for (const ca of cartons as any[])
          cmdByCarton.set(n(ca.IDligne_expedition_divers), cmdByExp.get(n(ca.IDexpedition_divers)) ?? 0)
        const cartonIds = Array.from(cmdByCarton.keys()).filter((x) => x > 0)
        if (cartonIds.length > 0) {
          const items = await inChunks(cartonIds, (c) =>
            query<any>(
              `SELECT IDligne_expedition_divers, quantite, IDref_divers, IDVariation1, IDVariation2
               FROM ref_divers_expedie WHERE IDligne_expedition_divers IN (${c})`,
            ),
          )
          for (const i of items as any[]) {
            const cmd = cmdByCarton.get(n(i.IDligne_expedition_divers)) ?? 0
            if (cmd === 0) continue
            const k = `${cmd}|${diversKey(n(i.IDref_divers), n(i.IDVariation1), n(i.IDVariation2))}`
            diversShipped.set(k, (diversShipped.get(k) ?? 0) + n(i.quantite))
          }
        }
      }
    }

    // ── 8) Invoiced € per line: ligne_commande_client → ligne_expedition →
    //  ligne_facture (definitive invoices only — proformas are drafts).
    const invoicedByLine = new Map<number, number>()
    {
      const leRows = await inChunks(lineIds, (c) =>
        query<any>(
          `SELECT IDligne_expedition, IDligne_commande_client FROM ligne_expedition WHERE IDligne_commande_client IN (${c})`,
        ),
      )
      const lineByLe = new Map<number, number>()
      for (const r of leRows as any[]) lineByLe.set(n(r.IDligne_expedition), n(r.IDligne_commande_client))
      const leIds = Array.from(lineByLe.keys()).filter((x) => x > 0)
      if (leIds.length > 0) {
        const lfRows = await inChunks(leIds, (c) =>
          query<any>(
            `SELECT IDligne_expedition, quantite, prix FROM ligne_facture WHERE IDligne_expedition IN (${c})`,
          ),
        )
        for (const r of lfRows as any[]) {
          const lid = lineByLe.get(n(r.IDligne_expedition)) ?? 0
          if (lid === 0) continue
          invoicedByLine.set(lid, (invoicedByLine.get(lid) ?? 0) + n(r.quantite) * n(r.prix))
        }
      }
    }

    // ── 9) Assemble one row per line.
    const out: RapportClientLineRow[] = lines.map((l) => {
      const lineId = n(l.IDligne_commande_client)
      const cmdId = n(l.IDcommande_client)
      const hdr = hdrById.get(cmdId)
      const typeKind = n(l.type_kind)
      const refId = n(l.IDreference)
      const unite = n(l.unite)
      const meta = refMetaFor(typeKind, refId)
      const agg = aggByLine.get(lineId) ?? newAgg()
      const useMl = isMetrage(unite)
      const pick = (m: number, p: number) => round2(useMl ? m : p)

      let qteExpediee: number
      let qteAffectee: number
      let qteEnSst: number
      let qteStock: number
      if (typeKind === 3) {
        const key = diversKey(refId, n(l.IDVariation1), n(l.IDVariation2))
        qteExpediee = round2(diversShipped.get(`${cmdId}|${key}`) ?? 0)
        qteAffectee = 0
        qteEnSst = 0
        qteStock = round2(freeDivers.get(key) ?? 0)
      } else {
        qteExpediee = pick(agg.expMetrage, agg.expPoids)
        qteAffectee = pick(agg.affMetrage, agg.affPoids)
        qteEnSst = pick(agg.sstMetrage, agg.sstPoids)
        const free = typeKind === 1
          ? freeEcru.get(`${refId}|${n(l.IDcolori)}`)
          : freeFini.get(`${refId}|${n(l.IDcolori)}`)
        // Écru rolls carry metrage = 0 — convert via the ref's rendement.
        const freeMetrage = typeKind === 1 && meta.rendement > 0
          ? (free?.poids ?? 0) * meta.rendement
          : (free?.metrage ?? 0)
        qteStock = round2(useMl ? freeMetrage : (free?.poids ?? 0))
      }

      const qte = n(l.quantite)
      const prix = n(l.prix)
      const totalHt = round2(qte * prix)
      const totalHtNonFacture = round2(totalHt - (invoicedByLine.get(lineId) ?? 0))

      const delai = dateDigits(l.date_livraison) || null
      const estSoldee = hdr?.est_soldee ?? 0
      // A line is "done" once the order is settled or everything shipped —
      // no point flagging it as late.
      const done = estSoldee === 1 || (qte > 0 && qteExpediee >= qte)

      let retard: number | null = null
      let urgency: 'late' | 'soon' | null = null
      if (!done && delai) {
        const d = daysFromToday(delai)
        if (d !== null) {
          if (d < 0) retard = -d
          if (d <= 0) urgency = 'late'
          else if (d <= 3) urgency = 'soon'
        }
      }

      // Divers lines have no coloris; their identity is the variation pair.
      const designation = typeKind === 3
        ? [n(l.IDVariation1), n(l.IDVariation2)]
            .map((v) => (v > 0 ? variationLabels.get(v) ?? '' : ''))
            .filter(Boolean)
            .join(' · ')
        : meta.designation

      return {
        IDligne_commande_client: lineId,
        IDcommande_client: cmdId,
        numero: hdr?.numero ?? null,
        client_nom: clientNomById.get(hdr?.IDclient ?? 0) ?? '',
        ref_client: hdr?.ref_client ?? '',
        facturation_nom: adresseNomById.get(hdr?.IDadresse_facturation ?? 0) ?? '',
        livraison_nom: adresseNomById.get(hdr?.IDadresse_livraison ?? 0) ?? '',
        reference: meta.reference,
        coloris: colorisFor(typeKind, n(l.IDcolori), refId),
        designation,
        type_kind: typeKind,
        unite_label: uniteLabel(unite),
        poids: round2(n(l.poids)),
        qte_commandee: round2(qte),
        qte_expediee: qteExpediee,
        qte_stock: qteStock,
        qte_affectee: qteAffectee,
        qte_en_sst: qteEnSst,
        prix,
        total_ht: totalHt,
        total_ht_non_facture: totalHtNonFacture,
        delai,
        retard_jours: retard,
        commentaire_ligne: stripRtf((l.commentaire ?? '').toString()).trim(),
        commentaire_client: hdr?.commentaire ?? '',
        commentaire_interne: hdr?.commentaire_interne ?? '',
        urgency,
        est_soldee: estSoldee,
      }
    })

    // Default order: most recent commande first, then line id.
    out.sort((a, b) =>
      b.IDcommande_client - a.IDcommande_client ||
      a.IDligne_commande_client - b.IDligne_commande_client,
    )

    res.json(out)
  } catch (err) {
    console.error('[rapports/commandes-clients]', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// Rapport › Commandes de fils  (legacy `FI_Rapport_fil.wdw`)
// ═══════════════════════════════════════════════════════════════════════
//
// One row per `ref_fil_commande` line. The legacy screen scopes on OPEN
// lines of OPEN commandes (`commande_fil.etat = 0 AND ref_fil_commande.etat
// = 0`) — a line that has been fully received closes itself (etat=1) and
// drops out even while its parent commande is still open. `terminees=1`
// lifts both filters so the full purchasing history can be exported.
//
// Computed phase (there is no `sstatut` on a yarn line, only etat 0/1).
// Reception is tested FIRST: once lots have landed, "waiting for a délai" is
// no longer what the line is about, even if `date_livraison` was never set
// (which is the common case — legacy users close the line instead).
//   terminee      etat = 1 (line or its commande)
//   recue         open + received ≥ ordered → delivered, just not closed yet
//   partielle     open + some stock_fil lots linked, still short
//   attente_delai open + nothing received + no `date_livraison` → still
//                 waiting for the supplier to announce a delivery date; the
//                 deadline that matters is `date_notif` (the relance date)
//   en_cours      open + delivery date announced, nothing received yet
//
// Urgency mirrors the SST report (§30 language — red = due/overdue/missing,
// amber = within 3 days / next working day). The anchor date follows the
// phase: `date_notif` while waiting for a délai, `date_livraison` otherwise
// (falling back to `date_notif` on a partial line that never got a date).
// `recue` and `terminee` lines carry no urgency — nothing is pending.

interface RapportFilRow {
  IDref_fil_commande: number
  IDcommande_fil: number
  phase: 'terminee' | 'recue' | 'partielle' | 'attente_delai' | 'en_cours'
  fournisseur_nom: string
  reference: string
  coloris: string
  qte_commandee: number
  qte_recue: number
  qte_restante: number
  nb_lots: number
  prix_unitaire: number
  montant: number
  date_commande: string | null
  date_livraison: string | null
  date_notif: string | null
  retard_jours: number | null
  commentaire: string
  journal: string
  urgency: 'late' | 'soon' | null
  etat_ligne: number
  etat_commande: number
}

// GET /api/rapports/commandes-fil?terminees=0|1
//   terminees=0 (default) → open lines of open commandes (legacy scope)
//   terminees=1           → every line, including received / closed ones
rapportsRouter.get('/commandes-fil', async (req: Request, res: Response) => {
  try {
    const includeTerminees = String(req.query.terminees ?? '0') === '1'

    // ── 1) Commande headers (the scope). Most recent first; capped.
    const headerRows = await query<{
      IDcommande_fil: number
      IDfournisseur: number
      date_commande: string | null
      etat: number | null
      commentaire: string | null
      journal: string | null
    }>(
      `SELECT TOP ${MAX_COMMANDES}
              IDcommande_fil, IDfournisseur, date_commande, etat, commentaire, journal
       FROM commande_fil
       ${includeTerminees ? '' : 'WHERE etat = 0'}
       ORDER BY IDcommande_fil DESC`,
    )
    if (headerRows.length === 0) { res.json([]); return }

    const fixedHeaders = (await fixEncoding(
      headerRows as any[],
      'commande_fil',
      'IDcommande_fil',
      ['commentaire', 'journal'],
    )) as any[]

    interface Hdr {
      IDfournisseur: number
      date_commande: string
      etat: number
      commentaire: string
      journal: string
    }
    const hdrById = new Map<number, Hdr>()
    for (const h of fixedHeaders) {
      hdrById.set(n(h.IDcommande_fil), {
        IDfournisseur: n(h.IDfournisseur),
        date_commande: dateDigits(h.date_commande),
        etat: n(h.etat),
        // Yarn-order commentaire/journal are plain text, but legacy RTF rows
        // may survive in old records — strip defensively (no-op on plain).
        commentaire: stripRtf((h.commentaire ?? '').toString()).trim(),
        journal: stripRtf((h.journal ?? '').toString()).trim(),
      })
    }
    const cmdIds = Array.from(hdrById.keys()).filter((x) => x > 0)

    // ── 2) Fournisseur names (accent-repaired).
    const frsIds = Array.from(new Set(Array.from(hdrById.values()).map((h) => h.IDfournisseur).filter((x) => x > 0)))
    const frsNomById = new Map<number, string>()
    if (frsIds.length > 0) {
      const rows = await inChunks(frsIds, (chunk) =>
        query<{ IDfournisseur: number; nom: string | null }>(
          `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${chunk})`,
        ),
      )
      for (const r of await fixEncoding(rows as any[], 'fournisseur', 'IDfournisseur', ['nom']))
        frsNomById.set(n((r as any).IDfournisseur), ((r as any).nom ?? '').toString().trim())
    }

    // ── 3) Lines (the report rows).
    const lineRows = await inChunks(cmdIds, (chunk) =>
      query<{
        IDref_fil_commande: number
        IDcommande_fil: number
        IDref_fil: number | null
        IDcolori_fil: number | null
        quantite: number | null
        prix_unitaire: number | null
        date_livraison: string | null
        date_notif: string | null
        etat: number | null
      }>(
        `SELECT rfc.IDref_fil_commande, rfc.IDcommande_fil, rfc.IDref_fil, rfc.IDcolori_fil,
                rfc.quantite, rfc.prix_unitaire, rfc.date_livraison, rfc.date_notif, rfc.etat
         FROM ref_fil_commande rfc
         WHERE rfc.IDcommande_fil IN (${chunk})${includeTerminees ? '' : ' AND rfc.etat = 0'}`,
      ),
    )
    if (lineRows.length === 0) { res.json([]); return }

    const lineIds = lineRows.map((l) => n(l.IDref_fil_commande)).filter((x) => x > 0)

    // ── 4) Ref + coloris labels (accent-repaired, one query per catalog).
    const refIds = Array.from(new Set(lineRows.map((l) => n(l.IDref_fil)).filter((x) => x > 0)))
    const coloriIds = Array.from(new Set(lineRows.map((l) => n(l.IDcolori_fil)).filter((x) => x > 0)))

    const refMap = new Map<number, string>()
    if (refIds.length > 0) {
      const rows = await inChunks(refIds, (c) =>
        query<{ IDref_fil: number; reference: string | null }>(
          `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${c})`,
        ),
      )
      for (const r of await fixEncoding(rows as any[], 'ref_fil', 'IDref_fil', ['reference']))
        refMap.set(n((r as any).IDref_fil), ((r as any).reference ?? '').toString().trim())
    }

    const coloriMap = new Map<number, string>()
    if (coloriIds.length > 0) {
      const rows = await inChunks(coloriIds, (c) =>
        query<{ IDcolori_fil: number; reference: string | null }>(
          `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${c})`,
        ),
      )
      for (const r of await fixEncoding(rows as any[], 'colori_fil', 'IDcolori_fil', ['reference']))
        coloriMap.set(n((r as any).IDcolori_fil), ((r as any).reference ?? '').toString().trim())
    }

    // ── 5) Received quantities: every stock_fil lot pointing at the line.
    //      `stock_initial` is the weight as received (`stock` is what's left
    //      after consumption, which is not what "réceptionné" means here).
    const recuByLine = new Map<number, { kg: number; lots: number }>()
    {
      const rows = await inChunks(lineIds, (c) =>
        query<{ IDref_fil_commande: number; stock_initial: number | null }>(
          `SELECT IDref_fil_commande, stock_initial FROM stock_fil WHERE IDref_fil_commande IN (${c})`,
        ),
      )
      for (const r of rows) {
        const lid = n(r.IDref_fil_commande)
        if (lid === 0) continue
        const acc = recuByLine.get(lid) ?? { kg: 0, lots: 0 }
        acc.kg += n(r.stock_initial)
        acc.lots += 1
        recuByLine.set(lid, acc)
      }
    }

    // ── 6) Assemble one row per line.
    const today0 = new Date(); today0.setHours(0, 0, 0, 0)
    const nextWorkingDay = addWorkingDays(today0, 1)

    const out: RapportFilRow[] = lineRows.map((l) => {
      const lineId = n(l.IDref_fil_commande)
      const cmdId = n(l.IDcommande_fil)
      const hdr = hdrById.get(cmdId)
      const etatLigne = n(l.etat)
      const etatCommande = hdr?.etat ?? 0
      const done = etatLigne === 1 || etatCommande === 1

      const dateLivraison = dateDigits(l.date_livraison) || null
      const dateNotif = dateDigits(l.date_notif) || null
      const recu = recuByLine.get(lineId) ?? { kg: 0, lots: 0 }
      const qteCommandee = n(l.quantite)
      const prix = n(l.prix_unitaire)

      // Phase — see the header comment for the decision table.
      let phase: RapportFilRow['phase']
      if (done) phase = 'terminee'
      else if (qteCommandee > 0 && recu.kg >= qteCommandee) phase = 'recue'
      else if (recu.kg > 0) phase = 'partielle'
      else if (!dateLivraison) phase = 'attente_delai'
      else phase = 'en_cours'

      // Nothing is pending on a fully-received or closed line — no deadline
      // to miss, so no retard and no urgency tint.
      const settled = done || phase === 'recue'

      // Retard = positive overdue days against the deadline that matters for
      // the phase (relance while waiting for a délai, delivery date after).
      const anchor = phase === 'attente_delai' ? dateNotif : (dateLivraison ?? dateNotif)
      let retard: number | null = null
      if (!settled && anchor) {
        const d = daysFromToday(anchor)
        if (d !== null && d < 0) retard = -d
      }

      // Urgency tint (§30 language: red late / amber soon / none).
      let urgency: 'late' | 'soon' | null = null
      if (!settled) {
        if (!anchor) {
          // No deadline at all on an open line is a data-quality problem the
          // user should see as red (same rule as `deliveryUrgency`).
          urgency = 'late'
        } else {
          const target = new Date(
            Number(anchor.slice(0, 4)), Number(anchor.slice(4, 6)) - 1, Number(anchor.slice(6, 8)),
          )
          target.setHours(0, 0, 0, 0)
          if (target.getTime() <= today0.getTime()) urgency = 'late'
          else if (
            phase === 'attente_delai'
              ? target.getTime() <= nextWorkingDay.getTime()
              : (target.getTime() - today0.getTime()) / 86_400_000 <= 3
          ) urgency = 'soon'
        }
      }

      return {
        IDref_fil_commande: lineId,
        IDcommande_fil: cmdId,
        phase,
        fournisseur_nom: frsNomById.get(hdr?.IDfournisseur ?? 0) ?? '',
        reference: refMap.get(n(l.IDref_fil)) ?? '',
        coloris: coloriMap.get(n(l.IDcolori_fil)) ?? '',
        qte_commandee: qteCommandee,
        qte_recue: recu.kg,
        // "Reste à recevoir" answers *what am I still waiting for* — a closed
        // or fully-received line is waiting for nothing, even when legacy
        // never linked its stock lots (which would otherwise leave the whole
        // ordered quantity showing as outstanding on every historical line).
        qte_restante: settled ? 0 : Math.max(0, qteCommandee - recu.kg),
        nb_lots: recu.lots,
        prix_unitaire: prix,
        montant: qteCommandee * prix,
        date_commande: hdr?.date_commande || null,
        date_livraison: dateLivraison,
        date_notif: dateNotif,
        retard_jours: retard,
        commentaire: hdr?.commentaire || '',
        journal: hdr?.journal || '',
        urgency,
        etat_ligne: etatLigne,
        etat_commande: etatCommande,
      }
    })

    // Default order: most recent commande first, then line id.
    out.sort((a, b) =>
      b.IDcommande_fil - a.IDcommande_fil ||
      a.IDref_fil_commande - b.IDref_fil_commande,
    )

    res.json(out)
  } catch (err) {
    console.error('[rapports/commandes-fil]', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// Finance — ports the legacy WinDev "Analyse › Finance" tab.
//
// DATA MODEL (reverse-engineered from the live DB, 2026-07-28)
//
//   upload_compta   One row per accountant balance upload, per société.
//                   `DATE` (YYYYMMDD) + the pre-computed aggregates
//                   produits / charges / frais_fixe / frais_variable /
//                   provisions. Uploads land roughly weekly and each one is
//                   a CUMULATIVE year-to-date balance, not a delta.
//   compte_compta   Chart of accounts, partitioned by `id_societe`.
//                   `numero` (6-digit PCG account), `libelle`,
//                   `frais_variable` (0 = charge fixe, 1 = charge variable)
//                   and `Description` — a free-text annotation the user
//                   maintains ("Salaires Isa, Pierrot, Laetitia, Eloise").
//                   The same `numero` exists once per société.
//   releve_compta   One row per (account, upload date) with debit / credit.
//
// THE RULE (verified to the cent against the legacy screen)
//
//   montant(compte, année) = debit − credit of the releve_compta row at the
//   LAST upload date falling inside that CALENDAR year.
//
//   The "last upload of the year" — not the sum, because balances are
//   cumulative; and not the January upload that closes the prior exercise
//   (2026-01-05 carries the final 2025 figures, yet legacy reports 2025 as
//   of 2025-12-22, its last in-year upload).
//
//   pourcentage = round(montant / montant_precedent × 100), 0 when N-1 is 0.
//
// SCOPE
//
//   • Société 1 (ETM) only — this is the ETM app; TRM has its own.
//   • Class-7 accounts (numero >= 700000) are produits, not charges, and are
//     excluded. Proof: summing the class-6 accounts of each frais_variable
//     bucket reproduces upload_compta.frais_fixe / .frais_variable exactly
//     (111 604,54 € / 610 431,35 € at 2026-03-23) — they balance only once
//     the 7xxxxx rows are dropped.
//   • Accounts with no releve row at either reference date are hidden, which
//     is what makes the legacy variable list 15 rows long rather than the 18
//     rows compte_compta holds.
//
// HFSQL discipline: `DATE` is a reserved word but survives in both the
// SELECT list and the WHERE clause (verified); flat set-based queries only
// (4 per request, independent of row count); accent repair is batched via
// repairAliased so empty `Description` values never enter a CONVERT.

/** The only société this app reports on. See CLAUDE.md §IDsociete. */
const SOCIETE_ETM = 1
/** Accounts at or above this number are produits (PCG class 7), not charges. */
const CLASS_7 = 700000

/** SQL literal for a user-supplied text value. Pure ASCII → quoted literal;
 *  anything with accents → Latin-1 hex literal (the Linux iODBC bridge
 *  corrupts raw multi-byte UTF-8 embedded in a SQL line). */
function sqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(v)) return `'${esc(v)}'`
  const ascii = v
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
  const bytes = Buffer.from(
    Array.from(ascii, (ch) => {
      const c = ch.codePointAt(0) ?? 0x3f
      return c <= 0xff ? c : 0x3f
    }),
  )
  return `x'${bytes.toString('hex')}'`
}

interface UploadRow {
  DATE: string | null
  produits: number | null
  charges: number | null
  frais_fixe: number | null
  frais_variable: number | null
  provisions: number | null
}

interface YearAnchor {
  /** YYYYMMDD of the last upload inside the calendar year. */
  date: string
  produits: number
  charges: number
  frais_fixe: number
  frais_variable: number
  provisions: number
}

/** Last upload of each calendar year for the ETM société, keyed by year. */
async function loadYearAnchors(): Promise<Map<number, YearAnchor>> {
  const rows = await query<UploadRow>(
    `SELECT DATE, produits, charges, frais_fixe, frais_variable, provisions
     FROM upload_compta WHERE id_societe = ${SOCIETE_ETM}`,
  )
  const byYear = new Map<number, YearAnchor>()
  for (const r of rows) {
    const d = dateDigits(r.DATE)
    if (!/^\d{8}$/.test(d)) continue
    const year = Number(d.slice(0, 4))
    const prev = byYear.get(year)
    if (prev && prev.date >= d) continue
    byYear.set(year, {
      date: d,
      produits: n(r.produits),
      charges: n(r.charges),
      frais_fixe: n(r.frais_fixe),
      frais_variable: n(r.frais_variable),
      provisions: n(r.provisions),
    })
  }
  return byYear
}

/** debit − credit per account at one upload date. Empty map for a null date. */
async function loadBalanceAt(date: string | null): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!date || !/^\d{8}$/.test(date)) return out
  const rows = await query<{ IDcompte_compta: number; debit: number | null; credit: number | null }>(
    `SELECT IDcompte_compta, debit, credit FROM releve_compta WHERE DATE = '${date}'`,
  )
  for (const r of rows) {
    const id = n(r.IDcompte_compta)
    if (id <= 0) continue
    out.set(id, n(r.debit) - n(r.credit))
  }
  return out
}

interface CompteRow {
  IDcompte_compta: number
  numero: number | null
  libelle: string | null
  frais_variable: number | null
  description: string | null
}

/** Chart of accounts for ETM, accents repaired, class-7 rows dropped. */
async function loadComptes(): Promise<CompteRow[]> {
  const rows = await query<CompteRow>(
    `SELECT IDcompte_compta, numero, libelle, frais_variable, Description AS description
     FROM compte_compta WHERE id_societe = ${SOCIETE_ETM}`,
  )
  const fixed = await repairAliased(
    rows as unknown as Record<string, unknown>[],
    'compte_compta',
    'IDcompte_compta',
    { libelle: 'libelle', description: 'Description' },
  )
  return (fixed as unknown as CompteRow[]).filter((c) => {
    const num = n(c.numero)
    return num > 0 && num < CLASS_7
  })
}

/** round(cur / prev × 100), 0 when there is nothing to compare against. */
function pourcentage(cur: number, prev: number): number {
  if (!prev) return 0
  return Math.round((cur / prev) * 100)
}

// GET /api/rapports/finance?annee=YYYY
//   annee omitted → the most recent year holding an upload.
rapportsRouter.get('/finance', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'view_rapport_finance')
    if (!allowed) {
      res.status(403).json({ error: 'forbidden', message: 'Accès au rapport finance non autorisé.' })
      return
    }

    const anchors = await loadYearAnchors()
    const annees = Array.from(anchors.keys()).sort((a, b) => b - a)
    if (annees.length === 0) {
      res.json({ annees: [], annee: null, annee_precedente: null, lignes: [], totaux: null })
      return
    }

    const asked = Number.parseInt(String(req.query.annee ?? ''), 10)
    const annee = anchors.has(asked) ? asked : annees[0]
    const anneePrec = annee - 1

    const cur = anchors.get(annee)!
    // Strictly N-1: with a gap year the comparison column is simply empty,
    // which is honest — silently comparing against N-2 under a "N-1" header
    // would be worse than showing nothing.
    const prev = anchors.get(anneePrec) ?? null

    const [comptes, balCur, balPrev] = await Promise.all([
      loadComptes(),
      loadBalanceAt(cur.date),
      loadBalanceAt(prev?.date ?? null),
    ])

    const lignes = comptes
      // Legacy hides accounts absent from both reference balances.
      .filter((c) => balCur.has(n(c.IDcompte_compta)) || balPrev.has(n(c.IDcompte_compta)))
      .map((c) => {
        const id = n(c.IDcompte_compta)
        const montant = balCur.get(id) ?? 0
        const montantPrec = balPrev.get(id) ?? 0
        return {
          IDcompte_compta: id,
          numero: n(c.numero),
          libelle: (c.libelle ?? '').toString().trim(),
          description: (c.description ?? '').toString().trim(),
          variable: n(c.frais_variable) === 1 ? 1 : 0,
          montant,
          montant_precedent: montantPrec,
          ecart: montant - montantPrec,
          pourcentage: pourcentage(montant, montantPrec),
        }
      })
      .sort((a, b) => a.numero - b.numero)

    res.json({
      annees,
      annee,
      annee_precedente: prev ? anneePrec : null,
      date_arrete: cur.date,
      date_arrete_precedente: prev?.date ?? null,
      totaux: {
        produits: cur.produits,
        charges: cur.charges,
        frais_fixe: cur.frais_fixe,
        frais_variable: cur.frais_variable,
        provisions: cur.provisions,
        produits_precedent: prev?.produits ?? 0,
        charges_precedent: prev?.charges ?? 0,
        frais_fixe_precedent: prev?.frais_fixe ?? 0,
        frais_variable_precedent: prev?.frais_variable ?? 0,
        provisions_precedent: prev?.provisions ?? 0,
      },
      lignes,
    })
  } catch (err) {
    console.error('[rapports/finance]', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// GET /api/rapports/finance/comptes/:id/historique
//   Year-end value of one account across every year holding an upload.
rapportsRouter.get('/finance/comptes/:id/historique', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'view_rapport_finance')
    if (!allowed) { res.status(403).json({ error: 'forbidden' }); return }

    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return }

    const anchors = await loadYearAnchors()
    // date → year, so one flat read over the account's own rows folds into
    // the year series without a query per year.
    const yearByDate = new Map<string, number>()
    for (const [year, a] of anchors) yearByDate.set(a.date, year)

    const rows = await query<{ DATE: string | null; debit: number | null; credit: number | null }>(
      `SELECT DATE, debit, credit FROM releve_compta WHERE IDcompte_compta = ${id}`,
    )
    const byYear = new Map<number, number>()
    for (const r of rows) {
      const year = yearByDate.get(dateDigits(r.DATE))
      if (year === undefined) continue
      byYear.set(year, n(r.debit) - n(r.credit))
    }

    res.json(
      Array.from(anchors.keys())
        .sort((a, b) => a - b)
        .map((annee) => ({ annee, montant: byYear.get(annee) ?? 0 })),
    )
  } catch (err) {
    console.error('[rapports/finance/historique]', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// PATCH /api/rapports/finance/comptes/:id  { description }
//   The free-text annotation shown in the "description" column. Scoped to
//   the ETM société so an id from another partition can't be written.
rapportsRouter.patch('/finance/comptes/:id', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const admin = isEffectiveAdmin(req)
    const canView = await userHasPermission(req.userId, admin, 'view_rapport_finance')
    const canEdit = await userHasPermission(req.userId, admin, 'edit_compte_description')
    if (!canView || !canEdit) {
      res.status(403).json({ error: 'forbidden', message: 'Modification des comptes non autorisée.' })
      return
    }

    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return }

    const raw = req.body?.description
    if (raw != null && typeof raw !== 'string') {
      res.status(400).json({ error: 'description must be a string' }); return
    }
    const description = (raw ?? '').toString().slice(0, 255)

    const scope = await query<{ IDcompte_compta: number }>(
      `SELECT IDcompte_compta FROM compte_compta
       WHERE IDcompte_compta = ${id} AND id_societe = ${SOCIETE_ETM}`,
    )
    if (scope.length === 0) { res.status(404).json({ error: 'Compte not found' }); return }

    await query(`UPDATE compte_compta SET Description = ${sqlText(description)} WHERE IDcompte_compta = ${id}`)

    // HFSQL has no RETURNING — read back so the client hydrates the repaired value.
    const after = await query<{ IDcompte_compta: number; description: string | null }>(
      `SELECT IDcompte_compta, Description AS description FROM compte_compta WHERE IDcompte_compta = ${id}`,
    )
    const fixed = await repairAliased(
      after as unknown as Record<string, unknown>[],
      'compte_compta',
      'IDcompte_compta',
      { description: 'Description' },
    )
    res.json({
      IDcompte_compta: id,
      description: ((fixed[0]?.description ?? '') as string).toString().trim(),
    })
  } catch (err) {
    console.error('[rapports/finance PATCH]', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// ── Chiffre d'affaires par client ─────────────────────────────────────────
// Ports the legacy "Comparatif CA" dashboard block and its "Rapport CA/Client"
// monthly detail window (FI_Comparatif_CA.wdw / FEN_Rapport_CA_Client.wdw).
//
// The revenue formula was reverse-engineered from the legacy screen (its
// WinDev queries are PCS-compressed and unreadable) and reproduces its figures
// to the centime on the 2025 and 2026 books:
//
//   CA(client, période) = Σ round2(ligne_facture.quantite × ligne_facture.prix)
//
// over every `facture` with IDsociete = 1 whose DATE falls in the period, with
// `facture.TYPE = 2` (avoir / credit note) counted NEGATIVE. The rounding is
// applied PER LINE — summing the raw floats drifts by a few centimes a year
// and stops matching the legacy totals (2025: 2 684 442,74 € vs 2 684 442,81 €).
//
// HFSQL discipline: `DATE` and `TYPE` are reserved words on `facture` and come
// back uppercased unless aliased; client names are read by a separate flat
// query (no inline CONVERT inside the JOIN — that collapses result sets) and
// repaired with a batched fixEncoding.

const CA_SOCIETE = 1
/** facture.TYPE for an avoir (credit note) — subtracted from revenue. */
const FACTURE_TYPE_AVOIR = 2

interface CaLineRow {
  idc: number
  t: number
  d: string
  q: number
  p: number
}

/** Per-client revenue for one year: yearly total + the 12 monthly buckets. */
interface CaClientAgg {
  total: number
  months: number[]
}

/** Round a monetary amount to the centime (legacy rounds each invoice line). */
function euro(v: number): number {
  return Math.round(v * 100) / 100
}

/** Sum euro amounts without float drift (accumulates in integer centimes). */
function sumEuros(values: number[]): number {
  return values.reduce((s, v) => s + Math.round(v * 100), 0) / 100
}

/** Aggregate `ligne_facture` revenue per client for one calendar year.
 *
 *  Amounts are accumulated in INTEGER CENTIMES and only converted back to
 *  euros at the end: adding thousands of already-rounded float centimes drifts
 *  by a centime here and there, which is enough to make a monthly bucket
 *  disagree with the legacy report. */
async function caForYear(year: number): Promise<Map<number, CaClientAgg>> {
  const rows = await query<CaLineRow>(
    `SELECT f.IDclient AS idc, f.TYPE AS t, f.DATE AS d, lf.quantite AS q, lf.prix AS p
       FROM facture f
       JOIN ligne_facture lf ON lf.IDfacture = f.IDfacture
      WHERE f.IDsociete = ${CA_SOCIETE}
        AND f.DATE >= '${year}0101' AND f.DATE <= '${year}1231'`,
  )
  const cents = new Map<number, { total: number; months: number[] }>()
  for (const r of rows) {
    const idc = Number(r.idc)
    if (!Number.isInteger(idc) || idc <= 0) continue
    const month = Number(String(r.d ?? '').slice(4, 6)) - 1
    if (month < 0 || month > 11) continue
    let amount = Math.round(n(r.q) * n(r.p) * 100)
    if (Number(r.t) === FACTURE_TYPE_AVOIR) amount = -amount
    let agg = cents.get(idc)
    if (!agg) {
      agg = { total: 0, months: new Array<number>(12).fill(0) }
      cents.set(idc, agg)
    }
    agg.total += amount
    agg.months[month] += amount
  }
  const out = new Map<number, CaClientAgg>()
  for (const [idc, agg] of cents) {
    out.set(idc, { total: agg.total / 100, months: agg.months.map((c) => c / 100) })
  }
  return out
}

/** Every year carrying at least one ETM invoice, most recent first. */
async function caAvailableYears(): Promise<number[]> {
  const rows = await query<{ mn: string | null; mx: string | null }>(
    `SELECT MIN(DATE) AS mn, MAX(DATE) AS mx FROM facture WHERE IDsociete = ${CA_SOCIETE}`,
  )
  const min = Number(String(rows[0]?.mn ?? '').slice(0, 4))
  const max = Number(String(rows[0]?.mx ?? '').slice(0, 4))
  const now = new Date().getFullYear()
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1990 || max < min) return [now]
  const years: number[] = []
  for (let y = Math.max(max, now); y >= min; y--) years.push(y)
  return years
}

/** Resolve client display names for a set of ids (batched + accent-repaired). */
async function caClientNames(ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  if (ids.length === 0) return map
  const rows = await inChunks(ids, (chunk) =>
    query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDclient IN (${chunk})`,
    ),
  )
  const fixed = await fixEncoding(rows, 'client', 'IDclient', ['nom'])
  for (const r of fixed) map.set(Number(r.IDclient), (r.nom ?? '').trim())
  return map
}

/** Parse + clamp the `year` query param, defaulting to the current year. */
function parseYear(raw: unknown): number {
  const y = parseInt(String(raw ?? ''), 10)
  const now = new Date().getFullYear()
  if (!Number.isInteger(y) || y < 1990 || y > now + 5) return now
  return y
}

/** Guard both CA endpoints behind `dashboard_ca` — revenue per client is the
 *  most sensitive data the app exposes, so the API refuses it outright rather
 *  than relying on the widget being hidden. */
async function requireCaPermission(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'dashboard_ca')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: dashboard_ca' })
    return false
  }
  return true
}

// GET /api/rapports/ca-clients?year=YYYY
// Comparatif CA: every client ranked by revenue for `year`, carrying the
// previous year's revenue and rank so the UI can show the rank delta.
rapportsRouter.get('/ca-clients', async (req: Request, res: Response) => {
  if (!(await requireCaPermission(req, res))) return
  try {
    const year = parseYear(req.query.year)
    const prevYear = year - 1
    const [years, cur, prev] = await Promise.all([
      caAvailableYears(),
      caForYear(year),
      caForYear(prevYear),
    ])

    const ids = [...new Set([...cur.keys(), ...prev.keys()])]
    const names = await caClientNames(ids)

    // Previous-year ranking is computed over the clients that actually billed
    // something that year — a client with no CA has no rank, not rank #last.
    const prevRank = new Map<number, number>()
    ;[...prev.entries()]
      .filter(([, a]) => a.total !== 0)
      .sort((a, b) => b[1].total - a[1].total)
      .forEach(([idc], i) => prevRank.set(idc, i + 1))

    const rows = ids
      .map((idc) => ({
        IDclient: idc,
        nom: names.get(idc) || `#${idc}`,
        ca: cur.get(idc)?.total ?? 0,
        ca_prev: prev.get(idc)?.total ?? 0,
      }))
      .filter((r) => r.ca !== 0 || r.ca_prev !== 0)
      .sort((a, b) => b.ca - a.ca || a.nom.localeCompare(b.nom, 'fr'))
      .map((r, i) => ({ ...r, rang: i + 1, rang_prev: prevRank.get(r.IDclient) ?? null }))

    res.json({
      year,
      previous_year: prevYear,
      years,
      rows,
      total: sumEuros(rows.map((r) => r.ca)),
      total_prev: sumEuros(rows.map((r) => r.ca_prev)),
    })
  } catch (err) {
    console.error('[rapports/ca-clients]', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// GET /api/rapports/ca-mensuel?year=YYYY
// Monthly CA matrix — the legacy "Rapport CA/Client" window: one row per
// client, one column per month, plus per-month and grand totals.
rapportsRouter.get('/ca-mensuel', async (req: Request, res: Response) => {
  if (!(await requireCaPermission(req, res))) return
  try {
    const year = parseYear(req.query.year)
    const [years, cur] = await Promise.all([caAvailableYears(), caForYear(year)])
    const names = await caClientNames([...cur.keys()])

    const rows = [...cur.entries()]
      .map(([idc, agg]) => ({
        IDclient: idc,
        nom: names.get(idc) || `#${idc}`,
        months: agg.months,
        total: agg.total,
      }))
      .filter((r) => r.total !== 0 || r.months.some((m) => m !== 0))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))

    const monthlyTotals = Array.from({ length: 12 }, (_, i) =>
      sumEuros(rows.map((r) => r.months[i])),
    )

    res.json({
      year,
      years,
      rows,
      monthly_totals: monthlyTotals,
      total: sumEuros(rows.map((r) => r.total)),
    })
  } catch (err) {
    console.error('[rapports/ca-mensuel]', err)
    res.status(500).json({ error: (err as Error).message })
  }
})
