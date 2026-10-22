// Clients › Commandes: a fini line confirmed while its coloris is still being studied (ETM).
//
// Why (Isabelle + Vincent, 2026-10-22): a client wants its order confirmed at once and the étude coloris
// run meanwhile. The office used to create a fictive coloris on the ref (« coloris à étudier », « Coloris à
// définir », « Coloris en étude »… 40 in prod, 36 left behind once the real coloris existed) and the line on
// it turned red « à lancer » while nobody at Malterre could do anything.
//
// Now the line points at ITS étude (ligne_commande_client.idetude_col, one line = one étude) with no
// coloris. When the client accepts a soumission, the étude's new coloris is written on the line
// (routes/etudes-coloris.ts, respond). Until then the line asks no délai: the only Malterre action is to
// chase whoever holds the étude when they take longer than usual (red, never amber — chasing early
// improves nothing). Measured on 267 études accepted since 2024 (prod, 2026-10-22):
//   type received → first soumission (lab)     p50 13 j, p80 17 j   → relance l'ennoblisseur at 17 j
//   soumission → client's answer               p50 12 j, p80 31 j   → relance le client at 21 j
// A relance (etude_col_relance, append-only) restarts the clock. `screen_notes.md` § 3.

import { query, fixEncoding } from './hfsql-auto.js'
import { mpsPg } from './mps-pg.js'

export const SEUILS_ETUDE = {
  /** days the lab (the étude's ennoblisseur) has to send a soumission before we chase */
  labo: 17,
  /** days the client has to answer a soumission before we chase */
  client: 21,
} as const

/** What the coloris printed for a line still in étude (confirmation PDF, espace client). */
export const LIBELLE_COLORIS_EN_ETUDE = 'Coloris en cours d’étude'

/** Who holds the étude now: the lab, the client, or nobody (accepted / cancelled). */
export type AttenteEtude = 'labo' | 'client' | 'acceptee' | 'annulee'

export interface SoumissionEtude {
  id: number
  /** YYYYMMDD */
  dateSoum: string | null
  /** YYYYMMDD */
  dateReponse: string | null
  /** 0 pending · 1 accepted · 2 refused */
  accepte: number
}

export interface RelanceEtude {
  cible: 'labo' | 'client'
  /** YYYYMMDD */
  le: string
}

export interface EtatEtude {
  attente: AttenteEtude
  /** YYYYMMDD: since when the holder holds it (or our last relance, whichever is later) */
  depuis: string | null
  /** YYYYMMDD: since when the holder holds it, relances aside (what the relance mail cites) */
  attenteDepuis: string | null
  /** YYYYMMDD: the day Malterre must chase (null when nobody is waited for) */
  relanceLe: string | null
  /** YYYYMMDD of our last relance of the current holder, if any */
  derniereRelance: string | null
}

const ymd = (v: unknown): string | null => {
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null
      : `${v.getFullYear()}${String(v.getMonth() + 1).padStart(2, '0')}${String(v.getDate()).padStart(2, '0')}`
  }
  const d = String(v ?? '').replace(/\D/g, '').slice(0, 8)
  return /^\d{8}$/.test(d) && d !== '00000000' ? d : null
}

const maxYmd = (...ds: (string | null)[]) => ds.filter((d): d is string => !!d).sort().pop() ?? null

function plusJours(d: string, n: number): string {
  const t = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + n)
  return ymd(t)!
}

/**
 * Who holds the étude and since when (pure).
 * statut_col: 1 attente labo · 2 soumis au client · 3 accepté · 4 annulé. A refused soumission keeps
 * statut 2 in the data while the lab works on the next one: the latest soumission decides.
 */
