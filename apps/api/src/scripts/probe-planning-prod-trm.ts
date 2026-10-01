// Read-only probe of TRM Production › Planning (LIVA #1250): prints the
// measured rendements, the calendar split and each métier's line.
//   npx tsx src/scripts/probe-planning-prod-trm.ts
// ⚠️ chargerPlan() runs healHandedOverOfs() first, like every OF reader.
import '../load-env.js'
import { chargerPlan } from '../lib/planning-prod-trm-charge.js'
import { closeMpsPg } from '../lib/mps-pg.js'

const f = (ms: number | null) =>
  ms === null ? '—' : new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })

try {
  const t0 = Date.now()
  const p = await chargerPlan()
  console.log(`plan in ${Date.now() - t0} ms — régime ${p.reglage.regime}, réel jusqu'au ${f(p.reel_jusqua)}`)
  for (const m of p.machines) {
    const segs = p.segments.filter((s) => s.idmachine === m.id)
    if (segs.length === 0) continue
    console.log(`${m.label.padEnd(4)} rendement ${m.rendement} (${m.rendement_source}, n=${m.rendement_echantillons})`)
    for (const s of segs) {
      console.log(`   ${s.type} ${s.id} ${s.kg} kg  ${f(s.debut)} → ${f(s.fin)}${s.approx ? ' ~' : ''}${s.actif ? ' (en cours)' : ''}`)
    }
  }
  for (const l of p.lignes) {
    console.log(`cmd ${l.numero} ligne ${l.ligne_id} ${l.reference} ${l.quantite} kg, reste ${l.reste_a_lancer}, délai ${l.date_livraison}, fin ${f(l.fin_prevue)}${l.en_retard ? ' RETARD' : ''}, ${l.machines_compatibles.length} métiers`)
  }
  console.log('rendements', p.machines.map((m) => `${m.label}:${m.rendement}${m.rendement_source === 'mesure' ? '' : '*'}`).join(' '))
} finally {
  await closeMpsPg()
}
