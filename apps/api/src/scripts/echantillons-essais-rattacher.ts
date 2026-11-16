// One-off for LIVA #1370: tie the hand-typed « ech NN » references to their
// samples, now that a sample creates its provisional reference itself
// (lib/echantillons.ts, migration 0079).
//
//   npx tsx src/scripts/echantillons-essais-rattacher.ts [--env production] [--write] [--figer 55]
//
// Dry run by default (read-only transaction). For every ref_ecru named
// « ech NN » / « echNN » (people typed them in Tombé Métier › Références to be
// able to knit a sample):
//   • sample NN still en cours, not linked → the reference becomes its
//     industrial trial: renamed « E0NN », flagged essai, linked. Its finis
//     named after it follow (« ech 44A » → « E044A ») when the name is free.
//   • sample NN already retained on another reference (E055 → 104) → the twin
//     is a leftover: archived, with its finis, when it holds no roll in stock.
//     Left alone and listed otherwise.
//   • no such sample, or sample archived → listed, nothing done.
//
// --figer NN[,NN]: write the linked reference's CURRENT sheet (contexture,
// jauge, Ø, LFA, TBM, composition) back onto a retained sample — the snapshot
// « Retenu » now takes. For E055, whose fiche kept the first recipe (PA
// 78/68/2) while reference 104 was corrected. Never automatic: on an old
// passage the reference may have evolved for years.
import { config } from 'dotenv'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const env = arg('env') ?? 'development'
const write = process.argv.includes('--write')
const figer = (arg('figer') ?? '').split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0)
config({ path: env === 'production' ? resolve(process.cwd(), '../../../ETM/apps/api/.env.production') : resolve(process.cwd(), '.env.development') })
if (!write) process.env.PGOPTIONS = '-c default_transaction_read_only=on'

const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const {
  numeroEchantillon, nomFiniRetenu, statutEchantillon, lfaNombre, ordinalValide, pourcentVersFraction,
  JAUGE_ORD_MAX, DIAMETRE_ORD_MAX,
} = await import('../lib/echantillons.js')
const { referenceKey } = await import('../lib/ref-fini-reference.js')
const sql = mpsPg()

console.log(`${env} — ${write ? 'ÉCRITURE' : 'essai à blanc (--write pour appliquer)'}\n`)

const jumelles = (await sql<{ idref_ecru: number; reference: string | null; archive: number | null; essai: number | null }[]>`
  SELECT idref_ecru, reference, archive, essai FROM ref_ecru WHERE reference ~* '^ech ?0*[0-9]+$' ORDER BY idref_ecru`)
  .map((r) => ({ ...r, nom: String(r.reference ?? '').trim(), n: Number(/(\d+)$/.exec(String(r.reference ?? '').trim())![1]) }))

if (jumelles.length === 0) console.log('Aucune référence « ech NN ».')

