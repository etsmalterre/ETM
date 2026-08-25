/**
 * Garde de la valorisation du stock (`lib/valorisation-stock.ts`), quatre types.
 *
 *   NODE_ENV=production node --import tsx src/scripts/check-valorisation-stock.ts
 *   pnpm --filter @mps/api exec tsx src/scripts/check-valorisation-stock.ts
 *
 * CE QUI EST VÉRIFIÉ
 *
 *  1. Cohérence interne : chaque type est bien la somme de ses tranches, le
 *     total la somme des types, provision = brut − net, taux = provision / brut.
 *  2. Le barème est réellement appliqué : net = brut × (1 − taux) par tranche,
 *     avec les taux imprimés sur les inventaires légataires — et les DEUX
 *     barèmes, celui des pièces et celui du fil, qui diffèrent.
 *  3. Les tranches ne sont pas dégénérées. C'est la régression qui compte :
 *     `date_saisie` / `date_entree` reviennent en TIMESTAMP, donc un parseur
 *     strict (`sst-shared.dateDigits`, `/^\d{8}$/`) renvoie '' sur toutes les
 *     lignes, toute comparaison perd, et l'intégralité du stock atterrit dans
 *     la tranche la plus vieille à 90 % — un chiffre plausible, pas un plantage.
 *  4. Les populations correspondent aux prédicats légataires, recomptés
 *     indépendamment en SQL.
 *  5. Le fil confié n'est PAS valorisé : seul `IDclient = 1` (Ets Malterre) est
 *     à notre bilan. Compter le fil d'Hermès ou de La Gentle Factory gonflerait
 *     l'actif d'un stock qui ne nous appartient pas.
 *
 * CE QUI N'EST PAS ÉPINGLÉ : les euros absolus. La valorisation décrit le stock
 * détenu MAINTENANT (colonnes d'état courant + dépréciation depuis la date du
 * jour), donc chaque chiffre bouge légitimement d'un jour à l'autre. Les
 * inventaires imprimés au 27/12/2024 et 31/12/2025 ne sont pas rejouables ; ils
 * ont servi à établir les règles, pas à figer un total.
 *
 * Repères de méthode (les quatre inventaires du 27/12/2024 reproduisent
 * EXACTEMENT `inventaire_compta` au 28/12/2024) :
 *     Fil 199 090/122 891 · TM dispo 56 372/27 937
 *     TM en cours 44 236/43 469 · Fini 331 978/179 142
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

const { query, closeConnection } = await import('../lib/hfsql-auto.js')
const { valoriserStock } = await import('../lib/valorisation-stock.js')

const eur = (v: number) => Math.round(v).toLocaleString('fr-FR')
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)} %`)
/** Tolérance d'arrondi en euros — les montants transitent en REAL. */
const EPS = 0.5

let failures = 0
function check(ok: boolean, label: string, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return }
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  failures++
}

/** Taux attendus, par clé de tranche. Les deux barèmes cohabitent : une clé
 *  partagée (`moins_1_an`) doit valoir la même chose des deux côtés. */
const TAUX_ATTENDU: Record<string, number> = {
  second_choix: 0.9, moins_1_an: 0, de_1_a_2_ans: 0.5, plus_2_ans: 0.9,
  elasthanne: 0, petit_lot: 0.9, de_2_a_3_ans: 0.75, plus_3_ans: 0.9,
}

