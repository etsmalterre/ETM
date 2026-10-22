// One-off (2026-10-22, Vincent + Isabelle): the fictive « coloris à étudier » coloris.
//
// Until a client order line could wait for its étude coloris (lib/etude-ligne-client.ts), the office
// created a placeholder coloris on the fini reference (« coloris à étudier », « Coloris à définir »,
// « Coloris en étude », « etude coloris en cours »…) so the order could be confirmed, then switched the
// line to the real coloris once the étude was accepted. 40 such rows in prod (2026-10-22): 9 held by
// nothing, 24 kept alive only by the client's coloris catalogue (ref_client_colori, Clients › Gestion —
// registered so the line's coloris picker would offer the placeholder; none carries a contract), the
// rest by order / devis lines.
//
//   node --env-file=.env --import tsx src/scripts/nettoyer-coloris-fictifs.ts                       # lists
//   node --env-file=.env --import tsx src/scripts/nettoyer-coloris-fictifs.ts --lier=13270:1397,13271:1396
//   node --env-file=.env --import tsx src/scripts/nettoyer-coloris-fictifs.ts [--lier=…] [--catalogue] --write
//
// --lier=<ligne>:<étude>,… points open lines still on a fictive coloris at their étude (coloris 0), with
// the same checks as the screen (same client, same reference, one line per étude) — which étude a line
// waits for is Isabelle's call, never guessed here. Then every fictive coloris nothing holds is deleted
// through the screen's own rule (supprimerColorisFini: a roll, a line, a contract, an étude… keeps it).
// --catalogue also removes the client-catalogue entries (ref_client_colori) of a fictive coloris when
// none of them carries a contract (contrat = 0) — a contract price is never dropped by a script.
// Without --write nothing is written; idempotent.
import '../load-env.js'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'
import { refusLienEtude } from '../lib/etude-ligne-client.js'
import { usagesColorisFini, supprimerColorisFini, messageUsages } from '../lib/coloris-fini-suppression.js'

const write = process.argv.includes('--write')
const catalogue = process.argv.includes('--catalogue')
const CATALOGUE = 'Désignations / contrats client'
const lier = (process.argv.find((a) => a.startsWith('--lier='))?.slice('--lier='.length) ?? '')
  .split(',').filter(Boolean).map((p) => {
    const [l, e] = p.split(':').map((x) => parseInt(x, 10))
    if (!(l > 0) || !(e > 0)) throw new Error(`--lier invalide : ${p} (attendu <ligne>:<étude>)`)
    return { ligne: l, etude: e }
  })

/** A placeholder name, not a colour: « à étudier », « à définir », « en étude », « étude coloris ». */
// JS \b is ASCII-only: « à » needs an explicit space or start before it.
const FICTIF = /(^|\s)[àa] ([ée]tudier|d[ée]finir)|\ben [ée]tude\b|[ée]tude coloris/i

const sql = mpsPg()
console.log(write ? 'MODE ÉCRITURE' : 'Simulation (ajouter --write pour appliquer)')

for (const { ligne, etude } of lier) {
  const rows = await sql<{ idcommande_client: number; type: number; idreference: number; idcolori: number; idetude_col: number }[]>`
    SELECT idcommande_client, type, idreference, idcolori, idetude_col FROM ligne_commande_client WHERE idligne_commande_client = ${ligne}`
  const l = rows[0]
  if (!l) { console.log(`ligne ${ligne} : introuvable`); continue }
  const col = await sql<{ reference: string | null }[]>`SELECT reference FROM ref_fini_colori WHERE idref_fini_colori = ${l.idcolori}`
  const nom = (col[0]?.reference ?? '').trim()
  if (l.idcolori > 0 && !FICTIF.test(nom)) { console.log(`ligne ${ligne} : coloris réel « ${nom} », laissée telle quelle`); continue }
  const refus = await refusLienEtude(etude, { idCommande: Number(l.idcommande_client), typeKind: Number(l.type), refId: Number(l.idreference), idLigne: ligne })
  if (refus) { console.log(`ligne ${ligne} → étude ${etude} : refusé — ${refus}`); continue }
  console.log(`ligne ${ligne} (« ${nom} ») → étude ${etude}`)
  if (write) await sql`UPDATE ligne_commande_client SET idetude_col = ${etude}, idcolori = 0 WHERE idligne_commande_client = ${ligne}`
}

const coloris = (await sql<{ id: number; idref_fini: number; reference: string | null }[]>`
  SELECT idref_fini_colori AS id, idref_fini, reference FROM ref_fini_colori ORDER BY idref_fini_colori`)
  .filter((c) => FICTIF.test(c.reference ?? ''))
let supprimes = 0
for (const c of coloris) {
  const nom = (c.reference ?? '').trim()
  let usages = await usagesColorisFini(Number(c.idref_fini), Number(c.id))
  // The placeholder sits in clients' catalogues only so the picker offered it: drop those entries.
  if (catalogue && usages.some((u) => u.quoi === CATALOGUE)) {
    const [{ contrats }] = await sql<{ contrats: number }[]>`
      SELECT count(*)::int AS contrats FROM ref_client_colori WHERE idref_fini_colori = ${c.id} AND COALESCE(contrat, 0) <> 0`
    if (contrats === 0) {
      console.log(`catalogue #${c.id} « ${nom} » : entrées client retirées`)
      if (write) await sql`DELETE FROM ref_client_colori WHERE idref_fini_colori = ${c.id}`
      usages = usages.filter((u) => u.quoi !== CATALOGUE)
    }
  }
  if (usages.length > 0) { console.log(`garde     #${c.id} réf ${c.idref_fini} « ${nom} » — ${messageUsages(usages)}`); continue }
  console.log(`supprime  #${c.id} réf ${c.idref_fini} « ${nom} »`)
  if (write) { await supprimerColorisFini(Number(c.idref_fini), Number(c.id)); supprimes++ }
}
console.log(`${coloris.length} coloris fictif(s), ${write ? `${supprimes} supprimé(s)` : 'rien écrit'}`)
await closeMpsPg()
// refusLienEtude reads through the legacy layer, whose pool keeps the process alive.
process.exit(0)
