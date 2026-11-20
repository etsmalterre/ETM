/**
 * HTTP guard for « Livrer » des cols / bandes from Clients › Commandes (TRM)
 * — LIVA #1381, lib/livraison-rectiligne.ts.
 *
 *   API_BASE=http://localhost:808N/api pnpm exec tsx src/scripts/check-livrer-trm.ts
 *
 * Picks an open TRM order with at least two rectiligne lines (TYPE 4),
 * delivers a few pieces of two of them through POST /commandes-trm/:id/livrer,
 * and checks every reader of that count: the order detail (livré / reste /
 * nb livraisons), the list card, the Progression drawer's avis, the Clients ›
 * Expéditions detail and its PDF; then corrects a quantity and removes a line
 * through PUT /expeditions-trm/:id/lignes/:l/quantite, deletes the avis and
 * checks the order is back where it started.
 *
 * It CREATES an avis and deletes it again — the dev database is a stale
 * snapshot of prod, same scratch-write assumption as the other check scripts.
 * ⚠️ NEVER point it at the production API.
 */
import '../load-env.js'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'
import { SESSION_COOKIE_NAME } from '../lib/auth.js'
import { creerSession, hacherJeton, revoquerSession } from '../lib/sessions.js'

const API = process.env.API_BASE ?? 'http://localhost:8080/api'
if (/malterre\.com|trm\.malterre|10\.10\.2\./.test(API) || process.env.NODE_ENV === 'production') {
  console.error('Refusing to run against a production host.')
  process.exit(2)
}

// The API authenticates a session row (lib/sessions.ts): the script opens one
// for an active admin of the dev copy and revokes it when it is done.
let COOKIE = ''
let jetonSession = ''
async function ouvrirSessionAdmin(): Promise<void> {
  const [admin] = await mpsPg()<{ idutilisateur: number }[]>`
    SELECT idutilisateur FROM utilisateur WHERE est_admin AND actif AND type_compte = 'personne' ORDER BY idutilisateur LIMIT 1`
  if (!admin) throw new Error('No active admin account on this base.')
  jetonSession = await creerSession({ idutilisateur: Number(admin.idutilisateur), libelle: 'check-livrer-trm' })
  COOKIE = `${SESSION_COOKIE_NAME}=${jetonSession}`
}
async function fermer(): Promise<void> {
  if (jetonSession) await revoquerSession(hacherJeton(jetonSession)).catch(() => {})
  await closeMpsPg().catch(() => {})
  await closeConnection().catch(() => {})
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else { failures++; console.error(`  FAIL ${label}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`) }
}

async function api(path: string, init: RequestInit = {}, auth = true): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: COOKIE } : {}), ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

interface Pick { commande: number; recti: number[]; rouleau: number | null }

/** An open société-2 order with ≥ 2 rectiligne lines; a roll line of any open
 *  order is picked too, to prove it is refused. */
