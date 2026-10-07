// Seeds the TRM « Fournitures » from Nicolas's Google sheet « Stock aiguille »,
// tab « mise a jour du parc » (export of 2026-10-07) — LIVA #1263.
// Dry run by default.
//
//   npx tsx src/scripts/seed-fournitures-trm.ts            # what would be written
//   npx tsx src/scripts/seed-fournitures-trm.ts --write    # write it
//
// What it writes (type Aiguille unless said otherwise):
//  - the 55 needle references, each on the métiers of its block, in the
//    block's order;
//  - the position: in a block with two needle lengths the SHORTER is the
//    plateau and the longer the cylindre (1A: 65.41 plateau, 83.41 cylindre);
//    a block with one length is all cylindre — a rule, for Nicolas to check;
//  - the constructeurs of column N (1A only): accepted + mounted on 1A;
//  - the stock as movements: one entry per year of the order columns
//    (2019–2025 dated 31/12 of the year, « total de l'année » — the sheet has
//    no finer date; the two 2026 columns at their own dates), then an opening
//    count dated 07/10/2026 that brings the stock to the sheet's « Quantité ».
//    No « Quantité » (Rectiligne, platines) = stock set to 0, « à recompter »;
//  - the « platines » line (SNK 41.20 G12) as type Platine, on no métier.
// Not written: montage dates (the sheet has none), quantities per montage
// (Nicolas types them).
//
// Idempotent: an existing article, link or constructeur is left alone, and the
// stock of an article is seeded only while it has no movement at all.
import '../load-env.js'
import { mpsPg } from '../lib/mps-pg.js'
import { normaliserLibelle } from '../lib/fournitures-trm.js'

