import { Router, type Request, type Response } from 'express'
import { mpsPg } from '../lib/mps-pg.js'
import { consumedEcruIds } from '../lib/fini-sources.js'
import { calculerEtatFil } from '../lib/fil-etat.js'
import { calculerStockPotentiel, type CompositionRow } from '../lib/stock-potentiel.js'

// GET /api/stock/potentiel — Finis › Stock potentiel (rules in
// lib/stock-potentiel.ts). This file only reads the free stock:
//
//   fini  in stock (not on an avis, not état 4), not affected to a client
//         line, not flagged « Don », not on a donation order — every état;
//         the lib splits validé (Dispo) from the rest (À valider)
//   écru  ETM's, in stock (same population as Tombé Métier › Stock), not
//         affected to a dyer line, not reserved to a client line, not consumed
//   fil   ETM's lots (filEtmSql) on hand, minus what open orders reserve —
//         the dashboard « État des stocks de fil » « Réservé », one rule
//         (calculerEtatFil). Yarn on order is left out on purpose.

export const stockPotentielRouter: Router = Router()

// calculerEtatFil runs ~10 queries per yarn; a few at a time keeps the shared
// database responsive while the whole catalogue is walked.
const CONCURRENCE_FIL = 4

async function filLibreParPaire(paires: Array<{ rf: number; cf: number }>): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  let i = 0
  async function worker() {
    while (i < paires.length) {
      const p = paires[i++]
      const etat = await calculerEtatFil(p.rf, p.cf)
      out.set(`${p.rf}:${p.cf}`, Math.max(0, etat.en_stock - etat.besoin))
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCE_FIL, paires.length) }, worker))
  return out
}

