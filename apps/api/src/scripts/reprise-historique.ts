// The old reprise suffixes become data (lib/reprises.ts, decision Vincent 2026-10-12).
//
//   npx tsx src/scripts/reprise-historique.ts [--env production] [--write | --essai] [--inclure MA99240R2,MA11313R3]
//
// Dry run by default (read-only transaction). For each (sst line, suffixed lot):
//   - R / r / -R / REPRIS / R1 = 1st reprise, R2 / BIS = 2nd, R3 / TER = 3rd;
//     a lot in Rn gets reprises 1…n (a roll in R2 went through two), each a
//     `reprise` row: close, origine 'historique', undated (no date exists:
//     suivilot.date and date_saisie are the FIRST reception), `lot_saisi` =
//     the suffixed text it replaces;
//   - the rolls take the dyer's number back (the base lot's exact text when
//     the line already has it: « ma98833 » stays « ma98833 »);
//   - the suffixed lot's suivilot is renamed — or, when the line already has
//     the base lot's suivilot, the base one is kept and the suffixed row is
//     stored whole in the last reprise's `lot_avant` (`suivilot_fusionne`)
//     before being deleted.
// Never guessed, only listed: lone letters (A/B/C…) and free text (not
// reprises), a line 0, lots whose digits look mistyped (5 digits on a roll
// received since 2023 — MATEL passed 100000 in 2023; --inclure to take them),
// a line that already has reprise rows, and rolls left « En reprise ».
import { config } from 'dotenv'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const env = arg('env') ?? 'development'
// --essai: the write path inside ONE transaction, rolled back at the end (dev check).
const essai = process.argv.includes('--essai')
const write = process.argv.includes('--write') || essai
config({ path: env === 'production' ? resolve(process.cwd(), '../../../ETM/apps/api/.env.production') : resolve(process.cwd(), '.env.development') })
if (!write) process.env.PGOPTIONS = '-c default_transaction_read_only=on'
// Mistyped digits, corrected only on proof and Vincent's go (2026-10-12): the
// dyer's BL PDFs filed on order 5499 are MA101313.pdf, MA101313R.pdf, MA101313R3.pdf.
const CORRECTIONS: Record<string, string> = { MA11313R3: 'MA101313' }
// Real old lots reprised later (the base lot sits on the same order), Vincent's go 2026-10-12.
const VALIDES = ['MA98170R', 'MA99240R2']
const inclure = new Set([...VALIDES, ...Object.keys(CORRECTIONS)].concat((arg('inclure') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)))

const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const { suffixeReprise } = await import('../lib/reprises.js')
const sql = mpsPg()
// A dry run only reads: it works before the migration created the tables.
const [{ table }] = await sql<{ table: boolean }[]>`SELECT to_regclass('reprise') IS NOT NULL AS table`
if (write && !table) throw new Error('table reprise absente : lancer mps-migrate --write d’abord')
const norm = (s: string) => s.toUpperCase().replace(/\s+/g, '')

const rows = await sql<{ id: number; ligne: number; lot: string; etat: number; annee: number }[]>`
  SELECT idstock_fini AS id, COALESCE(idref_commande_source, 0) AS ligne, trim(lot::text) AS lot,
         COALESCE(idetat_stock_fini, 0) AS etat, COALESCE(extract(year FROM date_saisie), 0)::int AS annee
  FROM stock_fini WHERE trim(lot::text) ~ '[0-9]{5,}.*[A-Za-z][0-9]?$'`

type Groupe = { ligne: number; lot: string; ids: number[]; etats: Set<number>; annee: number }
const groupes = new Map<string, Groupe>()
for (const r of rows) {
  const k = `${r.ligne}|${r.lot}`
  const g = groupes.get(k) ?? { ligne: Number(r.ligne), lot: r.lot, ids: [], etats: new Set<number>(), annee: 0 }
  g.ids.push(Number(r.id)); g.etats.add(Number(r.etat)); g.annee = Math.max(g.annee, Number(r.annee))
  groupes.set(k, g)
}