export function etatEtude(
  e: { statut: number; dateReception: string | null; derniereAction?: string | null },
  soumissions: readonly SoumissionEtude[],
  relances: readonly RelanceEtude[],
): EtatEtude {
  const rien = (attente: AttenteEtude): EtatEtude => ({ attente, depuis: null, attenteDepuis: null, relanceLe: null, derniereRelance: null })
  if (e.statut === 4) return rien('annulee')
  if (e.statut === 3) return rien('acceptee')
  const derniere = [...soumissions].sort((a, b) =>
    (a.dateSoum ?? '').localeCompare(b.dateSoum ?? '') || a.id - b.id).pop()
  if (derniere?.accepte === 1) return rien('acceptee')
  let attente: 'labo' | 'client'
  let depuis: string | null
  if (derniere && derniere.accepte === 0) {
    attente = 'client'
    depuis = derniere.dateSoum
  } else {
    attente = 'labo'
    depuis = derniere ? (derniere.dateReponse ?? derniere.dateSoum) : (e.dateReception ?? e.derniereAction ?? null)
  }
  const attenteDepuis = depuis
  const derniereRelance = maxYmd(...relances.filter((r) => r.cible === attente && (!depuis || r.le >= depuis)).map((r) => r.le))
  depuis = maxYmd(depuis, derniereRelance)
  return { attente, depuis, attenteDepuis, relanceLe: depuis ? plusJours(depuis, SEUILS_ETUDE[attente]) : null, derniereRelance }
}

export interface EtudeLigne extends EtatEtude {
  id: number
  libelle: string
}

/** Each étude's state, batched (flat queries). Missing études are left out. */
export async function etudesParId(ids: readonly number[]): Promise<Map<number, EtudeLigne>> {
  const out = new Map<number, EtudeLigne>()
  const u = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)))
  if (u.length === 0) return out
  const [etudes, soums, relances] = await Promise.all([
    query<{ IDetude_col: number; libelle: string | null; statut_col: number; date_reception_type: unknown; date_derniere_action: unknown }>(
      `SELECT IDetude_col, libelle, statut_col, date_reception_type, date_derniere_action FROM etude_col WHERE IDetude_col IN (${u.join(',')})`,
    ),
    query<{ IDsoum_col: number; IDetude_col: number; date_soum: unknown; date_reponse: unknown; accepte: number | null }>(
      `SELECT IDsoum_col, IDetude_col, date_soum, date_reponse, accepte FROM soum_col WHERE IDetude_col IN (${u.join(',')})`,
    ),
    mpsPg()<{ idetude_col: number; cible: 'labo' | 'client'; relancee_le: Date }[]>`
      SELECT idetude_col, cible, relancee_le FROM etude_col_relance WHERE idetude_col IN ${mpsPg()(u)}`,
  ])
  for (const e of etudes) {
    const id = Number(e.IDetude_col)
    const s = soums.filter((x) => Number(x.IDetude_col) === id).map((x) => ({
      id: Number(x.IDsoum_col), dateSoum: ymd(x.date_soum), dateReponse: ymd(x.date_reponse), accepte: Number(x.accepte) || 0,
    }))
    const r = relances.filter((x) => Number(x.idetude_col) === id).map((x) => ({ cible: x.cible, le: ymd(x.relancee_le)! }))
    const etat = etatEtude(
      { statut: Number(e.statut_col) || 0, dateReception: ymd(e.date_reception_type), derniereAction: ymd(e.date_derniere_action) },
      s, r,
    )
    out.set(id, { id, libelle: String(e.libelle ?? '').trim(), ...etat })
  }
  return out
}

/** The étude facts the urgency rule needs, or undefined when the line is not waiting for one
 *  (no étude, or its coloris is already set: the étude is history then). */
export function etudeUrgence(idEtude: number, idColori: number, etudes: Map<number, EtudeLigne>) {
  if (!(idEtude > 0) || idColori > 0) return undefined
  const e = etudes.get(idEtude)
  // A link to a deleted étude: nothing to chase, a coloris to choose.
  if (!e) return { attente: 'annulee' as const, relanceLe: null }
  return { attente: e.attente, relanceLe: e.relanceLe }
}

// ── Writes ──────────────────────────────────────────────────

/** Why a line may not point at this étude (French, shown as is), null when it may.
 *  Same client as the order, same fini reference, one line per étude, and an étude still running
 *  — unless the line already points at it (an edit keeps its link). */
