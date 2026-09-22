/**
 * Admin Pointage writes that are NOT the time clock itself: the salariés of
 * the pointeuse (`lst_salarie`) and the messages it shows them
 * (`lst_message`). The shift corrections live next to the tablet's writes in
 * lib/pointage-ecritures.ts, because they share its lock, its twin lookup and
 * its presence-journal contract.
 *
 * Legacy behaviour (FEN_Salariés / FEN_Nouveau_salarié / FEN_Messages /
 * FEN_Message, captures of 2026-09-21):
 *   - a salarié is never deleted, only flagged `is_deleted = 1` after a
 *     confirmation; the login (3 chars, unique key in the analysis) is refused
 *     when ANY row carries it, deleted ones included (« Ce login est déjà
 *     utilisé »);
 *   - a message always names ONE salarié (decision, 2026-09-21 — the legacy
 *     list showed « TOUS » for an orphan, the pointeuse never displayed one),
 *     with an end date defaulting to today + 7; edit = same row, delete =
 *     `is_deleted = 1`. The legacy stored HTML from a rich-text field; the
 *     port stores plain text — the tablet strips tags anyway
 *     (lib/pointage-etat.ts texteMessage).
 *
 * Positional INSERTs with an explicit MAX+1 id under a lock, like every other
 * write on this database (see the header of lib/pointage-ecritures.ts).
 * Runtime column orders (scripts/copy-pointage-prod-to-dev.ts):
 *   lst_salarie  id, nom, prenom, login, is_deleted, id_mps, useInRatio
 *   (useInRatio — « compte dans le ratio de production » — is a dead flag since
 *   2026-09-22: the ratio is no longer used; written 1 on create, never shown)
 *   lst_message  id, id_salarie, MESSAGE, date_fin, is_deleted
 */
import { pointageDb } from './hfsql-pointage.js'
import { createSerialLock } from './serial-lock.js'
import { sqlTextCp1252 } from './sql-cp1252.js'
import { SaisieInvalide, loginNormalise } from './pointage-admin.js'
import { loginPris, trouverMessage, trouverSalarieMemeSupprime, type MessageSalarie, type SalarieComplet } from './pointage.js'

const verrou = createSerialLock()