/** reference → [Quantité (null = empty cell), orders per column]. */
const STOCK: [string, number | null, Record<string, number>][] = [
  ['Vota 65.41 G004', 300, { '2019': 250, '2020': 500, '2021': 500, '2022': 1000, '2024': 250, '2025': 500 }],
  ['Vo LS 83.41 G003', 250, { '2019': 500, '2020': 500, '2021': 500, '2022': 750, '2023': 250, '2024': 250, '2025': 250 }],
  ['Vota LS 83.41 G003', 250, { '2019': 250, '2020': 750, '2021': 250, '2022': 750, '2023': 250, '2024': 250, '2025': 250 }],
  ['Vo LS 65.41 G007', 250, { '2019': 250, '2020': 750, '2021': 250, '2022': 1000, '2024': 250, '2025': 500 }],
  ['Vota 65.41 N004', 250, { '2025': 1500 }],
  ['Vo LS 83.41 N003', 250, { '2025': 1500 }],
  ['Vota LS 83.41 N003', 250, { '2025': 1500 }],
  ['Vo 65.41 N007', 250, { '2025': 1500 }],
  ['Vota 83.48 G07', 250, {}],
  ['Vo 83.48 G07', 250, {}],
  ['Vota 65.48 G09', 250, {}],
  ['Vo 65.48 G020', 250, {}],
  ['Vo 83.48 G010', 150, { '2019': 250, '2020': 500, '2022': 1000, '2023': 250, '2025': 250 }],
  ['Vota 83.48 G010', 0, { '2019': 250, '2020': 500, '2022': 1250, '2026-03-20': 250 }],
  ['Vo 65.48 G011', 150, { '2020': 250, '2022': 1250, '2025': 250 }],
  ['Vota 65.48 G011', 150, { '2020': 250, '2022': 1250, '2025': 250 }],
  ['Vo LS 157.52 G001', 100, { '2020': 250, '2023': 250 }],
  ['Vo LS 157.52 G002', 350, { '2020': 250, '2022': 250 }],
  ['Vo LS 157.52 G003', 150, { '2020': 500, '2023': 250 }],
  ['Vo 109.50 G03', 50, {}],
  ['Vo 109.50 G04', 50, {}],
  ['Vo 65.50 G02', 250, { '2025': 250 }],
  ['Vota 65.50 G02', 50, {}],
  ['Vo 109.62 G03', 100, {}],
  ['Vo 109.62 G04', 100, {}],
  ['Vo 64.62 G02', 100, {}],
  ['Vota 64.62 G02', 500, { '2025': 500 }],
  ['Vo LS 93.41 G003', 200, { '2019': 250, '2020': 500, '2022': 1000, '2024': 250, '2026-03-20': 250 }],
  ['Vo LS 93.41 G004', 0, { '2019': 500, '2020': 500, '2022': 1000, '2024': 250, '2025': 250 }],
  ['Vo 109.36 G015', 100, { '2023': 250, '2024': 250 }],
  ['Vo 109.36 G016', 50, { '2023': 250, '2024': 250 }],
  ['Vo 65.36 G011', 250, { '2023': 500, '2024': 250, '2025': 250 }],
  ['Vota 65.36 G02', 300, { '2023': 500, '2024': 250, '2026-03-20': 250 }],
  ['Vota 61.58 G03', 250, { '2021': 250, '2024': 250 }],
  ['Vo 81.58 G03', 150, { '2019': 250, '2023': 250 }],
  ['Vo LS 130.52 G005', 250, { '2021': 250, '2022': 1000, '2026-04-05': 250 }],
  ['Vo LS 130.52 G006', 50, { '2021': 250, '2022': 1000, '2026-04-05': 250 }],
  ['Vo LS 130.52 G007', 350, { '2021': 250, '2022': 500, '2026-04-05': 250 }],
  ['Vo 130.52 S001', 100, { '2023': 1000 }],
  ['Vo 130.52 S002', 150, { '2023': 1000 }],
  ['Vo 126.52 S001', 950, { '2023': 500 }],
  ['Vo 126.52 S002', 350, { '2019': 250, '2020': 250, '2023': 500 }],
  ['Vo LS 92.41 G003', 150, { '2019': 250, '2023': 500 }],
  ['Vo LS 92.41 G004', 150, { '2023': 250 }],
  ['Vo 89.41 G0039', 0, { '2020': 250, '2021': 500, '2022': 1750, '2024': 250, '2025': 1000, '2026-03-20': 250, '2026-04-05': 250 }],
  ['Vo 89.41 G0018', 0, { '2019': 250, '2020': 500, '2021': 750, '2022': 1750, '2024': 250, '2025': 1000, '2026-03-20': 250, '2026-04-05': 250 }],
  ['Vo 93.41 S004', 200, { '2023': 500 }],
  ['Vo 93.41 S003', 200, {}],
  ['Vo LS 141.52 G005', 0, {}],
  ['Vo LS 141.52 G006', 0, {}],
  ['Vo LS 141.52 G007', 0, {}],
  ['Vo LS 141.52 G008', 0, {}],
  ['SAN SF126.52 G001', 150, { '2021': 1000, '2024': 1250, '2025': 1000 }],
  ['SAN SF126.52 G002', 250, { '2021': 500, '2024': 1250, '2025': 1000 }],
  ['Vo spec 79.85 G06', null, { '2022': 250, '2023': 250 }],
  // Type Platine (the sheet's last line).
  ['SNK 41.20 G12', null, { '2021': 8000, '2023': 1500 }],
]

interface Ligne {
  reference: string
  constructeur?: string
  note?: string
}
interface Bloc {
  type: 'Aiguille' | 'Platine'
  metiers: string[]
  lignes: Ligne[]
  /** Fixed position for every line (else the length rule). */
  sansPosition?: true
}

const VOLS = 'Attention, les VoLS sont remplacées par SAN SF'

