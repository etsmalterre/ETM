// Admin Pointage — the office's side of the time clock, from the TRM ERP's
// menu « Pointage » (port of the WinDev Admin Pointage, 2026-09-21; plan
// ~/.claude/plans/admin-pointage.md, dossier TRM/claude_doc/admin-pointage.md).
// Same legacy `pointage` database as the tablet (routes/pointage.ts), a
// DIFFERENT caller: a user session (mps_uid) holding TRM's own keys —
// view_pointage on every read, edit_pointage on every write. An enrolled
// tablet has no business here and an admin session is not enough for a
// non-admin: the legacy had no login at all, hours are personal data.
//
//   GET    /salaries                         every salarié, deleted ones flagged, with the bonnetier link
//   GET    /bonnetiers                       the picker for that link (mps.bonnetier)
//   POST   /salaries                         { nom, prenom, login, idMps }
//   PUT    /salaries/:id                     same body
//   DELETE /salaries/:id                     soft delete
//   GET    /salaries/:id/messages            every message still on file, expired included
//   POST   /salaries/:id/messages            { texte, dateFin }
//   PUT    /messages/:id                     { texte, dateFin }
//   DELETE /messages/:id                     soft delete
//   GET    /en-poste                         every open shift, whatever its day (legacy TABLE_Pointage)
//   GET    /horaires?du=&au=&salarie=        the shifts of a period, newest first
//   POST   /horaires                         { idSalarie, jour, heures } → 201 the row
//   PATCH  /horaires/:id                     { heures } — only the hours that change, null clears
//   DELETE /horaires/:id                     soft delete (twin flagged, journal untouched)
// A refused correction answers 400 { error: 'saisie_invalide', message }.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { isEffectiveAdmin } from '../lib/auth.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import type { TrmPermissionKey } from '../lib/permission-keys-trm.js'
import { selectBonnetiers } from '../lib/production-trm.js'
import {
  COLONNES_HEURE,
  POSTE_OUVERT_MAX_S,
  cumulPausesMin,
  jourParis,
  type ColonneHeure,
  type LigneHoraire,
} from '../lib/pointage-etat.js'
import { HEURE_RE, SaisieInvalide, periodeValide, presenceMin } from '../lib/pointage-admin.js'
import {
  lignesEnPoste,
  lignesPeriode,
  messagesDuSalarie,
  tousLesSalariesComplets,
  trouverLigne,
  trouverMessage,
  trouverSalarieMemeSupprime,
  type MessageSalarie,
  type SalarieComplet,
} from '../lib/pointage.js'
import {
  corrigerLigneAdmin,
  creerLigneAdmin,
  supprimerLigneAdmin,
  type ResultatCorrection,
} from '../lib/pointage-ecritures.js'
import {
  creerMessage,
  creerSalarie,
  modifierMessage,
  modifierSalarie,
  supprimerMessage,
  supprimerSalarie,
} from '../lib/pointage-admin-ecritures.js'

export const pointageAdminRouter: RouterType = Router()

// ── Gates ──

async function gate(req: Request, res: Response, key: TrmPermissionKey): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const ok = await trmUserHasPermission(req.userId, isEffectiveAdmin(req), key)
  if (!ok) res.status(403).json({ error: `permission denied: ${key}` })
  return ok
}
const lecture = (req: Request, res: Response) => gate(req, res, 'view_pointage')
const ecriture = (req: Request, res: Response) => gate(req, res, 'edit_pointage')

function erreur(res: Response, label: string, err: unknown): void {
  if (err instanceof SaisieInvalide) {
    res.status(400).json({ error: err.code, message: err.message })
    return
  }
  console.error(`Error in /pointage-admin ${label}:`, err)
  res.status(500).json({ error: 'Internal server error' })
}

function idDeLaRoute(req: Request, res: Response, nom = 'id'): number | null {
  const id = parseInt(String(req.params[nom]), 10)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' })
    return null
  }
  return id
}

function validation(res: Response, issues: unknown): void {
  res.status(400).json({ error: 'Validation failed', details: issues })
}

// ── Shapes ──

const ms = (s: number) => (s > 0 ? s * 1000 : null)

export interface SalarieRef {
  id: number
  nom: string
  prenom: string
  supprime: boolean
}

const salarieRef = (s: SalarieComplet | undefined, id: number): SalarieRef =>
  s ? { id: s.id, nom: s.nom, prenom: s.prenom, supprime: s.supprime } : { id, nom: '', prenom: '', supprime: true }