async function maxId(table: 'lst_salarie' | 'lst_message'): Promise<number> {
  const rows = await pointageDb.query<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${table}`)
  return Number(rows[0]?.m) || 0
}

/** A typed value as an HFSQL literal. cp1252 cannot hold an emoji or a stray
 *  U+FFFD: say so instead of storing a `?` (the lossless helper throws). */
function texte(value: string, champ: string): string {
  try {
    return sqlTextCp1252(value)
  } catch {
    throw new SaisieInvalide(`${champ} contient un caractère que la base ne peut pas enregistrer.`)
  }
}

function nomPropre(v: string, champ: string, max: number): string {
  const t = v.trim().replace(/\s+/g, ' ')
  if (!t) throw new SaisieInvalide(`${champ} est obligatoire.`)
  if (t.length > max) throw new SaisieInvalide(`${champ} dépasse ${max} caractères.`)
  return t
}

export interface SaisieSalarie {
  nom: string
  prenom: string
  login: string
  /** `mps.bonnetier.IDbonnetier`, 0 = no link (no photo, no TRS journal). */
  idMps: number
}

function normaliserSalarie(s: SaisieSalarie): SaisieSalarie {
  return {
    nom: nomPropre(s.nom, 'Le nom', 50),
    prenom: nomPropre(s.prenom, 'Le prénom', 50),
    login: loginNormalise(s.login),
    idMps: Number.isInteger(s.idMps) && s.idMps > 0 ? s.idMps : 0,
  }
}

export function creerSalarie(saisie: SaisieSalarie): Promise<SalarieComplet> {
  return verrou.run(async () => {
    const s = normaliserSalarie(saisie)
    if (await loginPris(s.login)) throw new SaisieInvalide('Ce login est déjà utilisé. Veuillez en choisir un autre.')
    const id = (await maxId('lst_salarie')) + 1
    await pointageDb.query(
      `INSERT INTO lst_salarie VALUES (${id}, ${texte(s.nom, 'Le nom')}, ${texte(s.prenom, 'Le prénom')}, '${s.login}', 0, ${s.idMps}, 1)`,
    )
    const cree = await trouverSalarieMemeSupprime(id)
    if (!cree) throw new Error(`lst_salarie: row ${id} not found after its INSERT`)
    return cree
  })
}

export function modifierSalarie(id: number, saisie: SaisieSalarie): Promise<SalarieComplet> {
  return verrou.run(async () => {
    const actuel = await trouverSalarieMemeSupprime(id)
    if (!actuel || actuel.supprime) throw new SaisieInvalide('Salarié inconnu.')
    const s = normaliserSalarie(saisie)
    if (s.login !== actuel.login && (await loginPris(s.login, id))) {
      throw new SaisieInvalide('Ce login est déjà utilisé. Veuillez en choisir un autre.')
    }
    await pointageDb.query(
      `UPDATE lst_salarie SET nom = ${texte(s.nom, 'Le nom')}, prenom = ${texte(s.prenom, 'Le prénom')}, login = '${s.login}',
       id_mps = ${s.idMps} WHERE id = ${id}`,
    )
    const relu = await trouverSalarieMemeSupprime(id)
    if (!relu) throw new Error(`lst_salarie: row ${id} vanished after its UPDATE`)
    return relu
  })
}

/** The legacy's Suppr key: the row stays, flagged. Its shifts stay too (the
 *  « En poste » table names deleted salariés). */
export function supprimerSalarie(id: number): Promise<void> {
  return verrou.run(async () => {
    const actuel = await trouverSalarieMemeSupprime(id)
    if (!actuel || actuel.supprime) throw new SaisieInvalide('Salarié inconnu.')
    await pointageDb.query(`UPDATE lst_salarie SET is_deleted = 1 WHERE id = ${id}`)
  })
}

export interface SaisieMessage {
  texte: string
  /** `YYYYMMDD` — last day the tablet shows the message. */
  dateFin: string
}

function normaliserMessage(m: SaisieMessage): SaisieMessage {
  const texte = m.texte.replace(/\r\n?/g, '\n').trim()
  if (!texte) throw new SaisieInvalide('Le message est vide.')
  if (texte.length > 4000) throw new SaisieInvalide('Le message dépasse 4 000 caractères.')
  if (!/^\d{8}$/.test(m.dateFin)) throw new SaisieInvalide('La date de fin d’affichage est invalide.')
  return { texte, dateFin: m.dateFin }
}

export function creerMessage(idSalarie: number, saisie: SaisieMessage): Promise<MessageSalarie> {
  return verrou.run(async () => {
    const s = await trouverSalarieMemeSupprime(idSalarie)
    if (!s || s.supprime) throw new SaisieInvalide('Salarié inconnu.')
    const m = normaliserMessage(saisie)
    const id = (await maxId('lst_message')) + 1
    await pointageDb.query(
      `INSERT INTO lst_message VALUES (${id}, ${idSalarie}, ${texte(m.texte, 'Le message')}, '${m.dateFin}', 0)`,
    )
    const cree = await trouverMessage(id)
    if (!cree) throw new Error(`lst_message: row ${id} not found after its INSERT`)
    return cree
  })
}

export function modifierMessage(id: number, saisie: SaisieMessage): Promise<MessageSalarie> {
  return verrou.run(async () => {
    const actuel = await trouverMessage(id)
    if (!actuel) throw new SaisieInvalide('Message inconnu.')
    const m = normaliserMessage(saisie)
    await pointageDb.query(
      `UPDATE lst_message SET MESSAGE = ${texte(m.texte, 'Le message')}, date_fin = '${m.dateFin}' WHERE id = ${id}`,
    )
    const relu = await trouverMessage(id)
    if (!relu) throw new Error(`lst_message: row ${id} vanished after its UPDATE`)
    return relu
  })
}

export function supprimerMessage(id: number): Promise<void> {
  return verrou.run(async () => {
    const actuel = await trouverMessage(id)
    if (!actuel) throw new SaisieInvalide('Message inconnu.')
    await pointageDb.query(`UPDATE lst_message SET is_deleted = 1 WHERE id = ${id}`)
  })
}

// ── Semaines : la validation d'une semaine (FEN_Lissage › BTN_Valider) ──
//
// One lst_lissage row per (salarié, année, semaine ISO): the seven typed
// (type, total) pairs and their sum in cumul_semaine — the figure the tablet's
// « Semaine N » and the payroll read. HEnregistre in the legacy: created the
// first time, UPDATED afterwards, so a validated week can be reopened.
// Runtime order: id, id_salarie, annee, num_semaine, lundi_type, lundi_total,
// … dimanche_type, dimanche_total, cumul_semaine, is_deleted.

import { JOURS_LISSAGE } from './pointage-admin.js'
import { lissageSemaine, type Lissage } from './pointage.js'

export interface SaisieLissage {
  /** Monday → Sunday. */
  jours: { type: string; lisseMin: number }[]
}

async function maxIdLissage(): Promise<number> {
  const rows = await pointageDb.query<{ m: number | null }>('SELECT MAX(id) AS m FROM lst_lissage')
  return Number(rows[0]?.m) || 0
}

function normaliserLissage(s: SaisieLissage): { type: string; lisseMin: number }[] {
  if (!Array.isArray(s.jours) || s.jours.length !== 7) throw new SaisieInvalide('Il faut les sept jours de la semaine.')
  return s.jours.map((j, i) => {
    const type = String(j.type ?? '').trim().toUpperCase()
    if (!/^[A-Z]$/.test(type)) throw new SaisieInvalide(`Le type du ${JOURS_LISSAGE[i]} doit être une lettre.`)
    const lisseMin = Number(j.lisseMin)
    if (!Number.isInteger(lisseMin) || lisseMin < 0 || lisseMin > 24 * 60) {
      throw new SaisieInvalide(`Le cumul lissé du ${JOURS_LISSAGE[i]} doit être entre 00:00 et 24:00.`)
    }
    return { type, lisseMin }
  })
}

export function validerLissage(idSalarie: number, annee: number, numero: number, saisie: SaisieLissage): Promise<Lissage> {
  return verrou.run(async () => {
    const s = await trouverSalarieMemeSupprime(idSalarie)
    if (!s) throw new SaisieInvalide('Salarié inconnu.')
    if (!Number.isInteger(annee) || annee < 2000 || annee > 2100 || !Number.isInteger(numero) || numero < 1 || numero > 53) {
      throw new SaisieInvalide('Semaine invalide.')
    }
    const jours = normaliserLissage(saisie)
    const cumul = jours.reduce((t, j) => t + j.lisseMin, 0)
    const existant = await lissageSemaine(idSalarie, annee, numero)
    if (existant) {
      await pointageDb.query(
        `UPDATE lst_lissage SET ${JOURS_LISSAGE.map((j, i) => `${j}_type = '${jours[i].type}', ${j}_total = ${jours[i].lisseMin}`).join(', ')},
         cumul_semaine = ${cumul} WHERE id = ${existant.id}`,
      )
    } else {
      const id = (await maxIdLissage()) + 1
      await pointageDb.query(
        `INSERT INTO lst_lissage VALUES (${id}, ${idSalarie}, ${annee}, ${numero}, ${jours.map((j) => `'${j.type}', ${j.lisseMin}`).join(', ')}, ${cumul}, 0)`,
      )
    }
    const relu = await lissageSemaine(idSalarie, annee, numero)
    if (!relu || relu.cumulSemaineMin !== cumul) throw new Error(`lst_lissage: week ${annee}-S${numero} of salarié ${idSalarie} not written`)
    return relu
  })
}

// ── Prévisionnel : lst_prev (FEN_MAJ_prévisionnel, FEN_Initialisation_prévisionnel) ──
//   lst_prev  id, id_salarie, annee, num_semaine, prev, commentaire, is_deleted
// and the yearly adjustments lst_info_sal_annee (FEN_Variables):
//   lst_info_sal_annee  id, id_salarie, annee, info, commentaire, is_deleted
// `info` is stored as the legacy typed it: signed minutes SUBTRACTED from the
// balance (a carry-over of ten extra hours was typed "-10:00"). The API takes
// the adjustment as its EFFECT on the balance (+600 = ten hours in credit) and
// stores the negation, which is what the legacy's Détails displayed (info × −1).

import { nbSemainesIso } from './pointage-admin.js'
import { infosAnnee, prevsAnnee, salariesAvecPrev, type InfoAnnee, type Prev } from './pointage.js'

async function maxIdDe(table: 'lst_prev' | 'lst_info_sal_annee'): Promise<number> {
  const rows = await pointageDb.query<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${table}`)
  return Number(rows[0]?.m) || 0
}

