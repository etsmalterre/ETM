// Probe: shape the data behind the legacy "Rapport › Commandes de fils"
// screen (FI_Rapport_fil.wdw). One row per ref_fil_commande line.
import 'dotenv/config'
import { query } from '../lib/hfsql-auto.js'

async function main() {
  console.log('===== commande_fil columns =====')
  const cf = await query<any>('SELECT TOP 1 * FROM commande_fil')
  console.log(Object.keys(cf[0] ?? {}).join(', '))

  console.log('\n===== ref_fil_commande columns =====')
  const rfc = await query<any>('SELECT TOP 1 * FROM ref_fil_commande')
  console.log(Object.keys(rfc[0] ?? {}).join(', '))

  console.log('\n===== fournisseur columns =====')
  const f = await query<any>('SELECT TOP 1 * FROM fournisseur')
  console.log(Object.keys(f[0] ?? {}).join(', '))

  console.log('\n===== colori_fil columns =====')
  const cfl = await query<any>('SELECT TOP 1 * FROM colori_fil')
  console.log(Object.keys(cfl[0] ?? {}).join(', '))

  console.log('\n===== screenshot rows (commandes 650,669,671,672,580,651) =====')
  const rows = await query<any>(
    `SELECT rfc.IDref_fil_commande AS lid, rfc.IDcommande_fil AS cid, rfc.IDref_fil,
            rfc.IDcolori_fil, rfc.quantite, rfc.unite, rfc.prix_unitaire,
            rfc.date_livraison, rfc.etat, rfc.date_notif
       FROM ref_fil_commande rfc
      WHERE rfc.IDcommande_fil IN (650,669,671,672,580,651)
      ORDER BY rfc.IDcommande_fil, rfc.IDref_fil_commande`,
  )
  for (const r of rows) {
    const c = await query<any>(
      `SELECT IDfournisseur, etat, date_commande FROM commande_fil WHERE IDcommande_fil = ${Number(r.cid)}`,
    )
    const frs = c.length
      ? await query<any>(`SELECT nom FROM fournisseur WHERE IDfournisseur = ${Number(c[0].IDfournisseur)}`)
      : []
    const ref = await query<any>(`SELECT reference FROM ref_fil WHERE IDref_fil = ${Number(r.IDref_fil)}`)
    const col = await query<any>(`SELECT reference FROM colori_fil WHERE IDcolori_fil = ${Number(r.IDcolori_fil)}`)
    const recv = await query<any>(
      `SELECT COUNT(*) AS nb, SUM(stock_initial) AS kg_init, SUM(stock) AS kg_rest
         FROM stock_fil WHERE IDref_fil_commande = ${Number(r.lid)}`,
    )
    console.log(
      `cmd ${r.cid} (etat ${c[0]?.etat}, ${c[0]?.date_commande}, ${frs[0]?.nom}) line ${r.lid}: ` +
        `ref=${ref[0]?.reference} col=${col[0]?.reference} q=${r.quantite} unite=${r.unite} ` +
        `pu=${r.prix_unitaire} dl=${r.date_livraison} notif=${r.date_notif} etat=${r.etat} | ` +
        `recu ${recv[0]?.nb} lots init=${recv[0]?.kg_init ?? 0} rest=${recv[0]?.kg_rest ?? 0}`,
    )
  }

  console.log('\n===== volume: open lines vs all =====')
  const tot = await query<any>('SELECT COUNT(*) AS nb FROM ref_fil_commande')
  const open = await query<any>('SELECT COUNT(*) AS nb FROM ref_fil_commande WHERE etat = 0')
  const cmdTot = await query<any>('SELECT COUNT(*) AS nb FROM commande_fil')
  const cmdOpen = await query<any>('SELECT COUNT(*) AS nb FROM commande_fil WHERE etat = 0')
  console.log(`lignes: ${tot[0]?.nb} total / ${open[0]?.nb} etat=0`)
  console.log(`commandes: ${cmdTot[0]?.nb} total / ${cmdOpen[0]?.nb} etat=0`)

  console.log('\n===== unite distribution =====')
  const u = await query<any>('SELECT unite, COUNT(*) AS nb FROM ref_fil_commande GROUP BY unite')
  console.log(u)

  console.log('\n===== date_notif populated? =====')
  const dn = await query<any>(
    `SELECT COUNT(*) AS nb FROM ref_fil_commande WHERE date_notif IS NOT NULL AND date_notif <> ''`,
  )
  console.log(dn)

  console.log('\n===== unite table? =====')
  try {
    const ut = await query<any>('SELECT TOP 10 * FROM unite')
    console.log(ut)
  } catch (e) {
    console.log('no `unite` table:', (e as Error).message)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