async function main() {
  const v = await valoriserStock()
  console.log(`Valorisation du stock au ${v.date}\n`)
  for (const t of v.types) {
    console.log(`${t.label}`)
    console.log(`  ${String(t.lignes).padStart(5)} lignes · ${eur(t.poids).padStart(8)} kg` +
      `   brut ${eur(t.brut).padStart(9)} €  net ${eur(t.net).padStart(9)} €  provision ${pct(t.taux_provision)}`)
    for (const b of t.buckets) {
      if (b.lignes === 0) continue
      console.log(`      ${b.label.padEnd(28)} ${String(b.lignes).padStart(5)}  ${eur(b.poids).padStart(7)} kg` +
        `  brut ${eur(b.brut).padStart(9)}  net ${eur(b.net).padStart(9)}  (−${(b.taux * 100).toFixed(0)} %)`)
    }
    if (t.incompletes > 0) console.log(`      · ${t.incompletes} ligne(s) au coût incomplet`)
  }
  console.log(`\nTOTAL   ${eur(v.total.poids)} kg   brut ${eur(v.total.brut)} €   net ${eur(v.total.net)} €` +
    `   provision ${eur(v.total.provision)} € (${pct(v.total.taux_provision)})`)
  console.log('\n⚠ Hors escrime — absent de l\'ERP (57 600 € brut / 13 935 € net fin 2025).\n')

  // 1. Cohérence interne
  for (const t of v.types) {
    const s = (k: 'lignes' | 'poids' | 'brut' | 'net') => t.buckets.reduce((a, b) => a + b[k], 0)
    check(s('lignes') === t.lignes, `${t.label} : lignes = somme des tranches`, `${s('lignes')} vs ${t.lignes}`)
    check(Math.abs(s('brut') - t.brut) < EPS, `${t.label} : brut = somme des tranches`)
    check(Math.abs(s('net') - t.net) < EPS, `${t.label} : net = somme des tranches`)
    check(Math.abs(t.provision - (t.brut - t.net)) < EPS, `${t.label} : provision = brut − net`)
  }
  const tb = v.types.reduce((a, x) => a + x.brut, 0)
  const tn = v.types.reduce((a, x) => a + x.net, 0)
  check(Math.abs(tb - v.total.brut) < EPS, 'total brut = somme des types')
  check(Math.abs(tn - v.total.net) < EPS, 'total net = somme des types')

  // 2. Le barème est appliqué, et les deux barèmes sont bien distincts
  for (const t of v.types) {
    for (const b of t.buckets) {
      check(TAUX_ATTENDU[b.key] === b.taux, `${t.label} / ${b.label} : taux ${b.taux}`, `attendu ${TAUX_ATTENDU[b.key]}`)
      check(Math.abs(b.net - b.brut * (1 - b.taux)) < EPS, `${t.label} / ${b.label} : net = brut × (1 − taux)`)
    }
  }
  const fil = v.types.find((t) => t.type === 'fil')!
  check(fil.buckets.some((b) => b.key === 'de_2_a_3_ans') && fil.buckets.some((b) => b.key === 'elasthanne'),
    'le fil a bien son propre barème (tranche 2-3 ans + exemption élasthanne)')
  check(!v.types.find((t) => t.type === 'fini')!.buckets.some((b) => b.key === 'de_2_a_3_ans'),
    'le barème pièces n\'a PAS la tranche 2-3 ans du fil')

  // 3. Tranches non dégénérées
  for (const t of v.types) {
    if (t.lignes === 0) continue
    const peuplees = t.buckets.filter((b) => b.lignes > 0)
    check(peuplees.length > 1, `${t.label} : répartition par ancienneté réelle (> 1 tranche)`,
      peuplees.length === 1 ? `tout dans « ${peuplees[0].label} » — date mal parsée ?` : 'aucune tranche peuplée')
  }

  // 4. Populations recomptées en SQL
  const fini = await query<Record<string, unknown>>(
    `SELECT IDstock_fini, IDstock_ecru FROM stock_fini WHERE IDligne_expedition = 0 AND IDetat_stock_fini = 3`)
  const ecruRows = await query<Record<string, unknown>>(
    `SELECT IDstock_ecru, IDref_commande_affectation, IDligne_expedition_ETM FROM stock_ecru WHERE IDsociete = 1`)
  const known = new Set(ecruRows.map((r) => Number(r.IDstock_ecru) || 0))
  check(fini.filter((r) => known.has(Number(r.IDstock_ecru) || 0)).length === v.types.find((t) => t.type === 'fini')!.lignes,
    'population fini = expédition 0 + état 3 (parent écru connu)')

  const allFini = await query<Record<string, unknown>>(`SELECT IDstock_ecru FROM stock_fini`)
  const consomme = new Set(allFini.map((r) => Number(r.IDstock_ecru) || 0).filter((x) => x > 0))
  const enStock = ecruRows.filter((r) => (Number(r.IDligne_expedition_ETM) || 0) === 0 && !consomme.has(Number(r.IDstock_ecru) || 0))
  const nDispo = enStock.filter((r) => (Number(r.IDref_commande_affectation) || 0) === 0).length
  const nEnCours = enStock.length - nDispo
  check(nDispo === v.types.find((t) => t.type === 'tm_dispo')!.lignes, 'population TM dispo = écru en stock non affecté')
  check(nEnCours === v.types.find((t) => t.type === 'tm_en_cours')!.lignes, 'population TM en cours = écru en stock affecté')

  // 5. Le fil confié n'entre pas au bilan
  const lots = await query<Record<string, unknown>>(`SELECT IDstock_fil, stock, IDclient FROM stock_fil`)
  const aNous = lots.filter((r) => (Number(r.stock) || 0) > 0 && (Number(r.IDclient) || 0) === 1).length
  const confie = lots.filter((r) => (Number(r.stock) || 0) > 0 && (Number(r.IDclient) || 0) !== 1)
  check(aNous === fil.lignes, 'population fil = lots Ets Malterre (IDclient 1) avec stock > 0',
    `SQL ${aNous} vs valorisation ${fil.lignes}`)
  if (confie.length > 0) {
    const kgConfie = confie.reduce((t, r) => t + (Number(r.stock) || 0), 0)
    console.log(`  · ${confie.length} lots de fil confié exclus (${eur(kgConfie)} kg) — dans nos murs, pas à notre bilan`)
  }

  console.log(failures === 0 ? '\n✓ OK' : `\n✗ ${failures} échec(s)`)
  if (failures) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