function minutesValides(v: unknown, champ: string, max = 24 * 7 * 60): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > max) throw new SaisieInvalide(`${champ} doit être entre 00:00 et ${Math.floor(max / 60)}:00.`)
  return n
}

function commentaireValide(v: unknown): string {
  const t = String(v ?? '').replace(/\r\n?/g, '\n').trim()
  if (t.length > 500) throw new SaisieInvalide('Le commentaire dépasse 500 caractères.')
  return t
}

function anneeValide(annee: number): number {
  if (!Number.isInteger(annee) || annee < 2000 || annee > 2100) throw new SaisieInvalide('Année invalide.')
  return annee
}

function effetValide(v: unknown): number {
  const n = Number(v)
  if (!Number.isInteger(n) || Math.abs(n) > 1000 * 60) throw new SaisieInvalide('L’ajustement doit être entre -1000:00 et +1000:00.')
  return n
}

/** One week's planned minutes + comment (create or update — HEnregistre). */
export function definirPrev(idSalarie: number, annee: number, numero: number, saisie: { prevMin: number; commentaire: string }): Promise<Prev> {
  return verrou.run(async () => {
    const s = await trouverSalarieMemeSupprime(idSalarie)
    if (!s) throw new SaisieInvalide('Salarié inconnu.')
    anneeValide(annee)
    if (!Number.isInteger(numero) || numero < 1 || numero > nbSemainesIso(annee)) throw new SaisieInvalide('Semaine invalide.')
    const prevMin = minutesValides(saisie.prevMin, 'Le prévisionnel de la semaine')
    const commentaire = commentaireValide(saisie.commentaire)
    const existant = (await prevsAnnee(idSalarie, annee)).find((p) => p.numero === numero)
    if (existant) {
      await pointageDb.query(`UPDATE lst_prev SET prev = ${prevMin}, commentaire = ${texte(commentaire, 'Le commentaire')} WHERE id = ${existant.id}`)
    } else {
      const id = (await maxIdDe('lst_prev')) + 1
      await pointageDb.query(
        `INSERT INTO lst_prev VALUES (${id}, ${idSalarie}, ${annee}, ${numero}, ${prevMin}, ${texte(commentaire, 'Le commentaire')}, 0)`,
      )
    }
    const relu = (await prevsAnnee(idSalarie, annee)).find((p) => p.numero === numero)
    if (!relu || relu.prevMin !== prevMin) throw new Error(`lst_prev: week ${annee}-S${numero} of salarié ${idSalarie} not written`)
    return relu
  })
}