export async function refusLienEtude(
  etudeId: number,
  ligne: { idCommande: number; typeKind: number; refId: number; idLigne: number | null },
): Promise<string | null> {
  if (ligne.typeKind !== 2) return 'Seule une ligne de fini peut attendre une étude coloris.'
  const [etudes, cmd, liees] = await Promise.all([
    query<{ IDclient: number; IDref_fini: number; statut_col: number }>(
      `SELECT IDclient, IDref_fini, statut_col FROM etude_col WHERE IDetude_col = ${etudeId}`),
    query<{ IDclient: number }>(`SELECT IDclient FROM commande_client WHERE IDcommande_client = ${ligne.idCommande}`),
    query<{ IDligne_commande_client: number }>(
      `SELECT IDligne_commande_client FROM ligne_commande_client WHERE IDetude_col = ${etudeId}`),
  ])
  const e = etudes[0]
  if (!e) return 'Étude coloris introuvable.'
  if (Number(e.IDclient) !== Number(cmd[0]?.IDclient)) return 'Cette étude coloris est celle d’un autre client.'
  if (Number(e.IDref_fini) !== ligne.refId) return 'Cette étude coloris porte sur une autre référence.'
  if (liees.some((a) => Number(a.IDligne_commande_client) !== ligne.idLigne)) {
    return 'Cette étude coloris est déjà liée à une autre ligne de commande (une ligne = une étude).'
  }
  const dejaLiee = liees.some((a) => Number(a.IDligne_commande_client) === ligne.idLigne)
  const statut = Number(e.statut_col) || 0
  if (!dejaLiee && statut === 3) return 'Cette étude est déjà acceptée : choisissez son coloris.'
  if (!dejaLiee && statut === 4) return 'Cette étude coloris est annulée.'
  return null
}

// ── The relance mail ────────────────────────────────────────
//
// Chasing IS writing (Vincent, 2026-10-22): the line's « Relancer » opens the mail dialog addressed to
// whoever holds the étude — the étude's ennoblisseur (its contacts ticked « soumission ») or the client
// (its contacts ticked « soumission », else « commande ») — and sending it records the relance.

export interface DestinataireRelance { email: string; name?: string; source: 'contact'; contactId: number }

export interface RelanceEtudeMail {
  cible: 'labo' | 'client'
  /** who the dialog names in its title: the dyer or the client */
  destinataire: string
  recipients: { selected: DestinataireRelance[]; suggestions: DestinataireRelance[] }
  subject: string
  body: string
}

const jjmmaaaa = (d: string | null) => (d ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : '')

/** Visible contacts with a valid address; those passing `choisi` pre-ticked, the others suggested. */
function trierContacts(
  rows: Array<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; est_visible: number | null } & Record<string, unknown>>,
  choisi: (r: Record<string, unknown>) => boolean,
): RelanceEtudeMail['recipients'] {
  const selected: DestinataireRelance[] = []
  const suggestions: DestinataireRelance[] = []
  const seen = new Set<string>()
  for (const c of rows) {
    if (Number(c.est_visible) === 0) continue
    const mail = String(c.mail ?? '').trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || seen.has(mail.toLowerCase())) continue
    seen.add(mail.toLowerCase())
    const name = [c.prenom, c.nom].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ')
    const r: DestinataireRelance = { email: mail, source: 'contact', contactId: Number(c.IDcontact), ...(name ? { name } : {}) }
    if (choisi(c)) selected.push(r); else suggestions.push(r)
  }
  return { selected, suggestions }
}

