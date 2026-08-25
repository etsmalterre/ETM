/**
 * Ad-hoc financial analysis: why did the EBE fall between two comparable dates?
 *
 *   NODE_ENV=production node --import tsx src/scripts/analyse-ebe.ts 20260728 20250728 [societe]
 *
 * Read-only. Compares the compte-by-compte balance at two upload anchors, the
 * same arithmetic the Rapports > Finance screen uses (debit - credit at the
 * anchor date, class 6 bucketed by compte_compta.frais_variable, class 7 =
 * produits). Prints the produits / charges variables / charges fixes bridges
 * sorted by contribution, so the accounts driving the gap come out on top.
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })
const { query, fixEncoding, closeConnection } = await import('../lib/hfsql-auto.js')

const D_CUR = process.argv[2] ?? '20260728'
const D_PRV = process.argv[3] ?? '20250728'
const SOC = Number(process.argv[4] ?? 1)

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const eur = (v: number) => (v >= 0 ? '+' : '') + Math.round(v).toLocaleString('fr-FR')
const pad = (s: string, w: number) => s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length)

interface C { id: number; numero: number; libelle: string; variable: number }

async function balance(date: string): Promise<Map<number, number>> {
  const rows = await query<Record<string, unknown>>(
    `SELECT IDcompte_compta, debit, credit FROM releve_compta WHERE DATE = '${date}'`,
  )
  const m = new Map<number, number>()
  for (const r of rows) m.set(n(r.IDcompte_compta), n(r.debit) - n(r.credit))
  return m
}

async function main() {
  let comptes = await query<Record<string, unknown>>(
    `SELECT IDcompte_compta, numero, libelle, frais_variable FROM compte_compta WHERE id_societe = ${SOC}`,
  )
  comptes = await fixEncoding(comptes, 'compte_compta', 'IDcompte_compta', ['libelle'])
  const byId = new Map<number, C>()
  for (const c of comptes) {
    byId.set(n(c.IDcompte_compta), {
      id: n(c.IDcompte_compta),
      numero: n(c.numero),
      libelle: String(c.libelle ?? '').trim(),
      variable: n(c.frais_variable) === 1 ? 1 : 0,
    })
  }

  const [cur, prv] = await Promise.all([balance(D_CUR), balance(D_PRV)])
  const ids = new Set<number>([...cur.keys(), ...prv.keys()])

  type Row = C & { a: number; b: number; d: number }
  const rows: Row[] = []
  for (const id of ids) {
    const c = byId.get(id)
    if (!c || c.numero <= 0) continue
    const a = cur.get(id) ?? 0
    const b = prv.get(id) ?? 0
    if (a === 0 && b === 0) continue
    rows.push({ ...c, a, b, d: a - b })
  }

  const produits = rows.filter((r) => r.numero >= 700000)
  const chVar = rows.filter((r) => r.numero < 700000 && r.variable === 1)
  const chFix = rows.filter((r) => r.numero < 700000 && r.variable === 0)
  const sum = (rs: Row[], k: 'a' | 'b' | 'd') => rs.reduce((t, r) => t + r[k], 0)

  const section = (title: string, rs: Row[], sign: number, limit = 14) => {
    console.log(`\n${'═'.repeat(104)}\n${title}   ${D_CUR}: ${eur(sign * sum(rs, 'a'))}   ${D_PRV}: ${eur(sign * sum(rs, 'b'))}   écart ${eur(sign * sum(rs, 'd'))}\n${'═'.repeat(104)}`)
    console.log(`${pad('compte', 8)}${pad('libellé', 42)}${pad(D_CUR, 14)}${pad(D_PRV, 14)}${pad('écart', 13)}poids`)
    const tot = sign * sum(rs, 'd')
    const sorted = [...rs].sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    for (const r of sorted.slice(0, limit)) {
      const dd = sign * r.d
      const w = tot ? (dd / tot) * 100 : 0
      console.log(
        pad(String(r.numero), 8) + pad(r.libelle, 42) +
        pad(eur(sign * r.a), 14) + pad(eur(sign * r.b), 14) + pad(eur(dd), 13) +
        (Math.abs(w) >= 1 ? `${w >= 0 ? '+' : ''}${w.toFixed(0)} %` : ''),
      )
    }
    if (sorted.length > limit) {
      const rest = sorted.slice(limit)
      console.log(pad('', 8) + pad(`… ${rest.length} autres comptes`, 42) + pad('', 14) + pad('', 14) + pad(eur(sign * sum(rest, 'd')), 13))
    }
  }

  console.log(`ETM société ${SOC} — analyse de l'écart d'EBE  ${D_PRV} → ${D_CUR}`)
  section('PRODUITS (classe 7)', produits, -1)
  section('CHARGES VARIABLES', chVar, 1)
  section('CHARGES FIXES', chFix, 1)

  const P = -sum(produits, 'a'), Pp = -sum(produits, 'b')
  const V = sum(chVar, 'a'), Vp = sum(chVar, 'b')
  const F = sum(chFix, 'a'), Fp = sum(chFix, 'b')
  console.log(`\n${'═'.repeat(104)}\nSYNTHÈSE`)
  console.log(`  Produits        ${eur(P).padStart(12)}   vs ${eur(Pp).padStart(12)}   ${eur(P - Pp).padStart(12)}`)
  console.log(`  Charges var.    ${eur(-V).padStart(12)}   vs ${eur(-Vp).padStart(12)}   ${eur(-(V - Vp)).padStart(12)}`)
  console.log(`  Marge brute     ${eur(P - V).padStart(12)}   vs ${eur(Pp - Vp).padStart(12)}   ${eur((P - V) - (Pp - Vp)).padStart(12)}`)
  console.log(`  Taux de marge   ${(((P - V) / P) * 100).toFixed(2).padStart(11)}%   vs ${(((Pp - Vp) / Pp) * 100).toFixed(2).padStart(11)}%`)
  console.log(`  Charges fixes   ${eur(-F).padStart(12)}   vs ${eur(-Fp).padStart(12)}   ${eur(-(F - Fp)).padStart(12)}`)
  console.log(`  EBE             ${eur(P - V - F).padStart(12)}   vs ${eur(Pp - Vp - Fp).padStart(12)}   ${eur((P - V - F) - (Pp - Vp - Fp)).padStart(12)}`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
