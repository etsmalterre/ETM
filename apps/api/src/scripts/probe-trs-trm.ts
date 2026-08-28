// Read-only probe for the TRS tablet endpoint: prints the current shift's
// per-métier figures as a table, so a human can compare them with the legacy
// tablet (Appli_TRS) side by side. Re-run after an /etm_deploy against prod —
// it is the only exercise of the Linux path.
//
//   pnpm exec tsx src/scripts/probe-trs-trm.ts            # http://localhost:8080
//   TRS_API_URL=http://localhost:8081 pnpm exec tsx src/scripts/probe-trs-trm.ts
//   TRS_API_URL=https://trm.malterre pnpm exec tsx src/scripts/probe-trs-trm.ts

const base = (process.env.TRS_API_URL ?? 'http://localhost:8080').replace(/\/$/, '')

const res = await fetch(`${base}/api/trs/atelier`)
if (!res.ok) {
  console.error(`GET /api/trs/atelier → ${res.status}`)
  process.exit(1)
}
const body = await res.json()

const hms = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR') : '—')
const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)} %`)
const dur = (s: number) => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`

console.log(
  `Équipe ${body.equipe.nom} ${hms(body.equipe.debut)} → ${hms(body.equipe.fin)} · généré ${hms(body.generatedAt)}` +
    ` · dernier événement du parc ${hms(body.dernierEvenement)}`,
)
console.log(
  `Parc : TRS ${pct(body.parc.trs)} · ${body.parc.enMarche} en marche · ${body.parc.arret} à l'arrêt · ${body.parc.inactifs} sans OF`,
)
console.table(
  body.machines.map((m: any) => ({
    métier: m.emplacement,
    état: m.etat === 1 ? 'marche' : m.etat === 0 ? 'arrêt' : '?',
    depuis: hms(m.depuisMs ? new Date(m.depuisMs).toISOString() : null),
    'tr/min': m.vitesse,
    OF: m.of ? `${m.of.id} ${m.of.reference}${m.of.coloris ? ' ' + m.of.coloris : ''}` : '',
    prod: m.enProduction ? 'oui' : '',
    'P': dur(m.tempsProdS),
    marche: dur(m.tempsMarcheS),
    déduct: `${Math.round(m.deductibleS / 60)} min`,
    'arrêts / pièce': m.arretsParPiece,
    'arr/h': m.arretsParHeure,
    TRS: pct(m.trs),
  })),
)

export {}
