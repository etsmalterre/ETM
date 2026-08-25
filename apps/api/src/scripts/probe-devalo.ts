/**
 * Implements the legacy stock-fini devaluation query (supplied 2026-08-25) and
 * validates it against the printed inventory at 31/12/2025:
 *   21 039 kg / valeur d'achat 283 526 EUR / valeur actuelle 125 555 EUR
 *
 * HFSQL discipline: flat queries + joins in JS (no wide JOIN, no correlated
 * sub-query over the Linux bridge).
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })
const { query, closeConnection } = await import('../lib/hfsql-auto.js')

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const d8 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(0, 8)
const e = (v: number) => Math.round(v).toLocaleString('fr-FR')
const D = '20251231'
const T = { kg: 21039, achat: 283526, actuelle: 125555 }
const Q = 200 // the quantity bracket the legacy query freezes

async function main() {
  const [fini, ecru, afo, afst, sfil, rfc, comp, lcs, recru, rfini, trf, tte, rfcol, exps, lgs] =
    await Promise.all([
      query<any>(`SELECT IDstock_fini, IDstock_ecru, IDref_fini, IDColoris, second_choix, date_saisie, IDligne_expedition, IDetat_stock_fini, IDref_commande_source, destockage, don FROM stock_fini`),
      query<any>(`SELECT IDstock_ecru, poids, IDordre_fabrication, IDref_ecru, IDcolori_ecru, IDref_commande_source FROM stock_ecru`),
      query<any>(`SELECT IDordre_fabrication, IDstock_fil, pourcentage FROM asso_fil_of`),
      query<any>(`SELECT IDstock_ecru, IDstock_fil FROM asso_fil_stock_tm`),
      query<any>(`SELECT IDstock_fil, IDcolori_fil, IDref_fil_commande, IDclient FROM stock_fil`),
      query<any>(`SELECT IDref_fil_commande, prix_unitaire FROM ref_fil_commande`),
      query<any>(`SELECT IDref_ecru, IDcolori_ecru, IDcolori_fil, pourcentage FROM composition_ecru`),
      query<any>(`SELECT IDligne_commande_sous_traitant, prix FROM ligne_commande_sous_traitant`),
      query<any>(`SELECT IDref_ecru, prix FROM ref_ecru`),
      query<any>(`SELECT IDref_fini, IDref_ecru FROM ref_fini`),
      query<any>(`SELECT IDref_fini, IDtraitement FROM traitement_ref_fini`),
      query<any>(`SELECT IDtraitement, IDteinture, IDsous_traitant, quantite_mini, quantite_maxi, prix FROM tranche_tarif_ennoblissement`),
      query<any>(`SELECT IDref_fini_colori, IDteinture FROM ref_fini_colori`),
      query<any>(`SELECT IDexpedition, DATE AS dexp FROM expedition`),
      query<any>(`SELECT IDligne_expedition, IDexpedition FROM ligne_expedition`),
    ])

  const ed = new Map<number, string>()
  for (const x of exps) ed.set(n(x.IDexpedition), d8(x.dexp))
  const led = new Map<number, string>()
  for (const l of lgs) { const d = ed.get(n(l.IDexpedition)); if (d) led.set(n(l.IDligne_expedition), d) }

  const E = new Map<number, any>(); for (const r of ecru) E.set(n(r.IDstock_ecru), r)
  const prixLcs = new Map<number, number>(); for (const r of lcs) prixLcs.set(n(r.IDligne_commande_sous_traitant), n(r.prix))
  const prixEcru = new Map<number, number>(); for (const r of recru) prixEcru.set(n(r.IDref_ecru), n(r.prix))
  const refEcruOfFini = new Map<number, number>(); for (const r of rfini) refEcruOfFini.set(n(r.IDref_fini), n(r.IDref_ecru))
  const SF = new Map<number, any>(); for (const r of sfil) SF.set(n(r.IDstock_fil), r)
  const puCmd = new Map<number, number>(); for (const r of rfc) puCmd.set(n(r.IDref_fil_commande), n(r.prix_unitaire))
  const teintOfColoris = new Map<number, number>(); for (const r of rfcol) teintOfColoris.set(n(r.IDref_fini_colori), n(r.IDteinture))

  const afoByOf = new Map<number, any[]>()
  for (const r of afo) { const k = n(r.IDordre_fabrication); if (!afoByOf.has(k)) afoByOf.set(k, []); afoByOf.get(k)!.push(r) }
  const compKey = (a: number, b: number, c: number) => `${a}|${b}|${c}`
  const compMap = new Map<string, number>()
  for (const r of comp) compMap.set(compKey(n(r.IDref_ecru), n(r.IDcolori_ecru), n(r.IDcolori_fil)), n(r.pourcentage))
  const afstByEcru = new Map<number, number[]>()
  for (const r of afst) { const k = n(r.IDstock_ecru); if (!afstByEcru.has(k)) afstByEcru.set(k, []); afstByEcru.get(k)!.push(n(r.IDstock_fil)) }

  /** Yarn cost per kg: from the OF when there is one, else from the reference
   *  composition applied to the lots physically allocated to the piece. Price is
   *  the PURCHASE-ORDER price (ref_fil_commande.prix_unitaire), never the catalogue. */
  function coutFil(se: any): { prix: number; filNull: number } {
    let p = 0
    let fn = 0
    if (n(se.IDordre_fabrication) !== 0) {
      for (const r of afoByOf.get(n(se.IDordre_fabrication)) ?? []) {
        const sf = SF.get(n(r.IDstock_fil))
        if (!sf) continue
        p += (n(r.pourcentage) / 100) * (puCmd.get(n(sf.IDref_fil_commande)) ?? 0)
        if (n(sf.IDclient) === 1 && !puCmd.has(n(sf.IDref_fil_commande))) fn -= 1
      }
      return { prix: p, filNull: fn }
    }
    for (const idsf of afstByEcru.get(n(se.IDstock_ecru)) ?? []) {
      const sf = SF.get(idsf)
      if (!sf) continue
      const pct = compMap.get(compKey(n(se.IDref_ecru), n(se.IDcolori_ecru), n(sf.IDcolori_fil))) ?? 0
      p += (pct * (puCmd.get(n(sf.IDref_fil_commande)) ?? 0)) / 100
      if (n(sf.IDclient) === 1 && !puCmd.has(n(sf.IDref_fil_commande))) fn -= 1
    }
    return { prix: p, filNull: fn }
  }

  const tteOk = tte.filter((t: any) => n(t.IDsous_traitant) === 0 && n(t.quantite_mini) <= Q && n(t.quantite_maxi) >= Q)
  const prixTraitement = new Map<number, number>()
  const prixTeinture = new Map<number, number>()
  for (const t of tteOk) {
    const kt = n(t.IDtraitement); if (kt) prixTraitement.set(kt, (prixTraitement.get(kt) ?? 0) + n(t.prix))
    const kd = n(t.IDteinture); if (kd) prixTeinture.set(kd, (prixTeinture.get(kd) ?? 0) + n(t.prix))
  }
  const traitByRefFini = new Map<number, number[]>()
  for (const r of trf) { const k = n(r.IDref_fini); if (!traitByRefFini.has(k)) traitByRefFini.set(k, []); traitByRefFini.get(k)!.push(n(r.IDtraitement)) }

  /** The legacy query depreciates relative to SYSDATE, so the run date IS a
   *  parameter of the result. `asOf` = the day the report is produced. */
  function makeDepreciation(asOf: string) {
    const y = Number(asOf.slice(0, 4))
    const un = `${y - 1}${asOf.slice(4)}`
    const deux = `${y - 2}${asOf.slice(4)}`
    return (r: any): number => {
      if (n(r.second_choix) === 1) return 0.9
      const m = d8(r.date_saisie)
      if (m > un) return 0
      if (m > deux) return 0.5
      return 0.9
    }
  }
  let depreciation = makeDepreciation(D)

  function evaluate(label: string, pop: any[]) {
    let kg = 0, achat = 0, actuelle = 0, nFilNull = 0
    for (const r of pop) {
      const se = E.get(n(r.IDstock_ecru))
      if (!se) continue
      const poids = n(se.poids)
      kg += poids
      const { prix: cf, filNull } = coutFil(se)
      if (filNull < 0) nFilNull++
      const ct = prixLcs.has(n(se.IDref_commande_source))
        ? prixLcs.get(n(se.IDref_commande_source))!
        : prixEcru.get(refEcruOfFini.get(n(r.IDref_fini)) ?? 0) ?? 0
      let ce = prixLcs.get(n(r.IDref_commande_source)) ?? 0
      if (!ce) {
        let c = 0
        for (const t of traitByRefFini.get(n(r.IDref_fini)) ?? []) c += prixTraitement.get(t) ?? 0
        ce = c + (prixTeinture.get(teintOfColoris.get(n(r.IDColoris)) ?? 0) ?? 0)
      }
      const va = poids * (cf + ct + ce)
      achat += va
      actuelle += va * (1 - depreciation(r))
    }
    console.log(`\n${label}`)
    console.log(`  ${String(pop.length).padStart(5)} rlx   ${e(kg).padStart(8)} kg (PDF ${e(T.kg)})   ${nFilNull} pieces filNull`)
    console.log(`  valeur d'achat  ${e(achat).padStart(9)} (PDF ${e(T.achat)})  ${((achat / T.achat - 1) * 100).toFixed(1).padStart(6)} %   ${(achat / kg).toFixed(2)} EUR/kg`)
    console.log(`  valeur actuelle ${e(actuelle).padStart(9)} (PDF ${e(T.actuelle)})  ${((actuelle / T.actuelle - 1) * 100).toFixed(1).padStart(6)} %   deprec. ${((1 - actuelle / achat) * 100).toFixed(1)} %`)
  }

  const heldAt = fini.filter((r: any) => {
    const m = d8(r.date_saisie)
    if (!m || m > D) return false
    const sh = led.get(n(r.IDligne_expedition))
    return !(sh && sh <= D)
  })

  evaluate('[A] requete telle quelle, etat courant (IDligne_expedition=0 ET IDetat_stock_fini=3)',
    fini.filter((r: any) => n(r.IDligne_expedition) === 0 && n(r.IDetat_stock_fini) === 3))
  evaluate('[B] population reconstituee au 31/12/2025 (non expedie a cette date)', heldAt)
  evaluate('[C] B + destockage=0 et don=0', heldAt.filter((r: any) => !n(r.destockage) && !n(r.don)))
  evaluate('[D] B + etat 3 ou 4', heldAt.filter((r: any) => [3, 4].includes(n(r.IDetat_stock_fini))))

  // The number that actually matters: the query run TODAY, depreciating from today.
  const TODAY = process.env.AS_OF ?? '20260825'
  depreciation = makeDepreciation(TODAY)
  console.log(`\n${'='.repeat(72)}\nVALORISATION COURANTE (requete legitime, deprecation au ${TODAY})`)
  evaluate('[E] stock fini detenu aujourd hui', fini.filter((r: any) => n(r.IDligne_expedition) === 0 && n(r.IDetat_stock_fini) === 3))
}

main().catch((err) => { console.error(String(err).slice(0, 700)); process.exitCode = 1 }).finally(() => closeConnection())