const salarieJson = (s: SalarieComplet) => ({
  id: s.id,
  nom: s.nom,
  prenom: s.prenom,
  login: s.login,
  idMps: s.idMps,
  supprime: s.supprime,
  photo: s.idMps > 0,
})

function horaireJson(l: LigneHoraire, salaries: Map<number, SalarieComplet>, maintenantS: number, sync?: Omit<ResultatCorrection, 'ligneId'>) {
  const ouverte = l.fin === 0
  return {
    id: l.id,
    jour: l.jour,
    salarie: salarieRef(salaries.get(l.idSalarie), l.idSalarie),
    debutMs: ms(l.debut),
    debutPause1Ms: ms(l.debut_pause1),
    finPause1Ms: ms(l.fin_pause1),
    debutPause2Ms: ms(l.debut_pause2),
    finPause2Ms: ms(l.fin_pause2),
    finMs: ms(l.fin),
    /** Finished pauses only — the legacy `cumul_pause`. */
    pausesMin: cumulPausesMin(l),
    /** Gross `fin − debut` — the legacy `cumul_presence`; null while open. */
    presenceMin: presenceMin(l),
    ouverte,
    /** Open for longer than the tablet continues: the office's to close. */
    nonFermee: ouverte && maintenantS - l.debut > POSTE_OUVERT_MAX_S,
    ...(sync ? { sync } : {}),
  }
}

const messageJson = (m: MessageSalarie, jour: string) => ({ ...m, expire: m.dateFin < jour })

async function salariesParId(): Promise<Map<number, SalarieComplet>> {
  return new Map((await tousLesSalariesComplets()).map((s) => [s.id, s]))
}

// ── Salariés ──

pointageAdminRouter.get('/salaries', async (req: Request, res: Response) => {
  try {
    if (!(await lecture(req, res))) return
    const [salaries, bonnetiers] = await Promise.all([tousLesSalariesComplets(), selectBonnetiers()])
    const noms = new Map(bonnetiers.map((b) => [b.id, [b.prenom, b.nom].filter(Boolean).join(' ')]))
    res.json(salaries.map((s) => ({ ...salarieJson(s), bonnetier: s.idMps > 0 ? (noms.get(s.idMps) ?? `#${s.idMps}`) : null })))
  } catch (err) {
    erreur(res, 'salaries', err)
  }
})

pointageAdminRouter.get('/bonnetiers', async (req: Request, res: Response) => {
  try {
    if (!(await lecture(req, res))) return
    const rows = await selectBonnetiers()
    res.json(
      rows
        .map((b) => ({ id: b.id, nom: b.nom, prenom: b.prenom, archive: b.archive !== 0 }))
        .sort((a, b) => a.nom.localeCompare(b.nom, 'fr') || a.prenom.localeCompare(b.prenom, 'fr')),
    )
  } catch (err) {
    erreur(res, 'bonnetiers', err)
  }
})

const salarieBody = z
  .object({
    nom: z.string().max(50),
    prenom: z.string().max(50),
    login: z.string().max(3),
    idMps: z.number().int().min(0),
  })
  .strict()

pointageAdminRouter.post('/salaries', async (req: Request, res: Response) => {
  try {
    if (!(await ecriture(req, res))) return
    const parsed = salarieBody.safeParse(req.body)
    if (!parsed.success) return validation(res, parsed.error.issues)
    res.status(201).json(salarieJson(await creerSalarie(parsed.data)))
  } catch (err) {
    erreur(res, 'salaries POST', err)
  }
})

pointageAdminRouter.put('/salaries/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ecriture(req, res))) return
    const id = idDeLaRoute(req, res)
    if (id === null) return
    const parsed = salarieBody.safeParse(req.body)
    if (!parsed.success) return validation(res, parsed.error.issues)
    res.json(salarieJson(await modifierSalarie(id, parsed.data)))
  } catch (err) {
    erreur(res, 'salaries PUT', err)
  }
})

pointageAdminRouter.delete('/salaries/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ecriture(req, res))) return
    const id = idDeLaRoute(req, res)
    if (id === null) return
    await supprimerSalarie(id)
    res.status(204).end()
  } catch (err) {
    erreur(res, 'salaries DELETE', err)
  }
})

// ── Messages ──

pointageAdminRouter.get('/salaries/:id/messages', async (req: Request, res: Response) => {
  try {
    if (!(await lecture(req, res))) return
    const id = idDeLaRoute(req, res)
    if (id === null) return
    const jour = jourParis(Date.now())
    res.json((await messagesDuSalarie(id)).map((m) => messageJson(m, jour)))
  } catch (err) {
    erreur(res, 'messages GET', err)
  }
})

