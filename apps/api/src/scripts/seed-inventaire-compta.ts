/**
 * Amorce la série `inventaire_compta` avec l'arrêté du 31/12/2025.
 *
 *   NODE_ENV=production node --import tsx src/scripts/seed-inventaire-compta.ts          (à blanc)
 *   NODE_ENV=production node --import tsx src/scripts/seed-inventaire-compta.ts --write  (écrit)
 *   NODE_ENV=production node --import tsx src/scripts/seed-inventaire-compta.ts --revert (annule)
 *
 * POURQUOI
 *
 * La série s'est arrêtée le 28/06/2025. Sans deux photos prises par la même
 * méthode, la production stockée n'est pas calculable — et c'est elle qui
 * explique un EBE intermédiaire amputé par le stockage. L'arrêté du 28/12/2024
 * est DÉJÀ en base et vaut exactement les inventaires imprimés de l'époque ; il
 * ne manque que celui du 31/12/2025, dont Vincent a fourni les quatre rapports.
 * Avec les deux, la variation 2026 devient une soustraction.
 *
 * D'OÙ VIENNENT LES CHIFFRES
 *
 * Des quatre inventaires légataires au 31/12/2025 (`ETAT_InventaireFil` /
 * `ETAT_InventaireTM` / `ETAT_InventaireFini`), c'est-à-dire de la méthode de
 * l'expert-comptable, pas d'un calcul de l'app. Contrôle : leur total
 * (brut 581 921 / net 312 793) plus le stock hors ERP (escrime, 57 600 / 13 935)
 * donne 639 521 / 326 728 — les chiffres exacts du bilan 2025.
 *
 * ⚠️ UNE DÉVIATION ASSUMÉE : L'UNITÉ DU TYPE 4
 *
 * La routine WinDev stockait le type 4 (Fini) en **métrage** (`unite = 3` ;
 * 65 230,5 Ml pour 25 613 kg au 28/12/2024). Le rapport imprimé ne donne que des
 * kilos, et la reconstitution du métrage depuis les numéros de pièce échoue son
 * propre test de contrôle (17 570 kg retrouvés sur 21 039, 113 numéros
 * introuvables). Le métrage du 31/12/2025 est donc **irrécupérable**.
 *
 * Cet arrêté enregistre donc les QUATRE types en **kilos** (`unite = 1`). C'est
 * cohérent à l'intérieur de l'arrêté, c'est la mesure que le rapport donne
 * réellement, et cela vaut mieux que fabriquer un métrage ou écrire un zéro qui
 * jetterait une information vraie. Un lecteur de la série doit savoir que le
 * type 4 change d'unité entre les lignes WinDev et celle-ci.
 *
 * HFSQL : pas de requête paramétrée, entiers interpolés, `DATE` est un mot
 * réservé (majuscules partout). Toutes les colonnes sont ASCII — pas de
 * réinsertion positionnelle nécessaire ici.
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

const { query, closeConnection } = await import('../lib/hfsql-auto.js')

const DATE_ARRETE = '20251231'
const WRITE = process.argv.includes('--write')
const REVERT = process.argv.includes('--revert')

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const e = (v: number) => Math.round(v).toLocaleString('fr-FR')

/** Les quatre inventaires imprimés au 31/12/2025. `quantite` en kg — voir la
 *  note d'unité en tête de fichier. */
const ARRETE = [
  { type: 1, label: 'Fil', quantite: 29418, prix_achat: 182976, valeur_deprecie: 102648 },
  { type: 2, label: 'TM disponible', quantite: 11454, prix_achat: 68588, valeur_deprecie: 38093 },
  { type: 3, label: 'TM en ennoblissement', quantite: 6388, prix_achat: 46831, valeur_deprecie: 46497 },
  { type: 4, label: 'Fini', quantite: 21039, prix_achat: 283526, valeur_deprecie: 125555 },
] as const

/** Contrôles de cohérence avec le bilan 2025, vérifiés avant toute écriture. */
const ATTENDU = { brut: 581921, net: 312793, bilanBrut: 639521, bilanNet: 326728, escrimeBrut: 57600, escrimeNet: 13935 }

async function existants(): Promise<Record<string, unknown>[]> {
  return query<Record<string, unknown>>(
    `SELECT IDinventaire_compta, IDtype_stock, prix_achat, valeur_deprecie, quantite, unite
     FROM inventaire_compta WHERE DATE = '${DATE_ARRETE}'`,
  )
}