async function pick(): Promise<Pick | null> {
  const lines = await query<any>(`SELECT IDligne_commande_client, IDcommande_client, TYPE AS type_kind FROM ligne_commande_client WHERE TYPE = 4`)
  const parCommande = new Map<number, number[]>()
  for (const l of lines) {
    const c = Number(l.IDcommande_client) || 0
    parCommande.set(c, [...(parCommande.get(c) ?? []), Number(l.IDligne_commande_client)])
  }
  const candidates = [...parCommande.entries()].filter(([, ids]) => ids.length >= 2).map(([c]) => c)
  if (candidates.length === 0) return null
  const open = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM commande_client
     WHERE IDcommande_client IN (${candidates.join(',')}) AND IDsociete = 2 AND est_soldee = 0 ORDER BY IDcommande_client DESC`,
  )
  if (open.length === 0) return null
  const commande = Number(open[0].IDcommande_client)
  const autres = await query<any>(
    `SELECT IDligne_commande_client FROM ligne_commande_client WHERE IDcommande_client = ${commande} AND TYPE = 1`,
  )
  return { commande, recti: parCommande.get(commande)!.sort((a, b) => a - b), rouleau: autres.length > 0 ? Number(autres[0].IDligne_commande_client) : null }
}

async function main() {
  console.log(`API ${API}`)
  await ouvrirSessionAdmin()
  const p = await pick()
  if (!p) { console.error('No open TRM order with 2 rectiligne lines on this base — nothing to check.'); process.exit(1) }
  const [l1, l2] = p.recti
  console.log(`commande ${p.commande} · lignes rectilignes ${p.recti.join(', ')}`)
  const base = `/commandes-trm/${p.commande}`
  const ligne = (d: any, id: number) => (d?.lignes ?? []).find((l: any) => l.IDligne_commande_client === id)

  const avant = (await api(base)).json
  const a1 = ligne(avant, l1)
  const a2 = ligne(avant, l2)
  const listeAvant = ((await api(`/commandes-trm?status=all&q=${avant.numero}`)).json ?? []).find((c: any) => c.IDcommande_client === p.commande)
  const leAvant = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ligne_expedition WHERE IDligne_commande_client IN (${p.recti.join(',')})`)

  console.log('\n1. Guards')
  check('401 without a session', (await api(`${base}/livrer`, { method: 'POST', body: JSON.stringify({ lignes: [{ IDligne_commande_client: l1, quantite: 1 }] }) }, false)).status === 401)
  check('400 on an empty delivery', (await api(`${base}/livrer`, { method: 'POST', body: JSON.stringify({ lignes: [{ IDligne_commande_client: l1, quantite: 0 }] }) })).status === 400)
  check('404 on a line of another order', (await api(`${base}/livrer`, { method: 'POST', body: JSON.stringify({ lignes: [{ IDligne_commande_client: 999999999, quantite: 1 }] }) })).status === 404)
  if (p.rouleau) {
    const r = await api(`${base}/livrer`, { method: 'POST', body: JSON.stringify({ lignes: [{ IDligne_commande_client: p.rouleau, quantite: 1 }] }) })
    check('400 on a roll line (ligne_non_rectiligne)', r.status === 400 && r.json?.error === 'ligne_non_rectiligne', r.json)
  }
  const roul = await api(`${base}/lignes/${l1}/expedier`, { method: 'POST', body: JSON.stringify({ stockIds: [1] }) })
  check('the roll path still refuses a rectiligne line (409 ligne_rectiligne)', roul.status === 409 && roul.json?.error === 'ligne_rectiligne', roul.json)
  const leApresGardes = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ligne_expedition WHERE IDligne_commande_client IN (${p.recti.join(',')})`)
  check('no shipment line written by a refused call', Number(leApresGardes[0].n) === Number(leAvant[0].n))

  console.log('\n2. Livrer 3 + 5 pièces')
  const liv = await api(`${base}/livrer`, {
    method: 'POST',
    body: JSON.stringify({ lignes: [{ IDligne_commande_client: l2, quantite: 5 }, { IDligne_commande_client: l1, quantite: 3 }] }),
  })
  check('201 with the new avis', liv.status === 201 && liv.json?.IDexpedition > 0 && liv.json?.lignes === 2 && liv.json?.quantite === 8, liv.json)
  const exp = Number(liv.json?.IDexpedition) || 0
  if (exp <= 0) { console.error('No avis created — stopping.'); process.exit(1) }

  try {
    const apres = (await api(base)).json
    const b1 = ligne(apres, l1)
    const b2 = ligne(apres, l2)
    check('line 1: livré +3', b1.expedie === a1.expedie + 3 && b1.nb_livraisons === a1.nb_livraisons + 1, { avant: a1.expedie, apres: b1.expedie })
    check('line 1: reste = commandé − livré', b1.reste_a_livrer === Math.max(0, b1.quantite - b1.expedie), b1)
    check('line 2: livré +5', b2.expedie === a2.expedie + 5, { avant: a2.expedie, apres: b2.expedie })
    check('« livrée » only once everything left', b1.livree === (b1.quantite > 0 && b1.expedie >= b1.quantite))
    const listeApres = ((await api(`/commandes-trm?status=all&q=${avant.numero}`)).json ?? []).find((c: any) => c.IDcommande_client === p.commande)
    check('list card: pieces_livrees +8', listeApres?.pieces_livrees === (listeAvant?.pieces_livrees ?? 0) + 8, { avant: listeAvant?.pieces_livrees, apres: listeApres?.pieces_livrees })

    const tab = (await api(`${base}/expeditions`)).json
    const avis = (tab?.expeditions ?? []).find((e: any) => e.id === exp)
    check('drawer: the avis lists its two counted lines', avis?.quantites?.length === 2 && avis.quantite === 8, avis)
    check('drawer: counted lines are labelled from the rectiligne catalog', !!avis?.quantites?.[0]?.ref_label && /pièce|Kg/.test(avis?.quantites?.[0]?.libelle ?? ''), avis?.quantites?.[0])
    check('drawer: no roll on a counted avis', (avis?.rolls ?? []).length === 0)

    const det = (await api(`/expeditions-trm/${exp}`)).json
    const d1 = (det?.lignes ?? []).find((l: any) => l.IDligne_commande_client === l1)
    check('Expéditions detail: quantite_exp 3 on line 1', d1?.kind === 'rectiligne' && d1?.quantite_exp === 3 && d1?.quantite_livree === b1.expedie, d1)
    const liste = (await api(`/expeditions-trm?q=${exp}`)).json ?? []
    check('Expéditions list: total_quantite 8', liste.find((e: any) => e.id === exp)?.total_quantite === 8, liste.find((e: any) => e.id === exp))

    const pdf = await fetch(`${API}/expeditions-trm/${exp}/pdf`, { headers: { Cookie: COOKIE } })
    const head = Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString('latin1')
    check('avis PDF renders', pdf.status === 200 && head === '%PDF', { status: pdf.status, head })

    console.log('\n3. Corriger la quantité sur l’avis')
    const corr = await api(`/expeditions-trm/${exp}/lignes/${l1}/quantite`, { method: 'PUT', body: JSON.stringify({ quantite: 4 }) })
    check('PUT quantite 4', corr.status === 200 && corr.json?.quantite === 4, corr.json)
    check('line 1: livré follows the correction', ligne((await api(base)).json, l1)?.expedie === a1.expedie + 4)
    const zero = await api(`/expeditions-trm/${exp}/lignes/${l2}/quantite`, { method: 'PUT', body: JSON.stringify({ quantite: 0 }) })
    check('PUT quantite 0 removes the line from the avis', zero.status === 200)
    const c2 = ligne((await api(base)).json, l2)
    check('line 2: back to its previous count', c2?.expedie === a2.expedie && c2?.nb_livraisons === a2.nb_livraisons, c2)
    if (p.rouleau) {
      const r = await api(`/expeditions-trm/${exp}/lignes/${p.rouleau}/quantite`, { method: 'PUT', body: JSON.stringify({ quantite: 2 }) })
      check('a roll line takes no quantity (409)', r.status === 409, r.json)
    }
  } finally {
    console.log('\n4. Supprimer l’avis')
    const del = await api(`/expeditions-trm/${exp}`, { method: 'DELETE' })
    check('DELETE the avis', del.status === 200, del.json)
    const fin = (await api(base)).json
    check('line 1 back where it started', ligne(fin, l1)?.expedie === a1.expedie && ligne(fin, l1)?.nb_livraisons === a1.nb_livraisons)
    check('line 2 back where it started', ligne(fin, l2)?.expedie === a2.expedie)
    const leFin = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ligne_expedition WHERE IDligne_commande_client IN (${p.recti.join(',')})`)
    check('no shipment line left behind', Number(leFin[0].n) === Number(leAvant[0].n), { avant: leAvant[0].n, apres: leFin[0].n })
  }

  await closeConnection()
  if (failures > 0) { console.error(`\n${failures} failure(s).`); process.exit(1) }
  console.log('\nAll checks passed.')
}

main().catch(async (e) => { console.error(e); await closeConnection().catch(() => {}); process.exit(1) })
