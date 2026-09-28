// RH menu (ETM): employees and their workload — Vincent and Isabelle only.
//
// Every route but the lock ones goes through requireRh() (lib/rh-acces.ts):
// 404 for anyone not on the list, 401 `rh_verrouille` until the person has
// typed their code RH. The data lives in PostgreSQL `rh` (lib/rh-store.ts).
//
//   GET    /api/rh/acces                         — anyone: may I, and am I unlocked?
//   POST   /api/rh/deverrouiller   { code }      — sets the mps_rh cookie
//   POST   /api/rh/verrouiller                   — clears it
//   GET    /api/rh/employes
//   POST   /api/rh/employes        { prenom, nom }
//   GET    /api/rh/employes/:id
//   PUT    /api/rh/employes/:id
//   DELETE /api/rh/employes/:id
//   GET|PUT|DELETE /api/rh/employes/:id/photo
//   GET    /api/rh/employes/:id/charge[?version=]
//   POST   /api/rh/employes/:id/charge   { dateReleve, note, taches[] }
//   DELETE /api/rh/employes/:id/charge/:versionId
//   GET    /api/rh/employes/:id/charge/evolution[?mois=12]
//   GET    /api/rh/indicateurs

import { Router, type Request, type Response, type NextFunction, type Router as RouterType } from 'express'
import multer from 'multer'
import sharp from 'sharp'
import { z } from 'zod'
import {
  requireRh,
  personneRhDeUtilisateur,
  lireSessionRh,
  signerSessionRh,
  rhCookieOptions,
  RH_COOKIE_NAME,
  verifierCode,
  blocageRestant,
  noterEchec,
  noterSucces,
} from '../lib/rh-acces.js'
import {
  RhIndisponible,
  rhConfigure,
  journaliser,
  lireCode,
  listerEmployes,
  lireEmploye,
  creerEmploye,
  modifierEmploye,
  supprimerEmploye,
  lirePhoto,
  ecrirePhoto,
  listerVersions,
  versionsCompletes,
  enregistrerVersion,
  supprimerVersion,
} from '../lib/rh-store.js'
import { normaliserTache, estMesuree, heuresSemaine, totauxSimples, evolutionMensuelle, moisListe, volumeLisse, lundiDe } from '../lib/rh-charge.js'
import { INDICATEURS, volumesPour } from '../lib/rh-indicateurs.js'

export const rhRouter: RouterType = Router()

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

/** Wrap a handler: RhIndisponible → 503, anything else → 500. */
function h(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err) => {
      if (err instanceof RhIndisponible) {
        res.status(503).json({ error: 'rh_indisponible', message: 'La base RH n’est pas configurée sur ce serveur.' })
        return
      }
      console.error(`rh ${req.method} ${req.path}:`, err)
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
    })
  }
}

