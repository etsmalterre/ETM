/**
 * Read-only probe for Production › Visitage (routes/visitage-trm.ts).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/probe-visitage-trm.ts
 *
 * Re-run it against prod after an /etm_deploy. It writes nothing; it measures
 * the six rules the screen rests on against the whole live history and prints
 * the parity so a drift is visible before the visiteuse finds it:
 *
 *   1. NUMBERING — two sequences per OF (1er choix < 1000, 2nd choix 1000+).
 *   2. STOCK FIL — the decrement counts every roll, déclassés included. This is
 *      the riskiest write of the whole feature: get it wrong and the yarn
 *      ledger silently drifts.
 *   3. DEFECT TRANSFER — Type_Reference 1 → 2 in place, preserving DATE /
 *      Type_Spotteur / IDSpotteur / description. That preservation is what
 *      still distinguishes a terminal defect from a visitage one years later.
 *   4. CADENCE — the "Pièce à visiter" banner and which of the two events gets
 *      written. ⚠️ This is the feature's one flagged APPROXIMATION: the real
 *      predicate is in PCS-compressed WLanguage. This probe is how we know how
 *      good the approximation is. Read the number before shipping.
 *   5. ORPHANS — finished pieces that never got a roll. The legacy loses them
 *      structurally (it only ever offers the queue-head OF's pieces).
 *   6. RESERVATION — a 1er choix roll leaves visitage reserved for the OF's
 *      commande line (IDLigne_Commande_TRM); a DÉCLASSÉ leaves it at 0 and is
 *      affected by hand when it ships. The poste stamped déclassés for its
 *      first week (LIVA #1129) and they showed up on the commande's
 *      Affectation at full weight. This section counts every déclassé the
 *      poste has reserved since it went live — the number must stay at what
 *      it was before the fix shipped (3 on 2026-09-07), never grow.
 *
 * HFSQL discipline: `DATE` is reserved (aliased on read); `récuperé` / `traité`
 * are accented and only ever reached through SELECT * + key folding.
 */
import { query, closeConnection, fixEncoding } from '../lib/hfsql-auto.js'
import { selectDefauts, parseDtMs } from '../lib/production-trm.js'

const ROLLS_BETWEEN_VISITAGES = 2 // must mirror routes/visitage-trm.ts
/** First day the poste wrote to prod (yyyymmdd). Before it, every roll is legacy. */
const POSTE_LIVE = '20260826'

function pct(a: number, b: number): string {
  return b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(1)} %`
}
function head(t: string) { console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`) }

