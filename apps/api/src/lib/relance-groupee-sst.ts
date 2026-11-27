// The grouped relance of a sous-traitant (Vincent 2026-11-27).
//
// The way we work with a partner since Isabelle took the follow-up over: we
// order, it gives its délai, it delivers; all WE do is chase it by e-mail once a
// time it was given has run out. The daily « Point » told it far more (planned
// exits, reminders): we want fewer exchanges and the partner in charge of its
// own work. So ONE mail per sous-traitant, from its fiche (Sous-traitants ›
// Gestion), listing what is overdue on its side NOW and nothing else:
//
//   - a new délai      the délai has passed, the goods are not in (lib/relance-retard-sst.ts);
//   - an urgency       asked, its answer did not come on its day (lib/urgence-sst.ts);
//   - a délai          asked with the order, not given on its day (lib/delai-sst.ts);
//   - its controls     a received lot whose measures are still missing (lib/relance-controle.ts);
//   - a soumission     an étude coloris its lab has held beyond its days (lib/etude-etape.ts — Vincent,
//                      the same afternoon: the étude got its own red and its own relance, so it belongs
//                      here; a lab late on an étude with no late order was invisible in Gestion).
//
// ⚠️ Never a second rule: each dossier is read with the rule that turns its card
// red (the cycle's, the urgency's, the étude's), and sending the mail writes, dossier by
// dossier, the SAME relance fact its own mail button writes — so each card is
// calm again exactly as if it had been chased alone. Not in it: what waits on
// the client or on us (an étude whose soumission the CLIENT has not answered is
// chased from the étude, at the client), and anything not due yet.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { delaiDepasse, etapeLot, etatCommande, lireCommandesEnnoblissement, relanceControleDue, retardChasse } from './cycle-ennoblissement.js'
import { noterRelance, relanceDue } from './delai-sst.js'
import { enregistrerRelanceControle } from './relance-controle.js'
import { enregistrerRelanceRetard, lireRelancesRetard, retardCalme } from './relance-retard-sst.js'
import { etatsTricotage, familleOfTypeSst, ligneLivree } from './sst-tricotage.js'
import { demanderUrgence, enAttenteDeReponse, noterMailUrgence, urgencesLignes } from './urgence-sst.js'
import { enregistrerRelance, etudesParId } from './etude-ligne-client.js'
import { urgenceEtude } from './etude-etape.js'

export interface DossiersARelancer {
  /** A new délai is wanted: the délai has passed. `delai` 'YYYY-MM-DD'. */
  retards: { commande: number; articles: string; delai: string }[]
  /** An urgency asked whose answer did not come. */
  urgences: { commande: number; ligne: number; article: string; dateSouhaitee: string | null; demandeeLe: string }[]
  /** A délai asked with the order and not given. */
  delais: { commande: number; articles: string; commandeLe: string | null }[]
  /** The dyer's controls of a received lot. */
  controles: { idsuivilot: number; commande: number; lot: string; article: string; recuLe: string; manque: string[] }[]
  /** An étude coloris the lab holds beyond its days: a soumission is awaited. `depuis` 'YYYY-MM-DD' = since when
   *  it holds it (the type received, or the client's refusal of its last soumission); `ligne` = the client order
   *  line waiting for the étude (0 without one), kept on the relance. */
  etudes: { etude: number; libelle: string; reference: string; client: string; depuis: string | null; ligne: number }[]
}

const vide = (): DossiersARelancer => ({ retards: [], urgences: [], delais: [], controles: [], etudes: [] })

export const nombreDossiers = (d: DossiersARelancer): number =>
  d.retards.length + d.urgences.length + d.delais.length + d.controles.length + d.etudes.length

const jjmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const liste = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} et ${xs.at(-1)}`)
const article = (ref: string | null, coloris: string | null) => [ref, coloris].map((x) => (x ?? '').trim()).filter(Boolean).join(' - ')
const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))].join(', ')

/** What is overdue on each sous-traitant's side today. `idsst` null = every sous-traitant with an
 *  open order or a running étude coloris (the Gestion list's counters). `today` 'YYYY-MM-DD'. */
export async function dossiersARelancer(idsst: number | null, today: string, sql: Sql = mpsPg()): Promise<Map<number, DossiersARelancer>> {
  const [out, etudes] = await Promise.all([dossiersDesCommandes(idsst, today, sql), etudesARelancer(idsst, today, sql)])
  // A lab may have nothing but études running: it is read apart from the open orders.
  for (const [sst, es] of etudes) {
    if (!out.has(sst)) out.set(sst, vide())
    out.get(sst)!.etudes = es
  }
  return out
}

/** The études coloris each lab holds beyond its days: the red of Finis › Études coloris (`urgenceEtude` over
 *  `etatEtude`), kept only while the LAB holds the étude — the client's silence is not the lab's to answer. */
async function etudesARelancer(idsst: number | null, today: string, sql: Sql): Promise<Map<number, DossiersARelancer['etudes']>> {
  const out = new Map<number, DossiersARelancer['etudes']>()
  const rows = await sql<{ id: number; sst: number; client: string | null; reference: string | null; ligne: number }[]>`
    SELECT e.idetude_col::bigint AS id, e.idsous_traitant::bigint AS sst, c.nom::text AS client, r.reference::text AS reference,
           COALESCE((SELECT MIN(l.idligne_commande_client) FROM ligne_commande_client l WHERE l.idetude_col = e.idetude_col), 0)::bigint AS ligne
    FROM etude_col e
    LEFT JOIN client c ON c.idclient = e.idclient
    LEFT JOIN ref_fini r ON r.idref_fini = e.idref_fini
    WHERE e.statut_col IN (1, 2) AND e.idsous_traitant > 0 ${idsst === null ? sql`` : sql`AND e.idsous_traitant = ${idsst}`}
    ORDER BY e.idetude_col`
  if (rows.length === 0) return out
  const etats = await etudesParId(rows.map((r) => Number(r.id)))
  for (const r of rows) {
    const etat = etats.get(Number(r.id))
    if (!etat || etat.attente !== 'labo' || !urgenceEtude(etat, today)) continue
    const d = etat.attenteDepuis
    const sst = Number(r.sst)
    if (!out.has(sst)) out.set(sst, [])
    out.get(sst)!.push({
      etude: Number(r.id), libelle: etat.libelle, reference: (r.reference ?? '').trim(), client: (r.client ?? '').trim(),
      depuis: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null, ligne: Number(r.ligne) || 0,
    })
  }
  return out
}

/** What is overdue on the open ORDERS of each sous-traitant. */
async function dossiersDesCommandes(idsst: number | null, today: string, sql: Sql): Promise<Map<number, DossiersARelancer>> {
  const out = new Map<number, DossiersARelancer>()
  const cmds = await sql<{ id: number; sst: number; le: string | null; type_sst: number | null }[]>`
    SELECT c.idcommande_sous_traitant AS id, c.idsous_traitant AS sst, to_char(c.date_commande, 'YYYY-MM-DD') AS le, st.idtype_sst AS type_sst
    FROM commande_sous_traitant c JOIN sous_traitant st ON st.idsous_traitant = c.idsous_traitant
    WHERE COALESCE(c.est_soldee, 0) = 0 ${idsst === null ? sql`` : sql`AND c.idsous_traitant = ${idsst}`}`
  if (cmds.length === 0) return out
  const ids = cmds.map((c) => Number(c.id))
  const lignes = await sql<{ id: number; cmd: number; delai: string | null; sstatut: string | null; ref: string | null; coloris: string | null }[]>`
    SELECT l.idligne_commande_sous_traitant AS id, l.idcommande_sous_traitant AS cmd,
           to_char(l.date_livraison, 'YYYY-MM-DD') AS delai, l.sstatut::text AS sstatut,
           COALESCE(rf.reference::text, re.reference::text) AS ref,
           CASE WHEN l.type = 2 AND COALESCE(rf.avec_teinture, 1) <> 0 THEN COALESCE(rfc.reference::text, ce.reference::text)
                ELSE ce.reference::text END AS coloris
    FROM ligne_commande_sous_traitant l
    LEFT JOIN ref_fini rf ON l.type = 2 AND rf.idref_fini = l.idreference
    LEFT JOIN ref_ecru re ON l.type = 1 AND re.idref_ecru = l.idreference
    LEFT JOIN ref_fini_colori rfc ON l.type = 2 AND rfc.idref_fini_colori = l.idcoloris
    LEFT JOIN colori_ecru ce ON ce.idcolori_ecru = l.idcoloris
    WHERE l.idcommande_sous_traitant = ANY(${ids})`
  const nomLigne = new Map(lignes.map((l) => [Number(l.id), article(l.ref, l.coloris)]))
  const lignesDe = (cmd: number) => lignes.filter((l) => Number(l.cmd) === cmd)
  const pour = (sst: number) => { if (!out.has(sst)) out.set(sst, vide()); return out.get(sst)! }

  const enno = cmds.filter((c) => familleOfTypeSst(c.type_sst) === 'ennoblissement')
  const trico = cmds.filter((c) => familleOfTypeSst(c.type_sst) === 'tricotage')
  const [faitsEnno, etatsTrico, relancesRetard, urgences] = await Promise.all([
    lireCommandesEnnoblissement(enno.map((c) => Number(c.id))),
    etatsTricotage(trico.map((c) => Number(c.id)), new Date(`${today}T12:00:00`)),
    lireRelancesRetard(trico.map((c) => Number(c.id)), sql),
    urgencesLignes(lignes.map((l) => ({ id: Number(l.id), delai: l.delai })), today, sql),
  ])
  // An urgency asked on a line and overdue; its line must still be open.
  const urgencesDe = (d: DossiersARelancer, cmd: number, ouvertes: Set<number>) => {
    for (const l of lignesDe(cmd)) {
      const u = urgences.get(Number(l.id))
      if (!u || u.etat !== 'a_relancer' || !ouvertes.has(Number(l.id))) continue
      d.urgences.push({ commande: cmd, ligne: Number(l.id), article: nomLigne.get(Number(l.id)) ?? '', dateSouhaitee: u.dateSouhaitee, demandeeLe: u.demandeeLe })
    }
  }
  /** Every open line still without a délai was pressed: the délai is asked through the urgency. */
  const toutPresse = (sansDelai: number[]) => sansDelai.length > 0 && sansDelai.every((id) => enAttenteDeReponse(urgences.get(id)))

  for (const c of enno) {
    const id = Number(c.id)
    const f = faitsEnno.get(id)
    if (!f) continue
    const e = etatCommande(f)
    const d = pour(Number(c.sst))
    const ouvertes = lignesDe(id).filter((l) => !String(l.sstatut ?? '').startsWith('Termin'))
    urgencesDe(d, id, new Set(ouvertes.map((l) => Number(l.id))))
    const sansDelai = ouvertes.filter((l) => !l.delai).map((l) => Number(l.id))
    if (e.etape === 'attente_delai' && !!e.relance && e.relance <= today && !toutPresse(sansDelai)) {
      d.delais.push({ commande: id, articles: unique(sansDelai.map((x) => nomLigne.get(x) ?? '')), commandeLe: c.le })
    }
    if (delaiDepasse(e, today) && !retardChasse(e, today)) {
      const enRetard = (f.lignesOuvertes ?? []).filter((l) => l.delai <= today)
      const vues = enRetard.length > 0 ? enRetard : (f.lignesOuvertes ?? [])
      d.retards.push({ commande: id, articles: unique(vues.map((l) => nomLigne.get(l.id) ?? '')), delai: vues.map((l) => l.delai).sort()[0] ?? e.relance! })
    }
    for (const l of f.lots) {
      if (!l.reception || l.idsuivilot <= 0 || etapeLot(l) !== 'attente_mesures') continue
      const due = relanceControleDue(l)
      if (!due || due > today) continue
      d.controles.push({ idsuivilot: l.idsuivilot, commande: id, lot: l.lot, article: nomLigne.get(l.idligne ?? 0) ?? '', recuLe: l.reception, manque: l.manqueTeinturier ?? [] })
    }
  }

  for (const c of trico) {
    const id = Number(c.id)
    const e = etatsTrico.get(id)
    if (!e || e.phase === 'terminee' || e.phase === 'trm_soldee') continue
    const d = pour(Number(c.sst))
    const ouvertes = e.commande.lignes.filter((l) => !ligneLivree(l))
    urgencesDe(d, id, new Set(ouvertes.map((l) => l.id)))
    const sansDelai = ouvertes.filter((l) => !l.date_livraison).map((l) => l.id)
    const due = e.phase === 'attente_delai' && e.faits ? relanceDue(e.faits) : null
    if (due && due <= today && !toutPresse(sansDelai)) {
      d.delais.push({ commande: id, articles: unique(sansDelai.map((x) => nomLigne.get(x) ?? '')), commandeLe: c.le })
    }
    if (e.delaiDepasse && !retardCalme(relancesRetard.get(id), e.delaiDepasse, today)) {
      const jour = today.replace(/-/g, '')
      const enRetard = ouvertes.filter((l) => /^\d{8}$/.test(l.date_livraison) && l.date_livraison <= jour)
      d.retards.push({ commande: id, articles: unique(enRetard.map((l) => nomLigne.get(l.id) ?? '')), delai: e.delaiDepasse })
    }
  }

  for (const [sst, d] of out) {
    if (nombreDossiers(d) === 0) { out.delete(sst); continue }
    for (const k of ['retards', 'urgences', 'delais', 'controles'] as const) d[k].sort((a, b) => a.commande - b.commande)
  }
  return out
}

/** The passed délai of ONE open order while the partner holds it (« Relancer le délai dépassé », the
 *  order's mail button), null when there is none: `delai` the date it was expected ('YYYY-MM-DD'),
 *  `derniereRelance` our latest relance of it. Offered every day, chased or not. */
export async function retardDeLaCommande(idcommande: number, today: string, sql: Sql = mpsPg()): Promise<{ delai: string; derniereRelance: string | null } | null> {
  const [c] = await sql<{ type_sst: number | null }[]>`
    SELECT st.idtype_sst AS type_sst
    FROM commande_sous_traitant c JOIN sous_traitant st ON st.idsous_traitant = c.idsous_traitant
    WHERE c.idcommande_sous_traitant = ${idcommande} AND COALESCE(c.est_soldee, 0) = 0`
  if (!c) return null
  let delai: string | null = null
  let echeance: string | null = null
  if (familleOfTypeSst(c.type_sst) === 'tricotage') {
    delai = echeance = (await etatsTricotage([idcommande], new Date(`${today}T12:00:00`))).get(idcommande)?.delaiDepasse ?? null
  } else {
    const f = (await lireCommandesEnnoblissement([idcommande])).get(idcommande)
    const e = f ? etatCommande(f) : null
    if (f && e && delaiDepasse(e, today)) { echeance = e.relance; delai = f.delai && f.delai <= today ? f.delai : e.relance }
  }
  if (!delai || !echeance) return null
  const relances = (await lireRelancesRetard([idcommande], sql)).get(idcommande) ?? []
  return { delai, derniereRelance: relances.filter((r) => r >= echeance!).at(-1) ?? null }
}

/** One sous-traitant's dossiers (empty when nothing is overdue). */
export async function dossiersDuSousTraitant(idsst: number, today: string, sql: Sql = mpsPg()): Promise<DossiersARelancer> {
  return (await dossiersARelancer(idsst, today, sql)).get(idsst) ?? vide()
}

/** The grouped mail as it opens: one block per kind of answer we wait for, the most pressing first;
 *  the person reads it before it leaves. Pure. */
export function mailRelanceGroupee(d: DossiersARelancer): { subject: string; body: string } {
  const n = nombreDossiers(d)
  const cmd = (numero: number, articles: string) => `Commande N°${numero}${articles ? ` (${articles})` : ''}`
  const blocs: string[] = []
  if (d.retards.length > 0) {
    blocs.push(['Un nouveau délai, le délai prévu étant dépassé :',
      ...d.retards.map((r) => `- ${cmd(r.commande, r.articles)}, prévue le ${jjmmaaaa(r.delai)}`)].join('\n'))
  }
  if (d.urgences.length > 0) {
    blocs.push(['Votre réponse à nos demandes d’urgence :',
      ...d.urgences.map((u) => `- ${cmd(u.commande, u.article)}${u.dateSouhaitee ? `, souhaitée le ${jjmmaaaa(u.dateSouhaitee)}` : ''}, demandée le ${jjmmaaaa(u.demandeeLe)}`)].join('\n'))
  }
  if (d.delais.length > 0) {
    blocs.push(['Votre délai :',
      ...d.delais.map((x) => `- ${cmd(x.commande, x.articles)}${x.commandeLe ? `, du ${jjmmaaaa(x.commandeLe)}` : ''}`)].join('\n'))
  }
  if (d.controles.length > 0) {
    blocs.push(['Vos contrôles :',
      ...d.controles.map((c) => `- Lot ${c.lot}${c.article ? ` (${c.article})` : ''}, reçu le ${jjmmaaaa(c.recuLe)}${c.manque.length > 0 ? ` : ${liste(c.manque)}` : ''}`)].join('\n'))
  }
  if (d.etudes.length > 0) {
    blocs.push(['Vos soumissions d’études coloris :',
      ...d.etudes.map((e) => {
        const pour = [e.reference, e.client ? `pour ${e.client}` : ''].filter(Boolean).join(', ')
        return `- Étude N°${e.etude} « ${e.libelle} »${pour ? ` (${pour})` : ''}${e.depuis ? `, que vous avez depuis le ${jjmmaaaa(e.depuis)}` : ''}`
      })].join('\n'))
  }
  return {
    subject: `Relance — ${n} dossier${n > 1 ? 's' : ''} en attente — ETS Malterre`,
    body: `Bonjour,\n\nNous attendons de votre part :\n\n${blocs.join('\n\n')}\n\nMerci d’avance pour votre retour.\n\nCordialement,`,
  }
}

/** The grouped mail left: each dossier gets the relance its own mail button writes (never a fact of
 *  its own). One dossier failing never stops the others — the mail is out. Returns how many were noted. */
export async function noterRelanceGroupee(
  d: DossiersARelancer, par: { id: number; nom: string }, destinataires: readonly string[], today: string, sql: Sql = mpsPg(),
): Promise<number> {
  let n = 0
  const tenter = async (quoi: string, f: () => Promise<void>) => {
    try { await f(); n++ } catch (err) { console.error(`[relance-groupee] ${quoi} non notée :`, err) }
  }
  const note = `À ${destinataires.join(', ')}`.slice(0, 1000)
  for (const r of d.retards) await tenter(`retard ${r.commande}`, () => enregistrerRelanceRetard({ idcommande: r.commande, par, destinataires }, sql))
  for (const u of d.urgences) {
    await tenter(`urgence ${u.commande}/${u.ligne}`, async () => {
      await demanderUrgence({ idcommande: u.commande, idligne: u.ligne, dateSouhaitee: null, par, aujourdhui: today }, sql)
      await noterMailUrgence({ idcommande: u.commande, idligne: u.ligne, geste: 'relance', destinataires, par }, sql)
    })
  }
  for (const x of d.delais) await tenter(`délai ${x.commande}`, () => noterRelance(x.commande, 'email', note, par))
  for (const c of d.controles) {
    await tenter(`contrôles ${c.lot}`, () => enregistrerRelanceControle({ idsuivilot: c.idsuivilot, idcommande: c.commande, lot: c.lot, par, destinataires: [...destinataires] }))
  }
  // The étude's own relance (etude_col_relance): it restarts the lab's clock on Finis › Études coloris, on
  // the client line waiting for the étude and in the espace partenaire.
  for (const e of d.etudes) {
    await tenter(`étude ${e.etude}`, async () => {
      if ((await enregistrerRelance(e.etude, par, e.ligne)) !== 'labo') throw new Error('l’étude n’attend plus le labo')
    })
  }
  return n
}

export interface DestinataireSst { email: string; name?: string; source: 'contact'; contactId: number }

/** The sous-traitant's contacts: those who receive the orders are ticked, the others offered. `avecLabo`:
 *  the mail chases an étude coloris, so the contacts who receive the soumissions (the lab) are ticked too. */
export async function destinatairesSousTraitant(idsst: number, sql: Sql = mpsPg(), avecLabo = false): Promise<{ selected: DestinataireSst[]; suggestions: DestinataireSst[] }> {
  const lus = await sql<{ id: number; nom: string | null; prenom: string | null; mail: string | null; commande: number; visible: number }[]>`
    SELECT idcontact AS id, nom::text AS nom, prenom::text AS prenom, mail::text AS mail,
           GREATEST(COALESCE(envoi_commande, 0), ${avecLabo ? sql`COALESCE(envoi_soumission, 0)` : sql`0`})::int AS commande,
           COALESCE(est_visible, 1)::int AS visible
    FROM contact WHERE idsous_traitant = ${idsst} ORDER BY idcontact`
  const selected: DestinataireSst[] = []
  const suggestions: DestinataireSst[] = []
  const vus = new Set<string>()
  for (const c of lus) {
    const mail = (c.mail ?? '').trim()
    if (Number(c.visible) === 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || vus.has(mail.toLowerCase())) continue
    vus.add(mail.toLowerCase())
    const name = [c.prenom, c.nom].map((x) => (x ?? '').trim()).filter(Boolean).join(' ')
    const r: DestinataireSst = { email: mail, source: 'contact', contactId: Number(c.id), ...(name ? { name } : {}) }
    if (Number(c.commande) === 1) selected.push(r)
    else suggestions.push(r)
  }
  return { selected, suggestions }
}
