import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })
const { query, closeConnection } = await import('../lib/hfsql-auto.js')
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const d8 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(0, 8)
const e = (v: number) => Math.round(v).toLocaleString('fr-FR')
const D = '20251231'
const T = { kg: 21039, achat: 283526, actuelle: 125555 }

async function main() {
  const exps = await query<Record<string, unknown>>(`SELECT IDexpedition, DATE AS dexp FROM expedition`)
  const ed = new Map<number, string>(); for (const x of exps) ed.set(n(x.IDexpedition), d8(x.dexp))
  const lg = await query<Record<string, unknown>>(`SELECT IDligne_expedition, IDexpedition FROM ligne_expedition`)
  const led = new Map<number, string>()
  for (const l of lg) { const d = ed.get(n(l.IDexpedition)); if (d) led.set(n(l.IDligne_expedition), d) }

  const fini = await query<Record<string, unknown>>(
    `SELECT IDstock_fini, IDstock_ecru, IDref_fini, poids, date_saisie, second_choix, IDligne_expedition, destockage, don FROM stock_fini`,
  )
  const held = fini.filter((r) => {
    const m = d8(r.date_saisie); if (!m || m > D) return false
    if (n(r.destockage) || n(r.don)) return false
    const sh = led.get(n(r.IDligne_expedition)); return !(sh && sh <= D)
  })

  const ecru = await query<Record<string, unknown>>(
    `SELECT IDstock_ecru, IDref_ecru, IDref_commande_source, IDref_commande_affectation FROM stock_ecru`,
  )
  const eInfo = new Map<number, { ref: number; s: number; a: number }>()
  for (const r of ecru) eInfo.set(n(r.IDstock_ecru), { ref: n(r.IDref_ecru), s: n(r.IDref_commande_source), a: n(r.IDref_commande_affectation) })
  const lcs = await query<Record<string, unknown>>(`SELECT IDligne_commande_sous_traitant, prix FROM ligne_commande_sous_traitant`)
  const prixLcs = new Map<number, number>(); for (const r of lcs) prixLcs.set(n(r.IDligne_commande_sous_traitant), n(r.prix))

  // theoretical yarn cost per écru reference, from composition_ecru
  const comp = await query<Record<string, unknown>>(`SELECT * FROM composition_ecru`)
  console.log('composition_ecru :', comp.length, 'lignes —', Object.keys(comp[0] ?? {}).join(', '))
  const rfil = await query<Record<string, unknown>>(`SELECT IDref_fil, prix_kg FROM ref_fil`)
  const prixFil = new Map<number, number>(); for (const r of rfil) prixFil.set(n(r.IDref_fil), n(r.prix_kg))
  const filParRef = new Map<number, { pct: number; val: number }>()
  for (const r of comp) {
    const ref = n(r.IDref_ecru), pct = n(r.pourcentage)
    const p = prixFil.get(n(r.IDref_fil)) ?? 0
    if (ref <= 0 || pct <= 0 || p <= 0) continue
    const o = filParRef.get(ref) ?? { pct: 0, val: 0 }
    o.pct += pct; o.val += pct * p; filParRef.set(ref, o)
  }

  const taux = (r: Record<string, unknown>) => {
    if (n(r.second_choix)) return 0.90
    const m = d8(r.date_saisie)
    if (m >= '20241231') return 0
    if (m >= '20231231') return 0.50
    return 0.90
  }

  for (const [label, useFacon] of [['fil seul', false], ['fil + façon', true]] as [string, boolean][]) {
    let kg = 0, achat = 0, actuelle = 0, ok = 0
    for (const r of held) {
      const p = n(r.poids); kg += p
      const o = eInfo.get(n(r.IDstock_ecru))
      const f = filParRef.get(o?.ref ?? 0)
      const filKg = f && f.pct > 0 ? f.val / f.pct : 0
      if (filKg > 0) ok++
      const facon = useFacon ? (prixLcs.get(o?.s ?? 0) ?? 0) + (prixLcs.get(o?.a ?? 0) ?? 0) : 0
      const pk = filKg + facon
      achat += p * pk; actuelle += p * pk * (1 - taux(r))
    }
    console.log(`\n[${label}]  ${ok}/${held.length} rouleaux avec composition résolue`)
    console.log(`  valeur d'achat  ${e(achat).padStart(10)}  (PDF ${e(T.achat)})   prix moyen ${(achat / kg).toFixed(2)} €/kg  (PDF ${(T.achat / T.kg).toFixed(2)})`)
    console.log(`  valeur actuelle ${e(actuelle).padStart(10)}  (PDF ${e(T.actuelle)})   dépréciation ${((1 - actuelle / achat) * 100).toFixed(1)} %  (PDF 55.7 %)`)
  }
}
main().catch((e) => { console.error(String(e).slice(0, 600)); process.exitCode = 1 }).finally(() => closeConnection())
