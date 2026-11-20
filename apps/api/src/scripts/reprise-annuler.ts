// Cancels a reprise opened by mistake (LIVA #1384). No screen does it: a
// reprise is closed by receiving its rolls back, which keeps « repris ×1 » on
// the lot and leaves its controls erased.
//
//   npx tsx src/scripts/reprise-annuler.ts <id reprise> [--env production] [--par "Prénom Nom"] [--write]
//
// Dry run by default (read-only transaction, no write attempted): prints what
// it would put back.
// In ONE transaction, for an OPEN reprise none of whose rolls came back:
//   - its rolls still « En reprise » return to the lot's état before (Validé
//     when the lot was validated, En contrôle otherwise);
//   - the lot returns to that état, and each measure the opening erased is
//     put back from `reprise.lot_avant` — a measure typed since is kept;
//   - the lab is no longer asked to throw the tirelle away and stands where it
//     stood (kept in `lot_avant` since #1384; a reprise opened before that
//     puts the lot back in the tablet's queue). A tirelle already thrown stays
//     thrown: the measures come back, the sample does not;
//   - the `reprise` row and its pieces are DELETED (the reprise never took
//     place: no « repris ×N », no rapport de contrôle owed again), and one
//     line in the lot's Journal says so.
// Refused: a closed or historical reprise, a reprise with a roll already back.
//
// Connection: MPS_PG_OWNER_URL (production — the API role may not DELETE from
// `reprise`), else PG_CONNECTION_STRING (dev: `mps_dev` owns its copy).
import { config } from 'dotenv'
import { resolve } from 'node:path'
import postgres, { type Sql } from 'postgres'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const env = arg('env') ?? 'development'
const write = process.argv.includes('--write')
const par = (arg('par') ?? '').trim() || null
const id = parseInt(process.argv[2] ?? '', 10)
if (!(id > 0)) {
  console.error('Usage : npx tsx src/scripts/reprise-annuler.ts <id reprise> [--env production] [--par "Prénom Nom"] [--write]')
  process.exit(1)
}
config({ path: env === 'production' ? resolve(process.cwd(), '../../../ETM/apps/api/.env.production') : resolve(process.cwd(), '.env.development') })
const url = process.env.MPS_PG_OWNER_URL || process.env.PG_CONNECTION_STRING
if (!url) { console.error('Neither MPS_PG_OWNER_URL nor PG_CONNECTION_STRING is set.'); process.exit(1) }
const sql = postgres(url, {
  max: 1, onnotice: () => {},
  connection: { application_name: 'reprise-annuler', default_transaction_read_only: !write },
})

// What effacerControlesPourReprise() erases (lib/tirelle-labo.ts), and to what.
const A_ZERO = ['laize_sst', 'poids_sst', 'rendement_sst', 'laize_tirelle', 'poids_tirelle', 'rendement_tirelle']
const A_NULL = ['stabh_sst', 'stabl_sst', 'vrillage_sst', 'stabh_tirelle', 'stabl_tirelle', 'vrillage_tirelle',
  'coloris_tirelle', 'allongementh_tirelle', 'allongementl_tirelle']
const jour = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) : '?')

class Refus extends Error {}