const messageBody = z.object({ texte: z.string().max(4000), dateFin: z.string().regex(/^\d{8}$/) }).strict()

pointageAdminRouter.post('/salaries/:id/messages', async (req: Request, res: Response) => {
  try {
    if (!(await ecriture(req, res))) return
    const id = idDeLaRoute(req, res)
    if (id === null) return
    const parsed = messageBody.safeParse(req.body)
    if (!parsed.success) return validation(res, parsed.error.issues)
    res.status(201).json(messageJson(await creerMessage(id, parsed.data), jourParis(Date.now())))
  } catch (err) {
    erreur(res, 'messages POST', err)
  }
})

pointageAdminRouter.put('/messages/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ecriture(req, res))) return
    const id = idDeLaRoute(req, res)
    if (id === null) return
    const parsed = messageBody.safeParse(req.body)
    if (!parsed.success) return validation(res, parsed.error.issues)
    if (!(await trouverMessage(id))) {
      res.status(404).json({ error: 'message_inconnu' })
      return
    }
    res.json(messageJson(await modifierMessage(id, parsed.data), jourParis(Date.now())))
  } catch (err) {
    erreur(res, 'messages PUT', err)
  }
})

pointageAdminRouter.delete('/messages/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ecriture(req, res))) return
    const id = idDeLaRoute(req, res)
    if (id === null) return
    await supprimerMessage(id)
    res.status(204).end()
  } catch (err) {
    erreur(res, 'messages DELETE', err)
  }
})

// ── Horaires ──

pointageAdminRouter.get('/en-poste', async (req: Request, res: Response) => {
  try {
    if (!(await lecture(req, res))) return
    const maintenantMs = Date.now()
    const maintenantS = Math.floor(maintenantMs / 1000)
    const [lignes, salaries] = await Promise.all([lignesEnPoste(), salariesParId()])
    res.json({
      jour: jourParis(maintenantMs),
      maintenantMs,
      lignes: [...lignes].reverse().map((l) => horaireJson(l, salaries, maintenantS)),
    })
  } catch (err) {
    erreur(res, 'en-poste', err)
  }
})

pointageAdminRouter.get('/horaires', async (req: Request, res: Response) => {
  try {
    if (!(await lecture(req, res))) return
    const { du, au } = periodeValide(req.query.du, req.query.au)
    const salarie = req.query.salarie ? parseInt(String(req.query.salarie), 10) : 0
    if (req.query.salarie && (!Number.isInteger(salarie) || salarie <= 0)) {
      res.status(400).json({ error: 'Invalid salarie' })
      return
    }
    const maintenantMs = Date.now()
    const maintenantS = Math.floor(maintenantMs / 1000)
    const [lignes, salaries] = await Promise.all([lignesPeriode(du, au, salarie), salariesParId()])
    res.json({ du, au, maintenantMs, lignes: lignes.map((l) => horaireJson(l, salaries, maintenantS)) })
  } catch (err) {
    erreur(res, 'horaires GET', err)
  }
})

/** « HH:MM » sets an hour, null clears it (never the start), absent keeps it. */
const heureSchema = z.string().regex(HEURE_RE).nullable()
const heuresSchema = z
  .object(Object.fromEntries(COLONNES_HEURE.map((c) => [c, heureSchema.optional()])) as Record<ColonneHeure, z.ZodOptional<typeof heureSchema>>)
  .strict()

const creerHoraireBody = z
  .object({
    idSalarie: z.number().int().positive(),
    /** `YYYYMMDD` — the shift's day (a night shift keeps its evening). */
    jour: z.string().regex(/^\d{8}$/),
    heures: heuresSchema,
  })
  .strict()

async function reponseHoraire(res: Response, ligneId: number, sync: Omit<ResultatCorrection, 'ligneId'>, status = 200): Promise<void> {
  const [ligne, salaries] = await Promise.all([trouverLigne(ligneId), salariesParId()])
  if (!ligne) {
    res.status(500).json({ error: 'Internal server error' })
    return
  }
  res.status(status).json(horaireJson(ligne, salaries, Math.floor(Date.now() / 1000), sync))
}