export type SaisieInitialisation = { mode: 'heures'; prevMin: number } | { mode: 'copie'; sourceId: number }

/** FEN_Initialisation_prévisionnel: fill every week of an EMPTY year, with a
 *  fixed weekly total or a copy of another salarié's year (found weeks only). */
export function initialiserPrev(idSalarie: number, annee: number, saisie: SaisieInitialisation): Promise<Prev[]> {
  return verrou.run(async () => {
    const s = await trouverSalarieMemeSupprime(idSalarie)
    if (!s) throw new SaisieInvalide('Salarié inconnu.')
    anneeValide(annee)
    if ((await prevsAnnee(idSalarie, annee)).length > 0) {
      throw new SaisieInvalide(`Le prévisionnel ${annee} de ce salarié existe déjà : modifiez-le semaine par semaine.`)
    }
    const nb = nbSemainesIso(annee)
    let lignes: { numero: number; prevMin: number; commentaire: string }[]
    if (saisie.mode === 'heures') {
      const prevMin = minutesValides(saisie.prevMin, 'Le prévisionnel hebdomadaire')
      lignes = Array.from({ length: nb }, (_, i) => ({ numero: i + 1, prevMin, commentaire: '' }))
    } else {
      if (!(await salariesAvecPrev(annee)).includes(saisie.sourceId)) throw new SaisieInvalide('Le salarié à recopier n’a pas de prévisionnel cette année-là.')
      lignes = (await prevsAnnee(saisie.sourceId, annee)).filter((p) => p.numero <= nb).map((p) => ({ numero: p.numero, prevMin: p.prevMin, commentaire: p.commentaire }))
    }
    let id = await maxIdDe('lst_prev')
    for (const l of lignes) {
      id += 1
      await pointageDb.query(
        `INSERT INTO lst_prev VALUES (${id}, ${idSalarie}, ${annee}, ${l.numero}, ${l.prevMin}, ${texte(l.commentaire, 'Le commentaire')}, 0)`,
      )
    }
    const relu = await prevsAnnee(idSalarie, annee)
    if (relu.length !== lignes.length) throw new Error(`lst_prev: ${relu.length}/${lignes.length} weeks written for ${annee}`)
    return relu
  })
}