async function main() {
  const brut = ARRETE.reduce((t, r) => t + r.prix_achat, 0)
  const net = ARRETE.reduce((t, r) => t + r.valeur_deprecie, 0)

  console.log(`Arrêté à amorcer : ${DATE_ARRETE}\n`)
  for (const r of ARRETE) {
    console.log(`  type ${r.type}  ${r.label.padEnd(22)} ${e(r.quantite).padStart(7)} kg` +
      `  brut ${e(r.prix_achat).padStart(8)}  net ${e(r.valeur_deprecie).padStart(8)}`)
  }
  console.log(`  ${''.padEnd(30)} ${''.padStart(7)}     brut ${e(brut).padStart(8)}  net ${e(net).padStart(8)}`)

  // Garde-fou : ne rien écrire si les totaux ne sont pas ceux attendus.
  if (brut !== ATTENDU.brut || net !== ATTENDU.net) {
    console.log(`\n✗ totaux inattendus (brut ${e(brut)}/${e(ATTENDU.brut)}, net ${e(net)}/${e(ATTENDU.net)}) — rien n'est écrit`)
    process.exitCode = 1
    return
  }
  console.log(`\n  + escrime hors ERP ${e(ATTENDU.escrimeBrut)} / ${e(ATTENDU.escrimeNet)}` +
    `  =  ${e(brut + ATTENDU.escrimeBrut)} / ${e(net + ATTENDU.escrimeNet)}` +
    `   ✓ bilan 2025 : ${e(ATTENDU.bilanBrut)} / ${e(ATTENDU.bilanNet)}`)

  const deja = await existants()

  if (REVERT) {
    if (deja.length === 0) { console.log('\nRien à annuler.'); return }
    const ids = deja.map((r) => n(r.IDinventaire_compta))
    console.log(`\nSuppression des ${ids.length} lignes du ${DATE_ARRETE} (PK ${ids.join(', ')})…`)
    await query(`DELETE FROM inventaire_compta WHERE DATE = '${DATE_ARRETE}'`)
    console.log(`Reste ${(await existants()).length} ligne(s).`)
    return
  }

  if (deja.length > 0) {
    console.log(`\n⚠ ${deja.length} ligne(s) existent déjà au ${DATE_ARRETE} — rien n'est écrit (idempotent).`)
    for (const r of deja) {
      console.log(`   PK ${n(r.IDinventaire_compta)}  type ${n(r.IDtype_stock)}` +
        `  brut ${e(n(r.prix_achat))}  net ${e(n(r.valeur_deprecie))}`)
    }
    console.log(`   Pour réécrire : --revert puis --write.`)
    return
  }

  if (!WRITE) {
    console.log(`\n(à blanc) 4 lignes seraient insérées. Relancer avec --write pour écrire.`)
    return
  }

  // PK calculée : la table n'a pas d'auto-incrément.
  const maxRows = await query<Record<string, unknown>>(`SELECT IDinventaire_compta FROM inventaire_compta`)
  let pk = maxRows.reduce((m, r) => Math.max(m, n(r.IDinventaire_compta)), 0)
  if (!Number.isInteger(pk) || pk <= 0) {
    console.log('\n✗ PK max illisible — rien n\'est écrit'); process.exitCode = 1; return
  }
  console.log(`\nPK max actuelle ${pk} — insertion de ${ARRETE.length} lignes…`)

  const ecrites: number[] = []
  for (const r of ARRETE) {
    pk += 1
    await query(
      `INSERT INTO inventaire_compta (IDinventaire_compta, IDtype_stock, DATE, prix_achat, valeur_deprecie, quantite, unite)
       VALUES (${pk}, ${r.type}, '${DATE_ARRETE}', ${r.prix_achat}, ${r.valeur_deprecie}, ${r.quantite}, 1)`,
    )
    ecrites.push(pk)
  }

  const apres = await existants()
  console.log(`\nRelecture : ${apres.length} ligne(s) au ${DATE_ARRETE}`)
  let ok = apres.length === ARRETE.length
  for (const r of apres.sort((a, b) => n(a.IDtype_stock) - n(b.IDtype_stock))) {
    const attendu = ARRETE.find((x) => x.type === n(r.IDtype_stock))
    const bon = !!attendu &&
      Math.abs(n(r.prix_achat) - attendu.prix_achat) < 0.5 &&
      Math.abs(n(r.valeur_deprecie) - attendu.valeur_deprecie) < 0.5
    if (!bon) ok = false
    console.log(`   ${bon ? '✓' : '✗'} PK ${n(r.IDinventaire_compta)}  type ${n(r.IDtype_stock)}` +
      `  brut ${e(n(r.prix_achat))}  net ${e(n(r.valeur_deprecie))}  qte ${e(n(r.quantite))}  unite ${n(r.unite)}`)
  }
  console.log(ok ? `\n✓ Série amorcée. Annulation : --revert (PK ${ecrites.join(', ')})`
                 : `\n✗ Relecture incohérente — vérifier, annulation possible avec --revert`)
  if (!ok) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 1 }).finally(() => closeConnection())