try {
  await sql.begin(async (t) => {
    const tx = t as unknown as Sql
    const [rep] = await tx<{ id: number; ligne: number; lot: string; statut: string; origine: string; motif: string | null; envoye_le: Date | null; envoye_par: string | null; lot_avant: Record<string, unknown> | null }[]>`
      SELECT id, idligne_commande_sous_traitant AS ligne, lot, statut, origine, motif, envoye_le, envoye_par, lot_avant
      FROM reprise WHERE id = ${id} ${write ? tx`FOR UPDATE` : tx``}`
    if (!rep) throw new Refus(`Reprise ${id} introuvable.`)
    if (rep.statut !== 'ouverte' || rep.origine !== 'geste') throw new Refus(`Reprise ${id} : ${rep.statut}, origine ${rep.origine}. Seule une reprise ouverte par un geste s’annule.`)
    const pieces = await tx<{ id: number; numero: string | null; etat: number; revenu: boolean }[]>`
      SELECT rp.idstock_fini AS id, trim(sf.numero::text) AS numero, COALESCE(sf.idetat_stock_fini, 0) AS etat, rp.revenu_le IS NOT NULL AS revenu
      FROM reprise_piece rp LEFT JOIN stock_fini sf ON sf.idstock_fini = rp.idstock_fini
      WHERE rp.idreprise = ${id} ORDER BY sf.numero`
    if (pieces.some((p) => p.revenu)) throw new Refus(`Reprise ${id} : un rouleau en est déjà revenu. Elle se clôt par « Réceptionner la reprise ».`)

    const avant = rep.lot_avant ?? {}
    const etatAvant = Number(avant.idetatlot) === 3 ? 3 : 1
    console.log(`Reprise ${id} · lot ${rep.lot} · ligne sst ${rep.ligne} · ouverte le ${jour(rep.envoye_le)} par ${rep.envoye_par ?? '?'} · motif : ${rep.motif ?? ''}`)

    // 1. The rolls.
    const enReprise = pieces.filter((p) => Number(p.etat) === 2)
    console.log(`Rouleaux : ${pieces.length} dans la reprise, ${enReprise.length} encore « En reprise » → ${etatAvant === 3 ? 'Validé' : 'En contrôle'} (${enReprise.map((p) => p.numero).join(', ') || 'aucun'})`)
    if (write && enReprise.length) {
      await tx`UPDATE stock_fini SET idetat_stock_fini = ${etatAvant} WHERE idstock_fini = ANY(${enReprise.map((p) => Number(p.id))}) AND idetat_stock_fini = 2`
    }

    // 2. The lot: its état, then every measure still erased.
    const idsuivilot = Number(avant.idsuivilot) || 0
    const [lot] = idsuivilot
      ? await tx<Record<string, unknown>[]>`SELECT * FROM suivilot WHERE idsuivilot = ${idsuivilot} ${write ? tx`FOR UPDATE` : tx``}`
      : []
    if (!lot) {
      console.log('Lot : aucune fiche Suivi lots gardée dans la reprise, rien à remettre.')
    } else {
      const set: Record<string, unknown> = {}
      const gardees: string[] = []
      for (const f of [...A_ZERO, ...A_NULL]) {
        const v = avant[f]
        const effacee = lot[f] == null || (A_ZERO.includes(f) && Number(lot[f]) === 0)
        const rien = v == null || (A_ZERO.includes(f) && Number(v) === 0)
        if (rien) continue
        if (effacee) set[f] = v
        else if (String(lot[f]) !== String(v)) gardees.push(`${f} = ${lot[f]} (avant ${v})`)
      }
      // The lot leaves « En reprise » unless a roll of it, outside this reprise, is still at the dyer.
      const [reste] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM stock_fini
        WHERE idref_commande_source = ${rep.ligne} AND trim(lot::text) = ${rep.lot} AND idetat_stock_fini = 2
          AND idstock_fini <> ALL(${pieces.map((p) => Number(p.id))})`
      if (Number(lot.idetatlot) === 2 && Number(reste?.n) === 0) {
        set.idetatlot = etatAvant
        if (etatAvant === 3) set.approuve_qualite = 1
      }
      console.log(`Lot (fiche ${idsuivilot}) : ${Object.entries(set).map(([k, v]) => `${k} = ${v}`).join(' · ') || 'rien à remettre'}`)
      if (gardees.length) console.log(`  saisi depuis, gardé : ${gardees.join(' · ')}`)
      if (write && Object.keys(set).length) await tx`UPDATE suivilot SET ${tx(set)} WHERE idsuivilot = ${idsuivilot}`

      // 3. The lab.
      const [labo] = await tx<{ a_jeter: boolean; jete: boolean }[]>`
        SELECT a_jeter_depuis IS NOT NULL AS a_jeter, jete_le IS NOT NULL AS jete FROM tirelle_labo WHERE idsuivilot = ${idsuivilot}`
      if (labo?.a_jeter) {
        // Where the lab stood before, when the reprise kept it (since #1384).
        const termine = typeof avant.labo_termine_le === 'string' ? avant.labo_termine_le : null
        if (avant.labo_connu === false) {
          console.log('Labo : la demande « à jeter » est retirée (le labo ne connaissait pas encore ce lot).')
          if (write) await tx`DELETE FROM tirelle_labo WHERE idsuivilot = ${idsuivilot}`
        } else {
          console.log(`Labo : la demande « à jeter » est retirée${termine ? ', le lot redevient terminé au labo' : avant.labo_connu === undefined ? ' (étape du labo d’avant inconnue : le lot reprend sa place dans la file de la tablette)' : ''}.`)
          if (write) await tx`
            UPDATE tirelle_labo SET a_jeter_depuis = NULL, a_jeter_motif = NULL, a_jeter_casier = NULL,
              termine_le = COALESCE(termine_le, ${termine}::timestamptz), maj_le = now()
            WHERE idsuivilot = ${idsuivilot}`
        }
      } else if (labo?.jete) {
        console.log('Labo : ⚠️ la tirelle a déjà été jetée. Les mesures reviennent, pas l’échantillon.')
      } else {
        console.log('Labo : rien à retirer.')
      }

      // 4. The trace, in the lot's Journal (an état line reads as its own title).
      if (write) await tx`
        INSERT INTO journal_lot (idsuivilot, evenement, detail, par_id, par)
        VALUES (${idsuivilot}, 'etat', ${`Reprise du ${jour(rep.envoye_le)} annulée (ouverte par erreur)`}, 0, ${par})`
    }

    // 5. The reprise never took place.
    if (write) {
      await tx`DELETE FROM reprise_piece WHERE idreprise = ${id}`
      await tx`DELETE FROM reprise WHERE id = ${id}`
    }
    console.log(write ? 'Reprise supprimée. Fait.' : 'Essai à blanc : rien n’est écrit. Relancer avec --write.')
  })
} catch (err) {
  if (err instanceof Refus) console.error(err.message)
  else console.error('Annulation impossible :', err)
  process.exitCode = 1
} finally {
  await sql.end()
}