/** The relance mail of a line waiting for its étude; null when nobody is to be chased. */
export async function mailRelanceEtude(lineId: number): Promise<RelanceEtudeMail | null> {
  const lignes = await query<{ IDetude_col: number; IDcolori: number; IDcommande_client: number }>(
    `SELECT IDetude_col, IDcolori, IDcommande_client FROM ligne_commande_client WHERE IDligne_commande_client = ${lineId}`)
  const l = lignes[0]
  const etudeId = Number(l?.IDetude_col) || 0
  if (!l || !(etudeId > 0) || (Number(l.IDcolori) || 0) > 0) return null
  const etat = (await etudesParId([etudeId])).get(etudeId)
  if (!etat || (etat.attente !== 'labo' && etat.attente !== 'client')) return null

  const [etudes, cmds] = await Promise.all([
    query<{ IDclient: number; IDsous_traitant: number; IDref_fini: number }>(
      `SELECT IDclient, IDsous_traitant, IDref_fini FROM etude_col WHERE IDetude_col = ${etudeId}`),
    query<{ numero: number | null; ref_client: string | null }>(
      `SELECT numero, ref_client FROM commande_client WHERE IDcommande_client = ${Number(l.IDcommande_client)}`),
  ])
  const e = etudes[0]
  const idClient = Number(e?.IDclient) || 0
  const idSst = Number(e?.IDsous_traitant) || 0
  const [refRows, clientRows, sstRows] = await Promise.all([
    query<{ IDref_fini: number; reference: string | null }>(`SELECT IDref_fini, reference FROM ref_fini WHERE IDref_fini = ${Number(e?.IDref_fini) || 0}`),
    query<{ IDclient: number; nom: string | null }>(`SELECT IDclient, nom FROM client WHERE IDclient = ${idClient}`),
    query<{ IDsous_traitant: number; nom: string | null }>(`SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant = ${idSst}`),
  ])
  const ref = String((await fixEncoding(refRows, 'ref_fini', 'IDref_fini', ['reference']))[0]?.reference ?? '').trim()
  const clientNom = String((await fixEncoding(clientRows, 'client', 'IDclient', ['nom']))[0]?.nom ?? '').trim()
  const sstNom = String((await fixEncoding(sstRows, 'sous_traitant', 'IDsous_traitant', ['nom']))[0]?.nom ?? '').trim()
  const numero = String(cmds[0]?.numero ?? '')
  const refClient = String(cmds[0]?.ref_client ?? '').trim()

  if (etat.attente === 'labo') {
    const contacts = idSst > 0
      ? await query<any>(`SELECT IDcontact, nom, prenom, mail, est_visible, envoi_soumission FROM contact WHERE IDsous_traitant = ${idSst}`)
      : []
    const fixed = await fixEncoding(contacts, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])
    return {
      cible: 'labo',
      destinataire: sstNom,
      recipients: trierContacts(fixed, (c) => Number(c.envoi_soumission) === 1),
      subject: `Relance étude coloris N°${etudeId} — ${etat.libelle}${ref ? ` · ${ref}` : ''}`,
      body: [
        'Bonjour,',
        '',
        `Où en est l’étude coloris N°${etudeId} « ${etat.libelle} »${ref ? ` sur la référence ${ref}` : ''}${etat.attenteDepuis ? `, que vous avez depuis le ${jjmmaaaa(etat.attenteDepuis)}` : ''} ?`,
        '',
        `Notre client${clientNom ? ` ${clientNom}` : ''} a déjà passé commande et attend la soumission pour que nous lancions la production.`,
        'Merci de nous indiquer quand vous pourrez nous l’envoyer.',
        '',
        'Cordialement,',
      ].join('\n'),
    }
  }

  const contacts = idClient > 0
    ? await query<any>(`SELECT IDcontact, nom, prenom, mail, est_visible, envoi_soumission, envoi_commande FROM contact WHERE IDclient = ${idClient}`)
    : []
  const fixed = await fixEncoding(contacts, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])
  const parSoumission = fixed.some((c: any) => Number(c.envoi_soumission) === 1)
  return {
    cible: 'client',
    destinataire: clientNom,
    recipients: trierContacts(fixed, (c) => Number(parSoumission ? c.envoi_soumission : c.envoi_commande) === 1),
    subject: `Votre choix de coloris — commande N°${numero}${refClient ? ` (${refClient})` : ''}`,
    body: [
      'Bonjour,',
      '',
      `Nous vous avons soumis${etat.attenteDepuis ? ` le ${jjmmaaaa(etat.attenteDepuis)}` : ''} notre proposition de coloris « ${etat.libelle} »${ref ? ` sur la référence ${ref}` : ''}, pour votre commande N°${numero}${refClient ? ` (${refClient})` : ''}.`,
      '',
      'Pourriez-vous nous faire part de votre choix ? Dès votre validation, nous lançons la production et vous confirmons le délai.',
      '',
      'Cordialement,',
    ].join('\n'),
  }
}

/** Records that we chased the étude's current holder (append-only). Null when nobody is waited for. */
export async function enregistrerRelance(
  etudeId: number,
  par: { id: number; nom: string },
  idLigne: number,
): Promise<'labo' | 'client' | null> {
  const etat = (await etudesParId([etudeId])).get(etudeId)
  if (!etat || (etat.attente !== 'labo' && etat.attente !== 'client')) return null
  await mpsPg()`
    INSERT INTO etude_col_relance (idetude_col, cible, par_id, par, idligne_commande_client)
    VALUES (${etudeId}, ${etat.attente}, ${par.id}, ${par.nom || null}, ${idLigne})`
  return etat.attente
}