const PARC: Bloc[] = [
  {
    type: 'Aiguille',
    metiers: ['1A'],
    lignes: [
      { reference: 'Vota 65.41 G004' },
      { reference: 'Vo LS 83.41 G003', constructeur: 'Samsung' },
      { reference: 'Vota LS 83.41 G003', constructeur: 'Groz' },
      { reference: 'Vo LS 65.41 G007', constructeur: 'Neetex' },
    ],
  },
  {
    type: 'Aiguille',
    metiers: ['1C'],
    lignes: [
      { reference: 'Vota 65.41 N004' },
      { reference: 'Vo LS 83.41 N003' },
      { reference: 'Vota LS 83.41 N003' },
      { reference: 'Vo 65.41 N007' },
    ],
  },
  {
    type: 'Aiguille',
    metiers: ['1E'],
    lignes: [
      { reference: 'Vota 83.48 G07' },
      { reference: 'Vo 83.48 G07' },
      { reference: 'Vota 65.48 G09' },
      { reference: 'Vo 65.48 G020' },
    ],
  },
  {
    type: 'Aiguille',
    metiers: ['2A', '2B', '2C', '2D', '2H'],
    lignes: [
      { reference: 'Vo 83.48 G010' },
      { reference: 'Vota 83.48 G010' },
      { reference: 'Vo 65.48 G011' },
      { reference: 'Vota 65.48 G011' },
    ],
  },
  {
    type: 'Aiguille',
    metiers: ['1H'],
    lignes: [{ reference: 'Vo LS 157.52 G001' }, { reference: 'Vo LS 157.52 G002' }, { reference: 'Vo LS 157.52 G003' }],
  },
  {
    type: 'Aiguille',
    metiers: ['2I'],
    lignes: [
      { reference: 'Vo 109.50 G03' },
      { reference: 'Vo 109.50 G04' },
      { reference: 'Vo 65.50 G02' },
      { reference: 'Vota 65.50 G02' },
    ],
  },
  {
    type: 'Aiguille',
    metiers: ['2J'],
    lignes: [
      { reference: 'Vo 109.62 G03' },
      { reference: 'Vo 109.62 G04' },
      { reference: 'Vo 64.62 G02' },
      { reference: 'Vota 64.62 G02' },
    ],
  },
  {
    type: 'Aiguille',
    metiers: ['1D', '1J', '1I', '3D'],
    lignes: [
      { reference: 'Vo LS 93.41 G003', note: VOLS },
      { reference: 'Vo LS 93.41 G004', note: VOLS },
    ],
  },
  {
    type: 'Aiguille',
    metiers: ['2E'],
    lignes: [
      { reference: 'Vo 109.36 G015' },
      { reference: 'Vo 109.36 G016' },
      { reference: 'Vo 65.36 G011' },
      { reference: 'Vota 65.36 G02' },
    ],
  },
  { type: 'Aiguille', metiers: ['2F'], lignes: [{ reference: 'Vota 61.58 G03' }, { reference: 'Vo 81.58 G03' }] },
  {
    type: 'Aiguille',
    metiers: ['3J', '3K'],
    lignes: [
      { reference: 'Vo LS 130.52 G005', note: VOLS },
      { reference: 'Vo LS 130.52 G006', note: VOLS },
      { reference: 'Vo LS 130.52 G007', note: VOLS },
    ],
  },
  { type: 'Aiguille', metiers: ['1F'], lignes: [{ reference: 'Vo 130.52 S001' }, { reference: 'Vo 130.52 S002' }] },
  { type: 'Aiguille', metiers: ['3C'], lignes: [{ reference: 'Vo 126.52 S001' }, { reference: 'Vo 126.52 S002' }] },
  {
    type: 'Aiguille',
    metiers: ['2G', '3I'],
    lignes: [
      { reference: 'Vo LS 92.41 G003', note: VOLS },
      { reference: 'Vo LS 92.41 G004', note: VOLS },
    ],
  },
  {
    type: 'Aiguille',
    metiers: ['3H', '3E', '3A', '3B'],
    lignes: [{ reference: 'Vo 89.41 G0039' }, { reference: 'Vo 89.41 G0018' }],
  },
  {
    type: 'Aiguille',
    metiers: ['3G'],
    lignes: [
      { reference: 'Vo 93.41 S004', note: 'Passer en LS pour grouper avec 1D 1J 1I 3D' },
      { reference: 'Vo 93.41 S003', note: VOLS },
    ],
  },
  {
    type: 'Aiguille',
    metiers: ['1G'],
    lignes: [
      { reference: 'Vo LS 141.52 G005' },
      { reference: 'Vo LS 141.52 G006' },
      { reference: 'Vo LS 141.52 G007' },
      { reference: 'Vo LS 141.52 G008' },
    ],
  },
  { type: 'Aiguille', metiers: ['3F'], lignes: [{ reference: 'SAN SF126.52 G001' }, { reference: 'SAN SF126.52 G002' }] },
  { type: 'Aiguille', metiers: [], sansPosition: true, lignes: [{ reference: 'Vo spec 79.85 G06', note: 'Rectiligne' }] },
  { type: 'Platine', metiers: [], sansPosition: true, lignes: [{ reference: 'SNK 41.20 G12' }] },
]