const idParam = (req: Request) => {
  const id = Number(req.params.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

// ── Lock ─────────────────────────────────────────────────

rhRouter.get('/acces', h(async (req, res) => {
  const personne = await personneRhDeUtilisateur(req.userId)
  if (!personne) {
    res.json({ autorise: false })
    return
  }
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {}
  const deverrouille = lireSessionRh(cookies[RH_COOKIE_NAME]) === personne.cle
  const codeDefini = rhConfigure() ? (await lireCode(personne.cle)) !== null : false
  res.json({ autorise: true, personne: personne.label, deverrouille, codeDefini, configure: rhConfigure() })
}))

rhRouter.post('/deverrouiller', h(async (req, res) => {
  const personne = await personneRhDeUtilisateur(req.userId)
  if (!personne) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  const attente = blocageRestant(personne.cle)
  if (attente > 0) {
    res.status(429).json({
      error: 'trop_d_essais',
      message: `Trop d’essais. Réessayez dans ${Math.ceil(attente / 60_000)} min.`,
    })
    return
  }
  const code = String(req.body?.code ?? '')
  const stocke = await lireCode(personne.cle)
  if (!stocke) {
    res.status(409).json({
      error: 'code_non_defini',
      message: 'Aucun code RH n’est encore défini pour vous. Il se définit sur le serveur (scripts/rh-code.ts).',
    })
    return
  }
  if (!code || !verifierCode(code, stocke.hash, stocke.sel)) {
    noterEchec(personne.cle)
    await journaliser(personne.cle, 'echec_code', req.ip)
    res.status(403).json({ error: 'code_invalide', message: 'Code incorrect.' })
    return
  }
  noterSucces(personne.cle)
  await journaliser(personne.cle, 'deverrouillage', req.ip)
  res.cookie(RH_COOKIE_NAME, signerSessionRh(personne.cle), rhCookieOptions())
  res.json({ ok: true })
}))

rhRouter.post('/verrouiller', (_req, res) => {
  res.clearCookie(RH_COOKIE_NAME, { httpOnly: true, sameSite: 'lax', path: '/' })
  res.json({ ok: true })
})

// Everything below needs the unlocked person.
rhRouter.use(requireRh())

// ── Employees ────────────────────────────────────────────

rhRouter.get('/employes', h(async (_req, res) => {
  res.json(await listerEmployes())
}))

rhRouter.get('/employes/:id', h(async (req, res) => {
  const id = idParam(req)
  const e = id ? await lireEmploye(id) : null
  if (!e) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.json(e)
}))

const CreateSchema = z.object({ prenom: z.string().trim().min(1).max(100), nom: z.string().trim().max(100).default('') })

rhRouter.post('/employes', h(async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues })
    return
  }
  const id = await creerEmploye(parsed.data.prenom, parsed.data.nom, req.personneRh!.cle)
  await journaliser(req.personneRh!.cle, 'creation_employe', String(id))
  res.status(201).json({ id })
}))

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()
const UpdateSchema = z.object({
  prenom: z.string().trim().min(1).max(100),
  nom: z.string().trim().max(100),
  poste: z.string().trim().max(200),
  email: z.union([z.literal(''), z.string().trim().email().max(200)]),
  dateEmbauche: DATE,
  dateNaissance: DATE,
  idutilisateur: z.number().int().positive().nullable(),
  heuresContrat: z.number().positive().max(60),
})

rhRouter.put('/employes/:id', h(async (req, res) => {
  const id = idParam(req)
  const parsed = UpdateSchema.safeParse(req.body)
  if (!id || !parsed.success) {
    res.status(400).json({ error: 'Validation failed', issues: parsed.success ? undefined : parsed.error.issues })
    return
  }
  if (!(await modifierEmploye(id, parsed.data, req.personneRh!.cle))) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  await journaliser(req.personneRh!.cle, 'modification_employe', String(id))
  res.json(await lireEmploye(id))
}))

rhRouter.delete('/employes/:id', h(async (req, res) => {
  const id = idParam(req)
  if (!id || !(await supprimerEmploye(id))) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  await journaliser(req.personneRh!.cle, 'suppression_employe', String(id))
  res.json({ ok: true })
}))

// ── Photo (stored resized in PostgreSQL, never on disk) ──

rhRouter.get('/employes/:id/photo', h(async (req, res) => {
  const id = idParam(req)
  const photo = id ? await lirePhoto(id) : null
  if (!photo) {
    res.status(404).json({ error: 'No photo' })
    return
  }
  res.setHeader('Content-Type', 'image/jpeg')
  // Private: personal data, never kept by a shared cache. The URL carries
  // ?v=<photoMaj>, so the browser may keep it for the session.
  res.setHeader('Cache-Control', 'private, max-age=3600')
  // The dev web app runs on another port: helmet's same-origin default would
  // block the <img>. Still gated by requireRh() above.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.end(photo)
}))

rhRouter.put('/employes/:id/photo', upload.single('photo'), h(async (req, res) => {
  const id = idParam(req)
  if (!id || !req.file || req.file.buffer.length === 0) {
    res.status(400).json({ error: 'missing photo file' })
    return
  }
  let jpeg: Buffer
  try {
    jpeg = await sharp(req.file.buffer)
      .rotate()
      .resize(512, 512, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 85 })
      .toBuffer()
  } catch {
    res.status(400).json({ error: 'photo_illisible', message: 'Ce fichier n’est pas une image lisible.' })
    return
  }
  const photoMaj = await ecrirePhoto(id, jpeg, req.personneRh!.cle)
  if (!photoMaj) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.json({ photoMaj })
}))

rhRouter.delete('/employes/:id/photo', h(async (req, res) => {
  const id = idParam(req)
  if (id) await ecrirePhoto(id, null, req.personneRh!.cle)
  res.json({ photoMaj: null })
}))

// ── Workload ─────────────────────────────────────────────

/** Monday of the last complete week: the current one is still being counted. */
const derniereSemaineComplete = () => lundiDe(new Date(Date.now() - 7 * 86_400_000))