pointageAdminRouter.post('/horaires', async (req: Request, res: Response) => {
  try {
    if (!(await ecriture(req, res))) return
    const parsed = creerHoraireBody.safeParse(req.body)
    if (!parsed.success) return validation(res, parsed.error.issues)
    const s = await trouverSalarieMemeSupprime(parsed.data.idSalarie)
    if (!s || s.supprime) {
      res.status(404).json({ error: 'salarie_inconnu' })
      return
    }
    const r = await creerLigneAdmin(s, parsed.data.jour, parsed.data.heures)
    await reponseHoraire(res, r.ligneId, { lstPointage: r.lstPointage, mps: r.mps }, 201)
  } catch (err) {
    erreur(res, 'horaires POST', err)
  }
})

const corrigerHoraireBody = z.object({ heures: heuresSchema }).strict()

pointageAdminRouter.patch('/horaires/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ecriture(req, res))) return
    const id = idDeLaRoute(req, res)
    if (id === null) return
    const parsed = corrigerHoraireBody.safeParse(req.body)
    if (!parsed.success) return validation(res, parsed.error.issues)
    const ligne = await trouverLigne(id)
    if (!ligne) {
      res.status(404).json({ error: 'horaire_inconnu' })
      return
    }
    const s = await trouverSalarieMemeSupprime(ligne.idSalarie)
    if (!s) {
      res.status(404).json({ error: 'salarie_inconnu' })
      return
    }
    const r = await corrigerLigneAdmin(s, id, parsed.data.heures)
    await reponseHoraire(res, r.ligneId, { lstPointage: r.lstPointage, mps: r.mps })
  } catch (err) {
    erreur(res, 'horaires PATCH', err)
  }
})

pointageAdminRouter.delete('/horaires/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ecriture(req, res))) return
    const id = idDeLaRoute(req, res)
    if (id === null) return
    const ligne = await trouverLigne(id)
    if (!ligne) {
      res.status(404).json({ error: 'horaire_inconnu' })
      return
    }
    const s = await trouverSalarieMemeSupprime(ligne.idSalarie)
    if (!s) {
      res.status(404).json({ error: 'salarie_inconnu' })
      return
    }
    const r = await supprimerLigneAdmin(s, id)
    res.json({ id, sync: r })
  } catch (err) {
    erreur(res, 'horaires DELETE', err)
  }
})

// ── Semaines — FEN_Contrôles (the year grid) + FEN_Lissage (one week) ──
//   GET /lissage/semaines?salarie=&annee=   the grid: one cell per ISO week, red = to validate, + the balance
//   GET /lissage/semaine?salarie=&annee=&numero=   the seven days with proposals or stored values
//   PUT /lissage/semaine { idSalarie, annee, numero, jours: [{ type, lisseMin }] × 7 }   validate (create or update)

import {
  JOURS_LISSAGE,
  cumulJourMin,
  lissePropose,
  lundiIso,
  nbSemainesIso,
  semaineDetail,
  semaineMaxControle,
  semaineMinControle,
  typePropose,
} from '../lib/pointage-admin.js'
import { infosAnnee, lissageSemaine, lissagesAnnee, premierPointage, prevsAnnee } from '../lib/pointage.js'
import { validerLissage } from '../lib/pointage-admin-ecritures.js'