/** « Vo LS 83.41 G003 » → 83.41 (the needle length). */
function longueur(reference: string): number | null {
  const m = reference.match(/(\d+)\.\d+/)
  return m ? Number(m[1]) : null
}

/** Shorter of two lengths = plateau; one length = cylindre. */
function positionDans(bloc: Bloc, reference: string): 'cylindre' | 'plateau' | null {
  if (bloc.sansPosition || bloc.type !== 'Aiguille') return null
  const longueurs = [...new Set(bloc.lignes.map((l) => longueur(l.reference)).filter((n): n is number => n !== null))]
  const l = longueur(reference)
  if (l === null) return null
  return longueurs.length > 1 && l === Math.min(...longueurs) ? 'plateau' : 'cylindre'
}

/** Column key → movement date: a year = its 31/12 (yearly total), else the date. */
const dateDe = (k: string) => (/^\d{4}$/.test(k) ? `${k}-12-31` : k)
const DATE_INVENTAIRE = '2026-10-07'

const write = process.argv.includes('--write')
const sql = mpsPg()

try {
  const stockDe = new Map(STOCK.map(([r, q, c]) => [normaliserLibelle(r).toLowerCase(), { quantite: q, commandes: c }]))
  const manquants = PARC.flatMap((b) => b.lignes).filter((l) => !stockDe.has(normaliserLibelle(l.reference).toLowerCase()))
  if (manquants.length) throw new Error(`Sans ligne de stock : ${manquants.map((l) => l.reference).join(', ')}`)

  const machines = await sql<{ idmachine: number; emplacement: string | null }[]>`
    SELECT idmachine, trim(emplacement::text) AS emplacement FROM machine WHERE COALESCE(archive, 0) <> 1`
  const parEmplacement = new Map(machines.filter((m) => m.emplacement).map((m) => [m.emplacement!, Number(m.idmachine)]))
  const inconnus = [...new Set(PARC.flatMap((b) => b.metiers))].filter((e) => !parEmplacement.has(e))
  if (inconnus.length) throw new Error(`Métiers absents de la base (ou archivés) : ${inconnus.join(', ')}`)

  const types = await sql<{ id: number; nom: string }[]>`SELECT idfourniture_type AS id, nom FROM trm_fourniture_type`
  const idType = new Map(types.map((t) => [t.nom, Number(t.id)]))

  const nbArticles = PARC.reduce((n, b) => n + b.lignes.length, 0)
  const nbLiens = PARC.reduce((n, b) => n + b.metiers.length * b.lignes.length, 0)
  console.log(`${nbArticles} articles, ${nbLiens} liens métier × référence.`)
  for (const b of PARC.filter((x) => x.type === 'Aiguille' && !x.sansPosition)) {
    console.log(
      `  ${b.metiers.join(' ').padEnd(16)} ${b.lignes.map((l) => `${l.reference} → ${positionDans(b, l.reference)}`).join(' | ')}`,
    )
  }

  if (!write) {
    console.log('Dry run — relancer avec --write pour écrire.')
  } else {
    let articles = 0
    let liens = 0
    let mouvements = 0
    await sql.begin(async (tx) => {
      const t = tx as unknown as typeof sql
      const idConstructeur = async (nom: string) => {
        await t`INSERT INTO trm_fourniture_constructeur (nom) VALUES (${nom}) ON CONFLICT DO NOTHING`
        const [c] = await t<{ id: number }[]>`
          SELECT idfourniture_constructeur AS id FROM trm_fourniture_constructeur WHERE lower(nom) = lower(${nom})`
        return Number(c.id)
      }
      for (const bloc of PARC) {
        const typeId = idType.get(bloc.type)
        if (!typeId) throw new Error(`Type ${bloc.type} absent (migration 0012 passée ?)`)
        for (const [i, l] of bloc.lignes.entries()) {
          const reference = normaliserLibelle(l.reference)
          const cree = await t`
            INSERT INTO trm_fourniture_article (idfourniture_type, reference, position, commentaire)
            VALUES (${typeId}, ${reference}, ${positionDans(bloc, reference)}, ${l.note ?? null})
            ON CONFLICT DO NOTHING`
          articles += cree.count
          const [a] = await t<{ id: number }[]>`
            SELECT idfourniture_article AS id FROM trm_fourniture_article
            WHERE idfourniture_type = ${typeId} AND lower(reference) = lower(${reference})`
          const articleId = Number(a.id)
          const cId = l.constructeur ? await idConstructeur(l.constructeur) : null
          if (cId !== null) {
            await t`
              INSERT INTO trm_fourniture_article_constructeur (idfourniture_article, idfourniture_constructeur)
              VALUES (${articleId}, ${cId}) ON CONFLICT DO NOTHING`
          }
          for (const emplacement of bloc.metiers) {
            const r = await t`
              INSERT INTO trm_fourniture_article_metier (idmachine, idfourniture_article, rang, idfourniture_constructeur)
              VALUES (${parEmplacement.get(emplacement)!}, ${articleId}, ${i + 1}, ${cId})
              ON CONFLICT DO NOTHING`
            liens += r.count
          }

          const [{ n }] = await t<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM trm_fourniture_mouvement WHERE idfourniture_article = ${articleId}`
          if (Number(n) > 0) continue
          const s = stockDe.get(reference.toLowerCase())!
          let total = 0
          for (const [k, q] of Object.entries(s.commandes).sort(([x], [y]) => dateDe(x).localeCompare(dateDe(y)))) {
            await t`
              INSERT INTO trm_fourniture_mouvement (idfourniture_article, type, quantite, date_mouvement, commentaire)
              VALUES (${articleId}, 'entree', ${q}, ${dateDe(k)},
                      ${/^\d{4}$/.test(k) ? `Reprise du sheet « Stock aiguille » — total commandé en ${k}` : 'Reprise du sheet « Stock aiguille »'})`
            total += q
            mouvements++
          }
          const compte = s.quantite ?? 0
          if (compte - total !== 0) {
            await t`
              INSERT INTO trm_fourniture_mouvement (idfourniture_article, type, quantite, date_mouvement, commentaire)
              VALUES (${articleId}, 'inventaire', ${compte - total}, ${DATE_INVENTAIRE},
                      ${s.quantite === null
                        ? 'Reprise du sheet : quantité absente, stock mis à 0 — à recompter'
                        : `Reprise du sheet « Stock aiguille » : stock ${compte}. Les montages des années passées n'étaient pas notés — cette ligne ramène le total au stock du sheet.`})`
            mouvements++
          }
        }
      }
    })
    console.log(`Écrit : ${articles} articles, ${liens} liens, ${mouvements} mouvements.`)
  }
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await sql.end()
}
