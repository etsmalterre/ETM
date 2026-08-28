// Read-only probe for the ERP's TRS endpoint (Production › TRS): prints one
// shift the way the legacy FI_TRS window shows it — the four KPI cards, the
// per-métier line (P / marche / déductibles / arrêts / TRS) and the roster —
// so a human can compare with the legacy screen side by side. Re-run after
// an /etm_deploy against prod: it is the only exercise of the Linux path.
//
//   pnpm exec tsx src/scripts/probe-trs-equipe-trm.ts                       # current shift, localhost:8080
//   pnpm exec tsx src/scripts/probe-trs-equipe-trm.ts --debut 20251015130000
//   TRS_API_URL=http://localhost:8081 pnpm exec tsx src/scripts/probe-trs-equipe-trm.ts --debut 20260828130000
//   TRS_API_URL=https://trm.malterre pnpm exec tsx src/scripts/probe-trs-equipe-trm.ts
//
// The endpoint is behind `view_trs`, so the probe signs the admin cookie the
// way the check scripts do (AUTH_COOKIE_SECRET, dev default otherwise).
// Expected on the 28/08/2026 13 h shift (legacy capture): Production 11
// pièces 212 kg, Visitage 14 / 244 kg, 2ᵉ choix 1 / 4 kg / 1,64 %, non
// visitées 3; TRS 1G 85 %, 2E 99 %, 2F 89 %, 2I 28 %, 3B 63 %, 3C 90 %,
// 3D 97 %, 3E 65 %, 3H 9 % — the three documented deltas of calculerTrs
// explain small gaps, anything larger is worth a look.

import dotenv from 'dotenv'
dotenv.config({ path: '.env.development' })
dotenv.config({ path: '.env' })

import crypto from 'node:crypto'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const base = (process.env.TRS_API_URL ?? 'http://localhost:8080').replace(/\/$/, '')
const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`

const i = process.argv.indexOf('--debut')
const debut = i >= 0 ? process.argv[i + 1] : ''
const url = `${base}/api/trs/equipe${debut ? `?debut=${debut}` : ''}`

const t0 = Date.now()
const res = await fetch(url, { headers: { Cookie: COOKIE } })
if (!res.ok) {
  console.error(`GET ${url} → ${res.status} ${await res.text()}`)
  process.exit(1)
}
const body = await res.json()
const ms = Date.now() - t0

const hm = (x: number | string | null | undefined) => {
  if (x === null || x === undefined) return '—'
  const d = new Date(x)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)} %`)
const dur = (s: number) => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`

console.log(
  `Équipe ${body.equipe.nom} ${body.equipe.debutLit} · ${hm(body.equipe.debut)} → ${hm(body.equipe.fin)}` +
    ` · ${body.equipe.enCours ? 'en cours' : body.equipe.passee ? 'passée' : '?'} · ${ms} ms · ${JSON.stringify(body).length} octets`,
)
const k = body.kpi
console.log(
  `Production ${k.production.pieces} pièces ${k.production.kg} kg (${k.production.kgParHeure ?? '—'} kg/h)` +
    ` · Visitage ${k.visitage.pieces} pièces ${k.visitage.kg} kg` +
    ` · Second choix ${k.secondChoix.pieces} pièces ${k.secondChoix.kg} kg ${k.secondChoix.pct ?? '—'} %` +
    ` · Non visitées à ${k.nonVisitees.heureFin}H ${k.nonVisitees.pieces} pièces` +
    ` · TRS atelier ${pct(body.parc.trs)}`,
)
console.table(
  body.machines.map((m: any) => ({
    métier: m.emplacement,
    OF: m.of ? `${m.of.id} ${m.of.reference}${m.of.coloris ? ' ' + m.of.coloris : ''}` : '',
    automate: m.sansAutomate ? 'non' : '',
    segments: m.segments.length,
    évts: m.evenements.length,
    P: dur(m.tempsProdS),
    marche: dur(m.tempsMarcheS),
    déduct: `${Math.round(m.deductibleS / 60)} min`,
    arrêts: m.arrets,
    'arr/h': m.arretsParHeure,
    vitesse: m.of?.vitesse ?? '',
    TRS: pct(m.trs),
    teintes: `${m.teintes.vitesse[0]}/${m.teintes.arrets[0]}/${m.teintes.trs?.[0] ?? '-'}`,
  })),
)
console.log(`Bonnetiers pointés — Total ${dur(body.equipeBonnetiers.totalS)}`)
for (const b of body.equipeBonnetiers.rows) {
  console.log(
    `  ${b.prenom} ${b.nom}${b.regleur ? ' (régleur)' : ''} · ` +
      b.intervalles.map((x: any) => `${hm(x.debutMs)}–${hm(x.finMs)}`).join(', ') +
      (b.pauses.length ? ` · pauses ${b.pauses.map((x: any) => `${hm(x.debutMs)}–${hm(x.finMs)}`).join(', ')}` : '') +
      ` · ${dur(b.dureeS)}`,
  )
}
const p = body.pieces
console.log(
  `Listes — production ${p.production.length}, visitage ${p.visitage.length}, second choix ${p.secondChoix.length}, non visitées ${p.nonVisitees.length}` +
    ` · cartes d'événements pour ${Object.keys(body.evenements).length} pièces`,
)
if (p.visitage[0]) {
  const r = p.visitage[0]
  console.log(`  ex. ${r.numero} ${r.poids} kg ${r.machine} ${r.reference} → ${(body.evenements[r.cle] ?? []).map((e: any) => `${e.evenement}${e.observation ? ' (' + e.observation + ')' : ''} ${hm(e.date)} ${e.bonnetier}`).join(' | ')}`)
}
