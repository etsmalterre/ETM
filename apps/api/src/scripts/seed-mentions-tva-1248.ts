/**
 * LIVA #1248 — sets the mention légale of the French TRM clients at 0 % whose
 * reason is known (2026-09-30, Vincent + their own invoices):
 *   - SOFILETA (14): yearly « attestation d'achat en franchise » → art. 275;
 *   - SUEZ RV PICARDIE (817), HAUREC (952), GURDEBEKE RECYCLAGE (1094): sales
 *     of waste (carton, film) whose invoices already carried a hand-typed
 *     « auto-liquidation 283-2 sexies » line → autoliquidation.
 * AIN Fibres (745) is left empty on purpose: no known reason (its 0 % is
 * probably a mistake) — the Facturation alert flags it on its next invoice.
 *
 * Only writes a client still at 0 %, in société 2, with no mention yet.
 * Dry run by default; `--write` to apply. ⚠️ Restart the API afterwards: the
 * store caches data/tva-exoneration.json in memory.
 */
import '../load-env.js'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { getMentionClient, setMentionClient } from '../lib/tva-exoneration-store.js'
import type { MentionClient } from '../lib/tva-mention.js'

const CIBLES: Array<{ id: number; nom: string; mention: MentionClient }> = [
  { id: 14, nom: 'SOFILETA', mention: { code: 'franchise_275', texte: '' } },
  { id: 817, nom: 'SUEZ RV PICARDIE', mention: { code: 'autoliquidation_dechets', texte: '' } },
  { id: 952, nom: 'HAUREC', mention: { code: 'autoliquidation_dechets', texte: '' } },
  { id: 1094, nom: 'GURDEBEKE RECYCLAGE', mention: { code: 'autoliquidation_dechets', texte: '' } },
]

async function main() {
  const write = process.argv.includes('--write')
  for (const c of CIBLES) {
    const rows = await query<{ nom: string; IDsociete: number; valeur: number | null }>(
      `SELECT c.nom, c.IDsociete, t.valeur FROM client c LEFT JOIN tva t ON t.IDtva = c.IDtva WHERE c.IDclient = ${c.id}`,
    )
    const r = rows[0]
    if (!r) { console.log(`SKIP  ${c.id} ${c.nom}: client introuvable`); continue }
    if (Number(r.IDsociete) !== 2) { console.log(`SKIP  ${c.id} ${r.nom}: pas un client TRM`); continue }
    if ((Number(r.valeur) || 0) !== 0) { console.log(`SKIP  ${c.id} ${r.nom}: TVA à ${r.valeur} %`); continue }
    const actuelle = await getMentionClient(c.id)
    if (actuelle) { console.log(`SKIP  ${c.id} ${r.nom}: mention déjà choisie (${actuelle.code})`); continue }
    console.log(`${write ? 'WRITE' : 'DRY  '} ${c.id} ${r.nom} → ${c.mention.code}`)
    if (write) await setMentionClient(c.id, c.mention)
  }
  if (!write) console.log('\nDry run — relancer avec --write, puis redémarrer l\'API.')
  await closeConnection()
}

main().catch(async (e) => { console.error(e); await closeConnection(); process.exit(1) })
