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
//
// No date either (Vincent 2026-11-27, order 3944: validated, the line took 27/01/2027 as an engagement,
// then two reports « on attend le coloris » on a line whose coloris did not exist). « Valider la
// commande » dates every line EXCEPT the ones waiting for their étude: they stay without « Prête le » and
// without engagement, and no date is written on them while they wait (dateEnEtude). Once the coloris is
// accepted the line is an ordinary one without a date — red « sans délai » — and the first date it is
// given is its engagement, not a report.

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
/** …and under it on the confirmation, in place of a date it cannot carry yet (Vincent 2026-11-27). */
export const MENTION_DELAI_EN_ETUDE = 'Délai communiqué à la validation du coloris'

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

/** A line waiting for its étude coloris: it points at one and has no coloris yet (with its coloris,
 *  the étude is history). In SQL: `idetude_col > 0 AND COALESCE(idcolori, 0) = 0`. */
export function attendEtude(idEtude: unknown, idColori: unknown): boolean {
  return (Number(idEtude) || 0) > 0 && !((Number(idColori) || 0) > 0)
}

export const MESSAGE_DATE_EN_ETUDE = 'Ligne en étude coloris : sa date se donne une fois le coloris accepté.'

/**
 * The « Prête le » a write leaves on a line waiting for its étude (pure; dates YYYYMMDD, '' = none).
 * In préparation: none, whatever was typed. Validated: a line without a date takes none (refused) —
 * a line that already carries one (dated before this rule, or switched to an étude after its date was
 * given) keeps the ordinary rules: its date is an engagement, moving it a report.
 */
export function dateEnEtude(p: { enPreparation: boolean; actuelle: string; demandee: string }): { date: string } | { refus: string } {
  if (p.enPreparation) return { date: '' }
  if (!p.actuelle && p.demandee) return { refus: MESSAGE_DATE_EN_ETUDE }
  return { date: p.demandee }
}

/** Every relance of one étude, oldest first, with who sent it (the étude's own screen: its step and its
 *  Historique). `le` YYYYMMDD, `quand` 'YYYY-MM-DD HH:MM:SS.mmm' (the shape of the screen's other events). */
export async function relancesEtude(etudeId: number): Promise<Array<RelanceEtude & { id: number; quand: string; par: string }>> {
  const rows = await mpsPg()<{ id: number; cible: 'labo' | 'client'; relancee_le: Date; par: string | null }[]>`
    SELECT id, cible, relancee_le, par FROM etude_col_relance WHERE idetude_col = ${etudeId} ORDER BY relancee_le, id`
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return rows.map((r) => {
    const d = r.relancee_le
    return {
      id: Number(r.id), cible: r.cible, le: ymd(d)!, par: String(r.par ?? '').trim(),
      quand: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`,
    }
  })
}

/** The étude facts the urgency rule needs, or undefined when the line is not waiting for one
 *  (no étude, or its coloris is already set: the étude is history then). */
export function etudeUrgence(idEtude: number, idColori: number, etudes: Map<number, EtudeLigne>) {
  if (!attendEtude(idEtude, idColori)) return undefined
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
// Chasing IS writing (Vincent, 2026-10-22): the relance is a mail addressed to whoever holds the étude —
// the étude's ennoblisseur (its contacts ticked « soumission ») or the client (its contacts ticked
// « soumission », else « commande ») — and sending it records the relance. It leaves from the ÉTUDE
// (Finis › Études coloris, the « @ » button), never from the client line waiting for it (2026-11-27:
// the line's own « Relancer » button and its routes are gone, the line links to its étude).

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

/** The client order an étude is studied for, as the relance mail names it. */
interface CommandeEtude { numero: string; refClient: string }

/** The relance mail of an étude (Finis › Études coloris, 2026-11-27): the order it names is the one of the
 *  line waiting for the étude, else the N° typed on the étude, else none. `idLigne` = that line (0 without
 *  one), kept on the relance. Null when nobody is to be chased. */
export async function mailRelanceEtudeParId(etudeId: number): Promise<(RelanceEtudeMail & { idLigne: number }) | null> {
  if (!(etudeId > 0)) return null
  const [lignes, etudes] = await Promise.all([
    query<{ IDligne_commande_client: number; IDcommande_client: number }>(
      `SELECT IDligne_commande_client, IDcommande_client FROM ligne_commande_client WHERE IDetude_col = ${etudeId}`),
    query<{ IDetude_col: number; num_commande: string | null }>(
      `SELECT IDetude_col, num_commande FROM etude_col WHERE IDetude_col = ${etudeId}`),
  ])
  const l = lignes[0]
  const saisi = String((await fixEncoding(etudes, 'etude_col', 'IDetude_col', ['num_commande']))[0]?.num_commande ?? '').trim()
  const commande = l ? await commandeDe(Number(l.IDcommande_client)) : saisi ? { numero: saisi, refClient: '' } : null
  const mail = await mailRelance(etudeId, commande)
  return mail ? { ...mail, idLigne: Number(l?.IDligne_commande_client) || 0 } : null
}

async function commandeDe(idCommande: number): Promise<CommandeEtude | null> {
  const cmds = await query<{ numero: number | null; ref_client: string | null }>(
    `SELECT numero, ref_client FROM commande_client WHERE IDcommande_client = ${idCommande}`)
  return cmds[0] ? { numero: String(cmds[0].numero ?? ''), refClient: String(cmds[0].ref_client ?? '').trim() } : null
}

/** The mail to whoever holds the étude. Without a client order, it says nothing of one. */
async function mailRelance(etudeId: number, commande: CommandeEtude | null): Promise<RelanceEtudeMail | null> {
  const etat = (await etudesParId([etudeId])).get(etudeId)
  if (!etat || (etat.attente !== 'labo' && etat.attente !== 'client')) return null

  const etudes = await query<{ IDclient: number; IDsous_traitant: number; IDref_fini: number }>(
    `SELECT IDclient, IDsous_traitant, IDref_fini FROM etude_col WHERE IDetude_col = ${etudeId}`)
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
  const numero = commande?.numero ?? ''
  const refClient = commande?.refClient ?? ''

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
        commande
          ? `Notre client${clientNom ? ` ${clientNom}` : ''} a déjà passé commande et attend la soumission pour que nous lancions la production.`
          : `Notre client${clientNom ? ` ${clientNom}` : ''} attend la soumission.`,
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
  const pourCommande = commande ? `, pour votre commande N°${numero}${refClient ? ` (${refClient})` : ''}` : ''
  return {
    cible: 'client',
    destinataire: clientNom,
    recipients: trierContacts(fixed, (c) => Number(parSoumission ? c.envoi_soumission : c.envoi_commande) === 1),
    subject: commande
      ? `Votre choix de coloris — commande N°${numero}${refClient ? ` (${refClient})` : ''}`
      : `Votre choix de coloris — ${etat.libelle}${ref ? ` · ${ref}` : ''}`,
    body: [
      'Bonjour,',
      '',
      `Nous vous avons soumis${etat.attenteDepuis ? ` le ${jjmmaaaa(etat.attenteDepuis)}` : ''} notre proposition de coloris « ${etat.libelle} »${ref ? ` sur la référence ${ref}` : ''}${pourCommande}.`,
      '',
      commande
        ? 'Pourriez-vous nous faire part de votre choix ? Dès votre validation, nous lançons la production et vous confirmons le délai.'
        : 'Pourriez-vous nous faire part de votre choix ?',
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