/** A yearly adjustment, given as its EFFECT on the balance (`soldeMin`, signed). */
export function creerInfo(idSalarie: number, annee: number, saisie: { soldeMin: number; commentaire: string }): Promise<InfoAnnee> {
  return verrou.run(async () => {
    const s = await trouverSalarieMemeSupprime(idSalarie)
    if (!s) throw new SaisieInvalide('Salarié inconnu.')
    anneeValide(annee)
    const info = -effetValide(saisie.soldeMin)
    const commentaire = commentaireValide(saisie.commentaire)
    const id = (await maxIdDe('lst_info_sal_annee')) + 1
    await pointageDb.query(
      `INSERT INTO lst_info_sal_annee VALUES (${id}, ${idSalarie}, ${annee}, ${info}, ${texte(commentaire, 'Le commentaire')}, 0)`,
    )
    const relu = (await infosAnnee(idSalarie, annee)).find((i) => i.id === id)
    if (!relu) throw new Error(`lst_info_sal_annee: row ${id} not found after its INSERT`)
    return relu
  })
}

export function modifierInfo(id: number, saisie: { soldeMin: number; commentaire: string }): Promise<InfoAnnee> {
  return verrou.run(async () => {
    const rows = await pointageDb.query<Record<string, unknown>>(`SELECT id, id_salarie, annee FROM lst_info_sal_annee WHERE id = ${id} AND is_deleted = 0`)
    if (!rows.length) throw new SaisieInvalide('Variable inconnue.')
    const info = -effetValide(saisie.soldeMin)
    const commentaire = commentaireValide(saisie.commentaire)
    await pointageDb.query(`UPDATE lst_info_sal_annee SET info = ${info}, commentaire = ${texte(commentaire, 'Le commentaire')} WHERE id = ${id}`)
    const relu = (await infosAnnee(Number(rows[0].id_salarie), Number(rows[0].annee))).find((i) => i.id === id)
    if (!relu) throw new Error(`lst_info_sal_annee: row ${id} vanished after its UPDATE`)
    return relu
  })
}

export function supprimerInfo(id: number): Promise<void> {
  return verrou.run(async () => {
    const rows = await pointageDb.query<Record<string, unknown>>(`SELECT id FROM lst_info_sal_annee WHERE id = ${id} AND is_deleted = 0`)
    if (!rows.length) throw new SaisieInvalide('Variable inconnue.')
    await pointageDb.query(`UPDATE lst_info_sal_annee SET is_deleted = 1 WHERE id = ${id}`)
  })
}