rhRouter.get('/employes/:id/charge', h(async (req, res) => {
  const id = idParam(req)
  const employe = id ? await lireEmploye(id) : null
  if (!employe) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  const versions = await versionsCompletes(employe.id)
  const derniere = versions[versions.length - 1] ?? null
  const wanted = Number(req.query.version)
  const v = (wanted && versions.find((x) => x.id === wanted)) || derniere
  if (!v) {
    res.json({ versions: await listerVersions(employe.id), version: null })
    return
  }
  // The latest relevé shows its CURRENT value: a measured task takes the
  // volume of the last 4 complete weeks. An older relevé shows what was typed.
  const actuelle = v.id === derniere?.id
  const volumes = actuelle ? await volumesPour(v.taches.filter(estMesuree).map((t) => t.indicateur!)) : new Map()
  const semaine = derniereSemaineComplete()
  const heures = actuelle ? heuresSemaine(v.taches, volumes, semaine, 4) : v.taches.map((t) => t.heures)
  res.json({
    versions: await listerVersions(employe.id),
    version: {
      id: v.id,
      dateReleve: v.dateReleve,
      actuelle,
      taches: v.taches.map((t, i) => {
        const vol = actuelle && estMesuree(t) ? volumes.get(t.indicateur!) : undefined
        return {
          ...t,
          heuresActuelles: heures[i],
          volumeHebdo: vol ? Math.round(volumeLisse(vol, semaine, 4) * 10) / 10 : null,
        }
      }),
      totaux: totauxSimples(v.taches, heures),
    },
  })
}))

const TacheSchema = z.object({
  nom: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(''),
  methode: z.string().max(4000).default(''),
  heures: z.number().min(0).max(60),
  automatisable: z.enum(['oui', 'partiel', 'non', 'inconnu']),
  automatise: z.boolean(),
  categorie: z.enum(['tache', 'improductivite_structurelle']),
  indicateur: z.string().nullable(),
  minutesParUnite: z.number().min(0).max(600).nullable(),
})
const VersionSchema = z.object({
  dateReleve: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().max(4000).default(''),
  taches: z.array(TacheSchema).max(100),
})

rhRouter.post('/employes/:id/charge', h(async (req, res) => {
  const id = idParam(req)
  const parsed = VersionSchema.safeParse(req.body)
  if (!id || !parsed.success) {
    res.status(400).json({ error: 'Validation failed', issues: parsed.success ? undefined : parsed.error.issues })
    return
  }
  if (!(await lireEmploye(id))) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  const inconnu = parsed.data.taches.find((t) => t.indicateur && !INDICATEURS.some((i) => i.cle === t.indicateur))
  if (inconnu) {
    res.status(400).json({ error: 'indicateur_inconnu', message: `Indicateur inconnu : ${inconnu.indicateur}` })
    return
  }
  const taches = parsed.data.taches.map(normaliserTache)
  const versionId = await enregistrerVersion(id, parsed.data.dateReleve, parsed.data.note.trim(), taches, req.personneRh!.cle)
  await journaliser(req.personneRh!.cle, 'releve_charge', `${id}:${parsed.data.dateReleve}`)
  res.status(201).json({ id: versionId })
}))

rhRouter.delete('/employes/:id/charge/:versionId', h(async (req, res) => {
  const id = idParam(req)
  const versionId = Number(req.params.versionId)
  if (!id || !Number.isInteger(versionId) || !(await supprimerVersion(id, versionId))) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  await journaliser(req.personneRh!.cle, 'suppression_releve', `${id}:${versionId}`)
  res.json({ ok: true })
}))

rhRouter.get('/employes/:id/charge/evolution', h(async (req, res) => {
  const id = idParam(req)
  const employe = id ? await lireEmploye(id) : null
  if (!employe) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  const n = Math.min(36, Math.max(3, Number(req.query.mois) || 12))
  const versions = await versionsCompletes(employe.id)
  const volumes = await volumesPour(versions.flatMap((v) => v.taches.filter(estMesuree).map((t) => t.indicateur!)))
  res.json({
    points: evolutionMensuelle(versions, volumes, moisListe(new Date(), n), derniereSemaineComplete()),
    releves: versions.map((v) => ({ id: v.id, dateReleve: v.dateReleve })),
  })
}))

rhRouter.get('/indicateurs', (_req, res) => {
  res.json(INDICATEURS.map((i) => ({ cle: i.cle, label: i.label, unite: i.unite })))
})