stockPotentielRouter.get('/potentiel', async (_req: Request, res: Response) => {
  try {
    const sql = mpsPg()
    const [refsFini, refsEcru, colorisEcru, colorisFini, finis, ecruRows, compositions, lotsFil] = await Promise.all([
      sql<Array<{ idref_fini: number; reference: string | null; designation: string | null; idref_ecru: number | null; rendement: number | null; avec_teinture: number | null; poids_moy: number | null }>>`
        SELECT idref_fini, reference, designation, idref_ecru, rendement::float8 AS rendement, avec_teinture, poids_moy::float8 AS poids_moy
        FROM ref_fini WHERE COALESCE(archive, 0) = 0`,
      // Contexture lives on the écru (Finis › Stock reads it the same way).
      sql<Array<{ idref_ecru: number; reference: string | null; contexture: string | null; bio: number | null; recycle: number | null }>>`
        SELECT e.idref_ecru, e.reference, c.nom AS contexture, e.bio, e.recycle
        FROM ref_ecru e LEFT JOIN contexture c ON c.idcontexture = e.idcontexture`,
      sql<Array<{ idcolori_ecru: number; idref_ecru: number; reference: string | null }>>`
        SELECT idcolori_ecru, idref_ecru, reference FROM colori_ecru`,
      sql<Array<{ idref_fini_colori: number; reference: string | null }>>`SELECT idref_fini_colori, reference FROM ref_fini_colori`,
      sql<Array<{ idref_fini: number; idcoloris: number | null; poids: number | null; metrage: number | null; idetat_stock_fini: number | null; second_choix: number | null }>>`
        SELECT idref_fini, idcoloris, poids::float8 AS poids, metrage::float8 AS metrage, idetat_stock_fini, second_choix
        FROM stock_fini
        WHERE COALESCE(idligne_expedition, 0) = 0 AND COALESCE(idetat_stock_fini, 0) <> 4
          AND COALESCE(idligne_commande_client, 0) = 0
          AND COALESCE(idcommande_donation, 0) = 0
          AND COALESCE(don, 0) = 0`,
      sql<Array<{ idstock_ecru: number; idref_ecru: number; idcolori_ecru: number | null; poids: number | null; second_choix: number | null }>>`
        SELECT idstock_ecru, idref_ecru, idcolori_ecru, poids::float8 AS poids, second_choix
        FROM stock_ecru
        WHERE idsociete = 1
          AND COALESCE(idligne_expedition_etm, 0) = 0
          AND COALESCE(idcommande_donation, 0) = 0
          AND COALESCE(idref_commande_affectation, 0) = 0
          AND COALESCE(idligne_commande_client, 0) = 0`,
      sql<Array<{ idref_ecru: number; idcolori_ecru: number | null; idref_fil: number | null; idcolori_fil: number | null; pourcentage: number | null }>>`
        SELECT idref_ecru, idcolori_ecru, idref_fil, idcolori_fil, pourcentage::float8 AS pourcentage
        FROM composition_ecru WHERE idref_fil > 0`,
      // The pairs worth costing: ETM's lots with stock (filEtmSql, native).
      sql<Array<{ idref_fil: number; idcolori_fil: number }>>`
        SELECT DISTINCT idref_fil, idcolori_fil FROM stock_fil
        WHERE stock > 0 AND (idclient IN (0, 1) OR gere_par_etm = 1)`,
    ])

    // Écru consumed into a fini (own child or merged-roll component) is gone.
    const consumed = await consumedEcruIds(ecruRows.map((e) => Number(e.idstock_ecru)))
    const ecruLibre = ecruRows
      .filter((e) => !consumed.has(Number(e.idstock_ecru)))
      .map((e) => ({
        idref_ecru: Number(e.idref_ecru),
        idcolori_ecru: Number(e.idcolori_ecru) || 0,
        poids: Number(e.poids) || 0,
        second_choix: Number(e.second_choix) === 1,
      }))

    const compo: CompositionRow[] = compositions.map((c) => ({
      idref_ecru: Number(c.idref_ecru),
      idcolori_ecru: Number(c.idcolori_ecru) || 0,
      idref_fil: Number(c.idref_fil) || 0,
      idcolori_fil: Number(c.idcolori_fil) || 0,
      pourcentage: Number(c.pourcentage) || 0,
    }))
    // Only the yarns some recipe uses AND that ETM holds get the full count.
    const utilises = new Set(compo.map((c) => `${c.idref_fil}:${c.idcolori_fil}`))
    const paires = lotsFil
      .map((l) => ({ rf: Number(l.idref_fil), cf: Number(l.idcolori_fil) }))
      .filter((p) => utilises.has(`${p.rf}:${p.cf}`))
    const filLibre = await filLibreParPaire(paires)

    const filLabel = new Map<string, string>()
    if (paires.length > 0) {
      const rfIds = [...new Set(paires.map((p) => p.rf))]
      const cfIds = [...new Set(paires.map((p) => p.cf))]
      const [rfs, cfs] = await Promise.all([
        sql<Array<{ idref_fil: number; reference: string | null }>>`SELECT idref_fil, reference FROM ref_fil WHERE idref_fil = ANY(${rfIds})`,
        sql<Array<{ idcolori_fil: number; reference: string | null }>>`SELECT idcolori_fil, reference FROM colori_fil WHERE idcolori_fil = ANY(${cfIds})`,
      ])
      const rfName = new Map(rfs.map((r) => [Number(r.idref_fil), (r.reference ?? '').trim()]))
      const cfName = new Map(cfs.map((c) => [Number(c.idcolori_fil), (c.reference ?? '').trim()]))
      for (const p of paires) {
        filLabel.set(`${p.rf}:${p.cf}`, [rfName.get(p.rf), cfName.get(p.cf)].filter(Boolean).join(' ') || `fil #${p.rf}`)
      }
    }

    const contextureParEcru = new Map(refsEcru.map((r) => [Number(r.idref_ecru), r.contexture?.trim() || null]))
    const ecruParId = new Map(refsEcru.map((r) => [Number(r.idref_ecru), r]))
    const lignes = calculerStockPotentiel({
      refsFini: refsFini
        .map((r) => ({
          idref_fini: Number(r.idref_fini),
          reference: (r.reference ?? '').trim(),
          designation: r.designation?.trim() || null,
          idref_ecru: Number(r.idref_ecru) || 0,
          rendement: Number(r.rendement) || 0,
          avec_teinture: Number(r.avec_teinture) || 0,
          grammage: Number(r.poids_moy) > 0 ? Number(r.poids_moy) : null,
          contexture: contextureParEcru.get(Number(r.idref_ecru) || 0) ?? null,
          bio: Number(ecruParId.get(Number(r.idref_ecru) || 0)?.bio) === 1,
          recycle: Number(ecruParId.get(Number(r.idref_ecru) || 0)?.recycle) === 1,
        }))
        .filter((r) => r.reference.length > 0),
      refsEcru: new Map(refsEcru.map((r) => [Number(r.idref_ecru), (r.reference ?? '').trim()])),
      colorisEcru: colorisEcru.map((c) => ({
        idcolori_ecru: Number(c.idcolori_ecru),
        idref_ecru: Number(c.idref_ecru),
        reference: (c.reference ?? '').trim(),
      })),
      colorisFini: new Map(colorisFini.map((c) => [Number(c.idref_fini_colori), (c.reference ?? '').trim()])),
      finisLibres: finis.map((f) => ({
        idref_fini: Number(f.idref_fini),
        idcoloris: Number(f.idcoloris) || 0,
        poids: Number(f.poids) || 0,
        metrage: Number(f.metrage) || 0,
        etat: Number(f.idetat_stock_fini) || 0,
        second_choix: Number(f.second_choix) === 1,
      })),
      ecruLibre,
      compositions: compo,
      filLibre,
      filLabel,
    })
    res.json(lignes)
  } catch (err) {
    console.error('Error computing stock potentiel:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