const aRevoir: Array<{ lot: string; ligne: number; rouleaux: number; raison: string }> = []
// (line, base) → the suffixed groups to fold into it.
const cibles = new Map<string, { ligne: number; base: string; groupes: Array<Groupe & { rang: number }> }>()
for (const g of groupes.values()) {
  const lu = suffixeReprise(g.lot)
  const s = lu && CORRECTIONS[g.lot] ? { ...lu, base: CORRECTIONS[g.lot] } : lu
  if (!s) { aRevoir.push({ lot: g.lot, ligne: g.ligne, rouleaux: g.ids.length, raison: 'pas une reprise (lettre ou texte libre) — non touché' }); continue }
  if (!(g.ligne > 0)) { aRevoir.push({ lot: g.lot, ligne: g.ligne, rouleaux: g.ids.length, raison: 'rouleau sans ligne sous-traitant' }); continue }
  const chiffres = /\d{5,}/.exec(s.base)?.[0] ?? ''
  if (chiffres.length === 5 && g.annee >= 2023 && !inclure.has(g.lot.toUpperCase())) {
    aRevoir.push({ lot: g.lot, ligne: g.ligne, rouleaux: g.ids.length, raison: `chiffres suspects (5 chiffres en ${g.annee}) — --inclure pour le prendre` }); continue
  }
  const k = `${g.ligne}|${norm(s.base)}`
  const c = cibles.get(k) ?? { ligne: g.ligne, base: s.base, groupes: [] }
  c.groupes.push({ ...g, rang: s.rang })
  cibles.set(k, c)
}

let reprises = 0, rouleaux = 0, renommes = 0, fusionnes = 0
const plan: Array<Record<string, unknown>> = []
const ESSAI = new Error('essai annulé')
const tout = async (t: Sql) => { for (const c of cibles.values()) await (async () => {
  const run = async (t: Sql) => {
    // The base lot's exact text when the line already has it.
    const existants = await t<{ lot: string }[]>`
      SELECT DISTINCT trim(lot::text) AS lot FROM stock_fini WHERE idref_commande_source = ${c.ligne}
      UNION SELECT DISTINCT trim(lot::text) FROM suivilot WHERE idligne_commande_sous_traitant = ${c.ligne}`
    const base = existants.map((e) => e.lot).find((l) => norm(l) === norm(c.base)) ?? c.base
    const [deja] = table
      ? await t<{ n: number }[]>`SELECT count(*)::int AS n FROM reprise WHERE idligne_commande_sous_traitant = ${c.ligne} AND lot = ${base}`
      : [{ n: 0 }]
    if (Number(deja?.n) > 0) {
      aRevoir.push({ lot: c.groupes.map((g) => g.lot).join(' + '), ligne: c.ligne, rouleaux: c.groupes.reduce((a, g) => a + g.ids.length, 0), raison: 'la ligne a déjà des reprises pour ce lot' })
      return
    }
    const rangMax = Math.max(...c.groupes.map((g) => g.rang))
    const saisis = c.groupes.map((g) => g.lot).join(' + ')
    const suivis = await t<Record<string, unknown>[]>`
      SELECT * FROM suivilot WHERE idligne_commande_sous_traitant = ${c.ligne}
        AND trim(lot::text) IN ${t([base, ...c.groupes.map((g) => g.lot)])} ORDER BY idsuivilot`
    const suiviBase = suivis.find((s) => String(s.lot ?? '').trim() === base)
    const suivisSuffixes = suivis.filter((s) => String(s.lot ?? '').trim() !== base)
    plan.push({ ligne: c.ligne, base, saisi: saisis, reprises: rangMax, rouleaux: c.groupes.reduce((a, g) => a + g.ids.length, 0), suivilot: suiviBase ? `fusion (${suivisSuffixes.length})` : `renommé (${suivisSuffixes.length})` })

    for (let rang = 1; rang <= rangMax; rang++) {
      const pieces = c.groupes.filter((g) => g.rang >= rang).flatMap((g) => g.ids)
      const dernier = rang === rangMax
      const avant = dernier && suiviBase && suivisSuffixes.length ? { suivilot_fusionne: suivisSuffixes } : null
      reprises++
      if (!write) continue
      const [rep] = await t<{ id: number }[]>`
        INSERT INTO reprise (idligne_commande_sous_traitant, lot, rang, statut, origine, lot_saisi, lot_avant)
        VALUES (${c.ligne}, ${base}, ${rang}, 'close', 'historique', ${saisis}, ${avant ? t.json(avant as never) : null})
        RETURNING id`
      for (const id of pieces) await t`INSERT INTO reprise_piece (idreprise, idstock_fini) VALUES (${rep.id}, ${id})`
    }
    const ids = c.groupes.flatMap((g) => g.ids)
    rouleaux += ids.length
    if (!suiviBase && suivisSuffixes.length) renommes++
    fusionnes += suiviBase ? suivisSuffixes.length : Math.max(0, suivisSuffixes.length - 1)
    if (!write) return
    await t`UPDATE stock_fini SET lot = ${base} WHERE idstock_fini = ANY(${ids})`
    if (suiviBase) {
      for (const s of suivisSuffixes) await t`DELETE FROM suivilot WHERE idsuivilot = ${Number(s.idsuivilot)}`
    } else if (suivisSuffixes.length) {
      // Keep the first (it carries the controls), rename it; any other duplicate goes into the reprise.
      const [garde, ...autres] = suivisSuffixes
      await t`UPDATE suivilot SET lot = ${base} WHERE idsuivilot = ${Number(garde.idsuivilot)}`
      for (const s of autres) await t`DELETE FROM suivilot WHERE idsuivilot = ${Number(s.idsuivilot)}`
    }
  }
  await run(t)
})() }
if (essai) {
  await sql.begin(async (t) => {
    await tout(t as unknown as Sql)
    const [n] = await (t as unknown as Sql)`SELECT count(*)::int AS r, (SELECT count(*)::int FROM reprise_piece) AS p FROM reprise WHERE origine = 'historique'`
    console.log('essai — dans la transaction :', n)
    throw ESSAI
  }).catch((e) => { if (e !== ESSAI) throw e })
} else if (write) await sql.begin(async (t) => tout(t as unknown as Sql))
else await tout(sql)