async function main() {
  // ── 1. Numbering ──────────────────────────────────────
  head('1. NUMÉROTATION — deux séquences par OF')
  const numRows = await query<any>(
    `SELECT IDordre_fabrication, num_piece_OF, second_choix FROM stock_ecru
     WHERE IDordre_fabrication > 0`,
  )
  let scMatch = 0, scMismatch = 0
  const firstSecond = new Map<number, number>()
  for (const r of numRows) {
    const num = Number(r.num_piece_OF) || 0
    const sc = Number(r.second_choix) || 0
    if ((num >= 1000) === (sc === 1)) scMatch++; else scMismatch++
    if (num >= 1000 && num < 2000) {
      const of = Number(r.IDordre_fabrication)
      firstSecond.set(of, Math.min(firstSecond.get(of) ?? Infinity, num))
    }
  }
  console.log(`  rouleaux                       : ${numRows.length}`)
  console.log(`  second_choix ⇔ num >= 1000     : ${scMatch} (${pct(scMatch, scMatch + scMismatch)}), ${scMismatch} exceptions historiques`)
  const starts: Record<number, number> = {}
  for (const v of firstSecond.values()) starts[v] = (starts[v] ?? 0) + 1
  console.log(`  1er déclassé d'un OF porte     : ${JSON.stringify(starts)}`)
  console.log(`  → la route écrit 1001 (majorité) ; les OF partis à 1000 sont un code plus ancien.`)

  // ── 2. Stock fil ──────────────────────────────────────
  head('2. STOCK FIL — le décrément compte-t-il les déclassés ?')
  const asso = await query<any>(
    'SELECT IDstock_fil, IDordre_fabrication, pourcentage FROM asso_fil_of WHERE IDstock_fil > 0',
  )
  const byLot = new Map<number, { of: number; pct: number }[]>()
  for (const a of asso) {
    const k = Number(a.IDstock_fil)
    const arr = byLot.get(k) ?? []
    arr.push({ of: Number(a.IDordre_fabrication), pct: Number(a.pourcentage) || 100 })
    byLot.set(k, arr)
  }
  // stock_fil carries memo-binary certif columns → never SELECT *.
  const lots = await query<any>(
    `SELECT IDstock_fil, lot, stock, stock_initial FROM stock_fil
     WHERE "terminé" = 0 AND stock_initial > 0`,
  )
  let checked = 0, okAll = 0, okFirstOnly = 0
  for (const l of lots) {
    const arr = byLot.get(Number(l.IDstock_fil))
    if (!arr?.length) continue
    const ofIds = Array.from(new Set(arr.map((a) => a.of)))
    const rolls = await query<any>(
      `SELECT IDordre_fabrication, poids, second_choix FROM stock_ecru
       WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
    )
    if (!rolls.length) continue
    const pctOf = new Map(arr.map((a) => [a.of, a.pct]))
    let all = 0, firstOnly = 0
    for (const r of rolls) {
      const share = (pctOf.get(Number(r.IDordre_fabrication)) ?? 100) / 100
      const kg = (Number(r.poids) || 0) * share
      all += kg
      if (!Number(r.second_choix)) firstOnly += kg
    }
    const consumed = (Number(l.stock_initial) || 0) - (Number(l.stock) || 0)
    checked++
    if (Math.abs(consumed - all) < 0.5) okAll++
    else if (Math.abs(consumed - firstOnly) < 0.5) okFirstOnly++
  }
  console.log(`  lots ouverts testés            : ${checked}`)
  console.log(`  collent en comptant TOUS       : ${okAll} (${pct(okAll, checked)})`)
  console.log(`  collent en comptant 1er choix  : ${okFirstOnly} (${pct(okFirstOnly, checked)})`)
  console.log(`  → règle retenue : Δ = Σ(poids de TOUS les rouleaux) × pourcentage/100.`)
  console.log('    Les lots qui ne collent ni l\'un ni l\'autre sont attendus : fil_incorpore,')
  console.log('    divisions de lot, et stock_initial corrigé à l\'archivage.')

  // ── 3. Defect transfer ────────────────────────────────
  head('3. DÉFAUTS — la conversion pièce → rouleau préserve-t-elle la signature ?')
  const allDef = await query<Record<string, unknown>>('SELECT * FROM defaut_qualite')
  const fixedDef = await fixEncoding(allDef, 'defaut_qualite', 'IDdefaut_qualite', ['description', 'type_defaut'])
  const bucket: Record<string, number> = {}
  for (const d of fixedDef as any[]) {
    const tr = Number(d.Type_Reference) || 0
    const ts = Number(d.Type_Spotteur) || 0
    const hasDesc = d.description != null && String(d.description).trim() !== ''
    bucket[`T${tr}_spotteur${ts}_desc${hasDesc ? 'Set' : 'Null'}`] = (bucket[`T${tr}_spotteur${ts}_desc${hasDesc ? 'Set' : 'Null'}`] ?? 0) + 1
  }
  console.log(`  population                     : ${JSON.stringify(bucket)}`)
  console.log('  → attendu : T1 uniquement spotteur 1 (terminal) ;')
  console.log('    T2 spotteur 1 = reporté du terminal (description = libellé de tranche),')
  console.log('    T2 spotteur 2 = saisi au visitage.')
  console.log('    ⚠️ L\'origine se lit sur Type_Spotteur, JAMAIS sur la présence d\'une')
  console.log('    description : le visitage a cessé d\'en écrire une en 2023 (1 553 lignes')
  console.log('    NULL d\'affilée depuis), mais 1 365 lignes de 2021-22 en portent une.')
  const recupOnSpotteur2 = (fixedDef as any[]).filter(
    (d) => Number(d.Type_Spotteur) === 2 && Number((Object.entries(d).find(([k]) => /^r.{0,2}cup/i.test(k)) ?? [, 0])[1]) === 1,
  ).length
  console.log(`  récupéré posé sur un défaut visitage : ${recupOnSpotteur2} (attendu ≈ 0 —`)
  console.log('    « récupéré » qualifie un défaut déclaré par le bonnetier, pas le sien)')

  // ── 4. Cadence ────────────────────────────────────────
  head('4. CADENCE « Pièce à visiter » — parité de l\'APPROXIMATION')
  const ofs = await query<any>(
    'SELECT IDordre_fabrication, ouvert_visiteuse FROM ordre_fabrication WHERE est_termine IN (0, 1)',
  )
  const ouvertById = new Map<number, number>(ofs.map((o: any) => [Number(o.IDordre_fabrication), Number(o.ouvert_visiteuse) || 0]))
  const rollsAll = await query<any>(
    'SELECT IDstock_ecru, IDordre_fabrication FROM stock_ecru WHERE IDordre_fabrication > 0 ORDER BY IDstock_ecru ASC',
  )
  const evRows = await query<any>('SELECT IDstock_ecru, evenement FROM evenement_piece WHERE IDstock_ecru > 0')
  const evFixed = await fixEncoding(evRows, 'evenement_piece', 'IDevenement_piece', ['evenement'])
  const visited = new Set<number>()
  const traced = new Set<number>()
  for (const e of evFixed as any[]) {
    const id = Number(e.IDstock_ecru) || 0
    const label = String(e.evenement ?? '').trim()
    if (/^(visitage|pesage)/i.test(label)) traced.add(id)
    if (/^visitage/i.test(label)) visited.add(id)
  }
  const rollsByOf = new Map<number, number[]>()
  for (const r of rollsAll) {
    const of = Number(r.IDordre_fabrication)
    const arr = rollsByOf.get(of) ?? []
    arr.push(Number(r.IDstock_ecru))
    rollsByOf.set(of, arr)
  }
  const score = { ouvert_ok: 0, ouvert_ko: 0, cadence_ok: 0, cadence_ko: 0 }
  for (const [of, ids] of rollsByOf) {
    const ouvert = ouvertById.get(of) ?? 0
    let since = Infinity // no visitage seen yet
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const predicted = ouvert === 1 || i < 2 || since >= ROLLS_BETWEEN_VISITAGES
      if (traced.has(id)) {
        const actual = visited.has(id)
        if (ouvert === 1) predicted === actual ? score.ouvert_ok++ : score.ouvert_ko++
        else predicted === actual ? score.cadence_ok++ : score.cadence_ko++
      }
      since = visited.has(id) ? 0 : (since === Infinity ? 1 : since + 1)
    }
  }
  const ouvertTot = score.ouvert_ok + score.ouvert_ko
  const cadTot = score.cadence_ok + score.cadence_ko
  console.log(`  OF « ouvrir au large » (exact)  : ${score.ouvert_ok}/${ouvertTot} → ${pct(score.ouvert_ok, ouvertTot)}`)
  console.log(`  OF en cadence (APPROXIMATION)   : ${score.cadence_ok}/${cadTot} → ${pct(score.cadence_ok, cadTot)}`)
  console.log('  → la moitié « ouvrir au large » doit être à 100 %. Si elle ne l\'est pas,')
  console.log('    la règle est fausse, pas approximative — corriger avant de livrer.')
  console.log('    La moitié cadence ne le sera jamais. Mesuré le 2026-08-26 : 71,8 %,')
  console.log('    contre 57,4 % pour « toujours visiter » — la règle porte donc un vrai')
  console.log('    signal sans être la bonne. Sept variantes ont été essayées (compter les')
  console.log('    pièces au lieu des rouleaux, num_piece_OF modulo 3, ignorer les')
  console.log('    déclassés, seuil à 3) : aucune ne dépasse celle-ci. La lecture la plus')
  console.log('    probable est que le bandeau legacy est INDICATIF et que la visiteuse')
  console.log('    tranche — d\'où le forçage dans l\'écran, qui est le garde-fou.')

  // ── 5. Orphans ────────────────────────────────────────
  head('5. PIÈCES ORPHELINES — la fuite que le legacy ne montre pas')
  const top = await query<{ m: number | null }>('SELECT MAX(IDpiece_production) AS m FROM piece_production')
  const floor = Math.max(0, (Number(top[0]?.m) || 0) - 3000)
  const pieces = await query<any>(
    `SELECT pp.IDpiece_production, pp.IDordre_fabrication, pp.date_fin, orf.IDmachine, orf.est_termine
     FROM piece_production pp
     INNER JOIN ordre_fabrication orf ON orf.IDordre_fabrication = pp.IDordre_fabrication
     WHERE pp.IDpiece_production >= ${floor}`,
  )
  const taken = new Set<number>()
  for (const r of await query<any>(`SELECT IDpiece_production FROM stock_ecru WHERE IDpiece_production >= ${floor}`)) {
    taken.add(Number(r.IDpiece_production) || 0)
  }
  const orphans = pieces.filter((p: any) => !taken.has(Number(p.IDpiece_production)) && parseDtMs(p.date_fin) !== null)
  const byMonth: Record<string, number> = {}
  let onClosed = 0
  for (const p of orphans) {
    const ms = parseDtMs(p.date_fin)!
    const d = new Date(ms)
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    byMonth[k] = (byMonth[k] ?? 0) + 1
    if (Number(p.est_termine) === 1) onClosed++
  }
  console.log(`  pièces scannées (profondeur 3000) : ${pieces.length}`)
  console.log(`  terminées SANS rouleau            : ${orphans.length}, dont ${onClosed} sur un OF terminé`)
  console.log(`  par mois                          : ${JSON.stringify(byMonth)}`)
  console.log('  → chacune est du tombé métier jamais entré en stock, dont le fil n\'a jamais')
  console.log('    été décrémenté. L’écran les rend atteignables (autres_pieces) pendant')
  console.log('    ORPHAN_MAX_AGE_DAYS = 7 jours, puis les laisse tomber : passé une')
  console.log('    semaine la matière est partie et la pièce est un passif comptable,')
  console.log('    pas un travail d’atelier. Ce compteur est le seul endroit où il')
  console.log('    reste visible — c’est sa raison d’être.')

  // ── 6. Reservation ────────────────────────────────────
  // No IDsociete filter on purpose: « Expédier » hands a roll shipped to Ets
  // Malterre over to société 1, and the first probe of LIVA #1129 missed
  // 3554/1001 exactly that way. The partition guard is the OF.
  head('6. RÉSERVATION — un déclassé sort du visitage sans ligne de commande')
  const resRows = await query<any>(
    `SELECT se.IDstock_ecru, se.numero, se.second_choix, se.IDLigne_Commande_TRM,
            se.IDligne_expedition_TRM, se.date_saisie, orf.IDligne_commande_client AS of_ligne
     FROM stock_ecru se
     INNER JOIN ordre_fabrication orf ON orf.IDordre_fabrication = se.IDordre_fabrication
     WHERE se.IDordre_fabrication > 0 AND orf.IDligne_commande_client > 0`,
  )
  const d8 = (v: unknown) => String(v ?? '').replace(/[^0-9]/g, '').slice(0, 8)
  const legacy = resRows.filter((r: any) => d8(r.date_saisie) < POSTE_LIVE)
  const legacy2 = legacy.filter((r: any) => Number(r.second_choix) === 1)
  const legacy2Aff = legacy2.filter((r: any) => (Number(r.IDLigne_Commande_TRM) || 0) > 0)
  const legacy2AffShipped = legacy2Aff.filter((r: any) => (Number(r.IDligne_expedition_TRM) || 0) > 0)
  const legacy1 = legacy.filter((r: any) => Number(r.second_choix) === 0)
  const legacy1Aff = legacy1.filter((r: any) => (Number(r.IDLigne_Commande_TRM) || 0) > 0)
  console.log(`  legacy (avant le ${POSTE_LIVE}), OF avec ligne de commande :`)
  console.log(`    1er choix affectés à une ligne : ${legacy1Aff.length}/${legacy1.length} (${pct(legacy1Aff.length, legacy1.length)})`)
  console.log(`    déclassés affectés à une ligne : ${legacy2Aff.length}/${legacy2.length} (${pct(legacy2Aff.length, legacy2.length)}),` +
    ` dont ${legacy2AffShipped.length} expédiés`)
  console.log('    → un déclassé n\'est affecté qu\'à l\'expédition, à la main ; la règle du')
  console.log('      poste est « second_choix = 1 ⇒ IDLigne_Commande_TRM = 0 ».')

  const poste = resRows.filter((r: any) => d8(r.date_saisie) >= POSTE_LIVE)
  const poste2 = poste.filter((r: any) => Number(r.second_choix) === 1)
  const poste2Aff = poste2.filter((r: any) => (Number(r.IDLigne_Commande_TRM) || 0) > 0)
  const poste2AffFree = poste2Aff.filter((r: any) => (Number(r.IDligne_expedition_TRM) || 0) === 0)
  console.log(`\n  depuis le poste (${POSTE_LIVE}) : ${poste.length} rouleaux, ${poste2.length} déclassés`)
  console.log(`    déclassés réservés à une ligne : ${poste2Aff.length}` +
    ` (${poste2Aff.length - poste2AffFree.length} déjà expédiés, ${poste2AffFree.length} encore en stock)`)
  for (const r of poste2Aff) {
    console.log(`      ${r.numero}  ligne=${r.IDLigne_Commande_TRM}  exp=${r.IDligne_expedition_TRM}  saisie=${d8(r.date_saisie)}`)
  }
  console.log('    → 3 le 2026-09-07 (3564/1001, 3542/1006, 3554/1001 — tous expédiés et')
  console.log('      facturés avant le correctif, laissés tels quels). Un chiffre qui MONTE')
  console.log('      est une régression du poste ; un déclassé encore en stock se libère')
  console.log('      avec fix-choix2-affectation-trm.ts --write.')

  // ── Defect vocabulary drift ───────────────────────────
  head('7. VOCABULAIRE DES DÉFAUTS — dérive vs le catalogue codé en dur')
  const vocab = await query<any>(
    `SELECT type_defaut, COUNT(*) AS n FROM defaut_qualite
     WHERE Type_Reference = 2 AND Type_Spotteur = 2 GROUP BY type_defaut ORDER BY n DESC`,
  )
  const vFixed = await fixEncoding(vocab, 'defaut_qualite', 'type_defaut', ['type_defaut'])
  console.log(`  ${(vFixed as any[]).map((v) => `${v.type_defaut}=${v.n}`).join('  ')}`)
  console.log('  → tout type ici absent de TYPES_DEFAUT (lib/production-trm.ts) est une')
  console.log('    dérive : soit l\'ajouter au catalogue, soit le replier dans normaliseTypeDefaut.')

  const sample = await selectDefauts(1, orphans.slice(0, 20).map((p: any) => Number(p.IDpiece_production)))
  console.log(`\n  (contrôle de lecture : ${sample.length} défauts T1 lus sur 20 pièces orphelines)`)
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => closeConnection())