await sql.begin(async (t) => {
  const tx = t as unknown as Sql
  const nomsFini = new Set((await tx<{ reference: string | null }[]>`SELECT reference FROM ref_fini`).map((r) => referenceKey(String(r.reference ?? ''))))

  for (const j of jumelles) {
    const [e] = await tx<{ idref_echantillon: number; archive: number | null; idref_ecru: number | null }[]>`
      SELECT idref_echantillon, archive, idref_ecru FROM ref_echantillon WHERE idref_echantillon = ${j.n}`
    const [{ n: rouleaux }] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM stock_ecru WHERE idref_ecru = ${j.idref_ecru}`
    const finis = await tx<{ idref_fini: number; reference: string | null }[]>`
      SELECT idref_fini, reference FROM ref_fini WHERE idref_ecru = ${j.idref_ecru} ORDER BY idref_fini`
    const tete = `« ${j.nom} » (réf. écru ${j.idref_ecru}, ${rouleaux} pièce(s), ${finis.length} fini(s))`

    if (!e) { console.log(`${tete} : pas d'échantillon ${numeroEchantillon(j.n)} — rien fait`); continue }
    let refEssai = 0
    if ((Number(e.idref_ecru) || 0) > 0) {
      const [r] = await tx<{ essai: number | null }[]>`SELECT essai FROM ref_ecru WHERE idref_ecru = ${Number(e.idref_ecru)}`
      refEssai = Number(r?.essai) || 0
    }
    const statut = statutEchantillon({ archive: e.archive, idref_ecru: e.idref_ecru, ref_essai: refEssai })
    const numero = numeroEchantillon(j.n)

    if (statut === 'en_cours') {
      const [pris] = await tx`SELECT 1 FROM ref_ecru WHERE TRIM(reference) = ${numero} AND idref_ecru <> ${j.idref_ecru} LIMIT 1`
      if (pris) { console.log(`${tete} : la référence ${numero} existe déjà — rien fait`); continue }
      console.log(`${tete} → essai industriel de ${numero} : renommée ${numero}, liée`)
      if (write) {
        await tx`UPDATE ref_ecru SET reference = ${numero}, essai = 1 WHERE idref_ecru = ${j.idref_ecru}`
        await tx`UPDATE ref_echantillon SET idref_ecru = ${j.idref_ecru} WHERE idref_echantillon = ${j.n}`
      }
      for (const f of finis) {
        const ancien = String(f.reference ?? '').trim()
        const nouveau = nomFiniRetenu(j.nom, numero, ancien)
        if (!nouveau) { console.log(`    fini « ${ancien} » : garde son nom`); continue }
        if (nomsFini.has(referenceKey(nouveau))) { console.log(`    fini « ${ancien} » : ${nouveau} existe déjà — garde son nom`); continue }
        console.log(`    fini « ${ancien} » → ${nouveau}`)
        nomsFini.add(referenceKey(nouveau))
        if (write) await tx`UPDATE ref_fini SET reference = ${nouveau} WHERE idref_fini = ${f.idref_fini}`
      }
      continue
    }

    if (statut === 'reference' && Number(e.idref_ecru) !== j.idref_ecru) {
      const [autre] = await tx<{ reference: string | null }[]>`SELECT reference FROM ref_ecru WHERE idref_ecru = ${Number(e.idref_ecru)}`
      const devenu = String(autre?.reference ?? '').trim()
      if (rouleaux > 0) { console.log(`${tete} : ${numero} est devenu ${devenu}, mais il lui reste des pièces — à traiter à la main`); continue }
      if (Number(j.archive)) { console.log(`${tete} : ${numero} est devenu ${devenu}, déjà archivée`); continue }
      const [{ n: finisEnStock }] = await tx<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM stock_fini WHERE idref_fini = ANY(${finis.map((f) => f.idref_fini)})`
      console.log(`${tete} : ${numero} est devenu ${devenu} → jumelle archivée${finisEnStock === 0 && finis.length > 0 ? ' avec ses finis' : ''}`)
      if (write) {
        await tx`UPDATE ref_ecru SET archive = 1 WHERE idref_ecru = ${j.idref_ecru}`
        if (finisEnStock === 0) for (const f of finis) await tx`UPDATE ref_fini SET archive = 1 WHERE idref_fini = ${f.idref_fini}`
      }
      if (finisEnStock > 0) console.log(`    ses finis gardent ${finisEnStock} rouleau(x) : non archivés`)
      continue
    }

    console.log(`${tete} : échantillon ${numero} ${statut === 'archive' ? 'archivé' : statut === 'essai' ? 'déjà à l\'essai' : 'déjà lié'} — rien fait`)
  }

  for (const id of figer) {
    const [e] = await tx<{ idref_echantillon: number; archive: number | null; idref_ecru: number | null }[]>`
      SELECT idref_echantillon, archive, idref_ecru FROM ref_echantillon WHERE idref_echantillon = ${id}`
    const idRef = Number(e?.idref_ecru) || 0
    if (!e || !(idRef > 0)) { console.log(`\n--figer ${id} : échantillon non lié à une référence — rien fait`); continue }
    const [r] = await tx<{
      reference: string | null; essai: number | null; idcontexture: number | null; jauge: number | null; diametre: number | null
      lfa_tour_1: string | null; lfa_tour_2: string | null; lfa_tour_3: string | null; lfa_tour_4: string | null
      laize_tbm: number | null; poids_m2_tbm: number | null
    }[]>`
      SELECT reference, essai, idcontexture, jauge, diametre, lfa_tour_1, lfa_tour_2, lfa_tour_3, lfa_tour_4, laize_tbm, poids_m2_tbm
        FROM ref_ecru WHERE idref_ecru = ${idRef}`
    if (!r || Number(r.essai)) { console.log(`\n--figer ${id} : la référence est un essai en cours, sa fiche est déjà lue en direct — rien fait`); continue }
    const compo = await tx<{ idref_fil: number; idcolori_fil: number; pourcentage: number | null }[]>`
      SELECT idref_fil, idcolori_fil, pourcentage FROM composition_ecru
       WHERE idref_ecru = ${idRef} AND (idcolori_ecru = 0 OR idcolori_ecru IS NULL) ORDER BY idcomposition_ecru`
    console.log(`\n--figer ${id} : ${numeroEchantillon(id)} reprend la fiche de la référence ${String(r.reference ?? '').trim()} (${compo.map((c) => `${c.pourcentage} % fil ${c.idref_fil}`).join(', ') || 'sans composition'})`)
    if (write) {
      await tx`
        UPDATE ref_echantillon SET
          idcontexture = ${Number(r.idcontexture) || 0},
          jauge = ${ordinalValide(r.jauge, JAUGE_ORD_MAX)}, diametre = ${ordinalValide(r.diametre, DIAMETRE_ORD_MAX)},
          lfa1 = ${lfaNombre(r.lfa_tour_1)}, lfa2 = ${lfaNombre(r.lfa_tour_2)}, lfa3 = ${lfaNombre(r.lfa_tour_3)}, lfa4 = ${lfaNombre(r.lfa_tour_4)},
          laize_tbm = ${Number(r.laize_tbm) || 0}, poids_m2_tbm = ${Number(r.poids_m2_tbm) || 0}
        WHERE idref_echantillon = ${id}`
      await tx`DELETE FROM fil_ref_echantillon WHERE idref_echantillon = ${id}`
      for (const c of compo) {
        await tx`
          INSERT INTO fil_ref_echantillon (idref_echantillon, idref_fil, idcolori_fil, pourcentage)
          VALUES (${id}, ${Number(c.idref_fil) || 0}, ${Number(c.idcolori_fil) || 0}, ${pourcentVersFraction(Number(c.pourcentage) || 0)})`
      }
    }
  }
})

await closeMpsPg()