const enReprise = await sql<{ id: number; ligne: number; lot: string; cmd: number; soldee: number }[]>`
  SELECT sf.idstock_fini AS id, sf.idref_commande_source AS ligne, trim(sf.lot::text) AS lot,
         c.idcommande_sous_traitant AS cmd, c.est_soldee AS soldee
  FROM stock_fini sf
  LEFT JOIN ligne_commande_sous_traitant l ON l.idligne_commande_sous_traitant = sf.idref_commande_source
  LEFT JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
  WHERE sf.idetat_stock_fini = 2
    ${table ? sql`AND NOT EXISTS (SELECT 1 FROM reprise_piece rp JOIN reprise r ON r.id = rp.idreprise
                    WHERE rp.idstock_fini = sf.idstock_fini AND r.statut = 'ouverte')` : sql``}`
for (const r of enReprise) aRevoir.push({ lot: r.lot, ligne: Number(r.ligne), rouleaux: 1, raison: `rouleau ${r.id} « En reprise » sans reprise ouverte (cde ${r.cmd}${Number(r.soldee) ? ', soldée' : ''})` })

console.log(`\n${essai ? 'ESSAI (annulé)' : write ? 'ÉCRIT' : 'DRY RUN'} (${env}) — ${cibles.size} lots repris, ${reprises} reprises, ${rouleaux} rouleaux renommés, suivilot: ${renommes} renommés / ${fusionnes} fusionnés`)
if (process.argv.includes('--plan')) console.table(plan)
console.log(`\nÀ revoir (${aRevoir.length}) — non touchés :`)
console.table(aRevoir.sort((a, b) => a.raison.localeCompare(b.raison) || a.lot.localeCompare(b.lot)))
await closeMpsPg()