function entierQuery(v: unknown, min: number, max: number): number | null {
  const n = parseInt(String(v ?? ''), 10)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

/** FEN_Contrôles' BTN_Détail, as figures: planned and done up to `semaine`,
 *  the yearly adjustments, the balance (= the tablet's « Solde annuel »). */
async function bilan(idSalarie: number, annee: number, semaine: number) {
  const [lissages, prevs, infos] = await Promise.all([lissagesAnnee(idSalarie, annee), prevsAnnee(idSalarie, annee), infosAnnee(idSalarie, annee)])
  const realiseMin = lissages.filter((l) => l.numero <= semaine).reduce((t, l) => t + l.cumulSemaineMin, 0)
  const prevuMin = prevs.filter((p) => p.numero <= semaine).reduce((t, p) => t + p.prevMin, 0)
  const ajustementMin = infos.reduce((t, i) => t + i.infoMin, 0)
  return {
    semaine,
    prevuMin,
    realiseMin,
    /** Shown as the legacy did: `info × −1` next to its comment. */
    infos: infos.map((i) => ({ id: i.id, commentaire: i.commentaire, min: -i.infoMin })),
    totalMin: realiseMin - prevuMin - ajustementMin,
  }
}

pointageAdminRouter.get('/lissage/semaines', async (req: Request, res: Response) => {
  try {
    if (!(await lecture(req, res))) return
    const idSalarie = entierQuery(req.query.salarie, 1, 1e9)
    const annee = entierQuery(req.query.annee, 2000, 2100)
    if (idSalarie === null || annee === null) {
      res.status(400).json({ error: 'Invalid salarie/annee' })
      return
    }
    const maintenantMs = Date.now()
    const [lissages, premier] = await Promise.all([lissagesAnnee(idSalarie, annee), premierPointage(idSalarie)])
    const semMax = semaineMaxControle(annee, maintenantMs)
    const semMin = semaineMinControle(annee, premier, semMax)
    const parNumero = new Map(lissages.map((l) => [l.numero, l]))
    const nb = nbSemainesIso(annee)
    const semaines = []
    for (let n = 1; n <= nb; n++) {
      const l = parNumero.get(n)
      semaines.push({
        numero: n,
        lundi: lundiIso(annee, n),
        cumulMin: l ? l.cumulSemaineMin : null,
        /** In the validation window and not yet validated — the legacy's red cell. */
        aValider: !l && n > semMin && n <= semMax,
      })
    }
    res.json({ annee, semMin, semMax, nbSemaines: nb, semaines, bilan: await bilan(idSalarie, annee, semaineDetail(annee, maintenantMs)) })
  } catch (err) {
    erreur(res, 'lissage/semaines', err)
  }
})

async function semaineJson(idSalarie: number, annee: number, numero: number) {
  const lundi = lundiIso(annee, numero)
  const dimanche = decalerJour(lundi, 6)
  const [lignes, stocke] = await Promise.all([lignesPeriode(lundi, dimanche, idSalarie), lissageSemaine(idSalarie, annee, numero)])
  const jours = JOURS_LISSAGE.map((libelle, i) => {
    const jour = decalerJour(lundi, i)
    const duJour = lignes
      .filter((l) => l.jour === jour && l.fin > 0)
      .sort((a, b) => a.debut - b.debut)
    const cumulMin = cumulJourMin(duJour)
    return {
      libelle,
      jour,
      segments: duJour.map((l) => ({ id: l.id, debutMs: l.debut * 1000, finMs: l.fin * 1000 })),
      cumulMin,
      lisseMin: stocke ? stocke.jours[i].totalMin : lissePropose(cumulMin),
      type: stocke ? stocke.jours[i].type || 'J' : typePropose(duJour[0]?.debut ?? null),
    }
  })
  return {
    idSalarie,
    annee,
    numero,
    lundi,
    /** Already validated: the lissé values and types are the stored ones. */
    existe: stocke !== null,
    jours,
    cumulSemaineMin: jours.reduce((t, j) => t + j.lisseMin, 0),
  }
}

function decalerJour(jour: string, jours: number): string {
  const t = new Date(Date.UTC(+jour.slice(0, 4), +jour.slice(4, 6) - 1, +jour.slice(6, 8)) + jours * 86_400_000)
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`
}

pointageAdminRouter.get('/lissage/semaine', async (req: Request, res: Response) => {
  try {
    if (!(await lecture(req, res))) return
    const idSalarie = entierQuery(req.query.salarie, 1, 1e9)
    const annee = entierQuery(req.query.annee, 2000, 2100)
    const numero = entierQuery(req.query.numero, 1, 53)
    if (idSalarie === null || annee === null || numero === null) {
      res.status(400).json({ error: 'Invalid salarie/annee/numero' })
      return
    }
    res.json(await semaineJson(idSalarie, annee, numero))
  } catch (err) {
    erreur(res, 'lissage/semaine GET', err)
  }
})

const lissageBody = z
  .object({
    idSalarie: z.number().int().positive(),
    annee: z.number().int().min(2000).max(2100),
    numero: z.number().int().min(1).max(53),
    jours: z.array(z.object({ type: z.string().max(1), lisseMin: z.number().int().min(0).max(1440) }).strict()).length(7),
  })
  .strict()

pointageAdminRouter.put('/lissage/semaine', async (req: Request, res: Response) => {
  try {
    if (!(await ecriture(req, res))) return
    const parsed = lissageBody.safeParse(req.body)
    if (!parsed.success) return validation(res, parsed.error.issues)
    const { idSalarie, annee, numero, jours } = parsed.data
    await validerLissage(idSalarie, annee, numero, { jours })
    res.json(await semaineJson(idSalarie, annee, numero))
  } catch (err) {
    erreur(res, 'lissage/semaine PUT', err)
  }
})
