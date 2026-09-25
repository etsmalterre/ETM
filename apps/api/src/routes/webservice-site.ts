// The website's API — replacement of the WinDev REST webservice MPS_WS that
// answered at alpha.etsmalterre.com (claude_doc/webservice_legacy.md).
// Mounted at /api/site; published under the public name the WordPress plugin
// already calls, so the plugin needs no change: Caddy maps
// https://alpha.etsmalterre.com/<route> → /api/site/<route>.
//
// Same routes, verbs and JSON shapes as the legacy service (the plugin decodes
// them field by field). Documents come from the snapshot
// (lib/webservice-site-store.ts): no HFSQL on the request path except
// Ref_Client's contact block and the catalogue-request form.
//
// ⚠️ PUBLIC SURFACE. Only what the site needs lives here — read-only, plus the
// prospect insert. Never mount an ERP router under this prefix: the MPS API has
// no global auth middleware. Caddy restricts the public name to the website's
// servers; WEBSERVICE_SITE_ALLOWED_IPS repeats the check here (defense in depth).
//
// Not ported (0 calls in a year of the legacy logs, 2025-08 → 2026-09):
// POST /NouvelleCommande (WooCommerce webhook → email) and
// GET /RapportQuotidien/{key} (daily email report).

import { Router, type Request, type Response, type NextFunction, type Router as RouterType } from 'express'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { normalizePays } from '../lib/pays.js'
import { VERTUS } from '../lib/webservice-site.js'
import { getSiteSnapshot, siteSnapshotStatus } from '../lib/webservice-site-store.js'
import { buildFicheTechniquePdfData, renderFicheTechniquePdfBuffer } from './references-fini.js'
import { insertProspect, type ProspectFields } from './prospects.js'
import { enregistrerActivite, EspaceIndisponible, listeAcces } from '../lib/espace-client-acces.js'
import { z } from 'zod'

export const webserviceSiteRouter: RouterType = Router()

// ── Access ──────────────────────────────────────────────────

const ALLOWED_IPS = new Set(
  (process.env.WEBSERVICE_SITE_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
)

/** The caller's address: the socket peer, or — when the peer is our own
 *  reverse proxy (a private address) — the first X-Forwarded-For hop. */
export function clientIp(req: Pick<Request, 'socket' | 'headers'>): string {
  const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
  const isPrivate = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$)/.test(peer)
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  return isPrivate && xff ? xff.replace(/^::ffff:/, '') : peer
}

webserviceSiteRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (ALLOWED_IPS.size > 0 && !ALLOWED_IPS.has(clientIp(req))) {
    res.status(403).json({ fault: { faultcode: 'client', faultstring: 'Accès refusé', detail: '' } })
    return
  }
  next()
})

// ── Helpers ─────────────────────────────────────────────────

/** Legacy RenvoieErreurAuFormat: `{ fault: { faultcode, faultstring, detail } }`. */
function fault(res: Response, status: number, message: string, detail = ''): void {
  res.status(status).json({ fault: { faultcode: status >= 500 ? 'serveur' : 'client', faultstring: message, detail } })
}

function idParam(v: string): number {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 0
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      console.error(`[webservice-site] ${req.method} ${req.path}:`, err)
      fault(res, 500, 'Erreur interne du serveur')
    })
  }
}

// ── Lists ───────────────────────────────────────────────────

webserviceSiteRouter.get('/ListeIDRefInterne', handle(async (_req, res) => {
  const s = await getSiteSnapshot()
  res.json({
    ref_produit: Object.values(s.refInterne).map((d) => ({
      IDRef_Produit: d.ref_produit.IDRef_Produit,
      date_modification: d.ref_produit.date_modification,
    })),
  })
}))

webserviceSiteRouter.get('/ListeIDRefProduit', handle(async (_req, res) => {
  const s = await getSiteSnapshot()
  res.json({
    ref_produit: Object.values(s.refProduit).map((p) => ({
      IDRef_Produit: p.doc.ref_produit.IDRef_Produit,
      IDClient: p.IDclient,
      date_modification: p.doc.ref_produit.date_modification,
      Ordre: 1,
    })),
  })
}))

webserviceSiteRouter.get('/ListeIDClient', handle(async (_req, res) => {
  res.json({ ref_client: (await getSiteSnapshot()).clients })
}))

webserviceSiteRouter.get('/ListeVertus', (_req, res) => {
  res.json({ vertus: VERTUS })
})

webserviceSiteRouter.get('/ListeCategoriesProduit', handle(async (_req, res) => {
  res.json({ categories: (await getSiteSnapshot()).categories })
}))

// ── Documents ───────────────────────────────────────────────

// The QR sample page: public grid of a finished reference.
webserviceSiteRouter.get('/Ref_Interne/:id', handle(async (req, res) => {
  const doc = (await getSiteSnapshot()).refInterne[String(idParam(req.params.id))]
  // The legacy answered 200 with the bare word « Erreur »; the plugin never
  // reads the status, so the body stays and the status becomes honest.
  if (!doc) { res.status(404).type('application/json').send('Erreur'); return }
  res.json(doc)
}))

// A client's own product and prices (IDRef = IDdesignation_client).
webserviceSiteRouter.get('/Ref_Produit/:ref/:client', handle(async (req, res) => {
  const ref = idParam(req.params.ref)
  const client = idParam(req.params.client)
  if (!client) { fault(res, 400, 'Erreur IDClient'); return }
  const p = (await getSiteSnapshot()).refProduit[String(ref)]
  if (!p) { fault(res, 404, "La référence demandée n'existe pas"); return }
  if (p.IDclient !== client) { fault(res, 404, "La référence demandée n'existe pas pour ce client"); return }
  res.json(p.doc)
}))

// Contact + default addresses + the client's (référence, coloris) pairs. The
// contact block is read live (three single-client queries): it is personal
// data, not worth keeping in a snapshot file.
webserviceSiteRouter.get('/Ref_Client/:id', handle(async (req, res) => {
  const id = idParam(req.params.id)
  if (!id) { fault(res, 400, 'Erreur IDClient'); return }
  // client holds a binary memo → explicit columns only.
  const cRows = await query<{ IDclient: number; nom: string | null; IDsociete: number }>(
    `SELECT IDclient, nom, IDsociete FROM client WHERE IDclient = ${id}`,
  )
  // The shop is ETM's: a TRM / Confection client is not served.
  if (cRows.length === 0 || Number(cRows[0].IDsociete) !== 1) { fault(res, 404, "Le client demandé n'existe pas"); return }
  const [client] = await fixEncoding(cRows, 'client', 'IDclient', ['nom'])

  const contacts = await fixEncoding(
    await query<{ IDcontact: number; prenom: string | null; nom: string | null; tel: string | null; mail: string | null }>(
      `SELECT IDcontact, prenom, nom, tel, mail FROM contact WHERE IDclient = ${id} AND est_defaut = 1`,
    ),
    'contact', 'IDcontact', ['prenom', 'nom'],
  )
  const contact = contacts.sort((a, b) => Number(a.IDcontact) - Number(b.IDcontact))[0]

  const adresses = await fixEncoding(
    await query<{
      IDadresse: number; nom: string | null; adresse1: string | null; adresse2: string | null; adresse3: string | null
      cp: string | null; ville: string | null; pays: string | null; est_defaut_facturation: number; est_defaut_livraison: number
    }>(
      `SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays, est_defaut_facturation, est_defaut_livraison
         FROM adresse WHERE IDclient = ${id}`,
    ),
    'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'],
  )
  const fact = adresses.find((a) => Number(a.est_defaut_facturation) === 1)
  const livr = adresses.find((a) => Number(a.est_defaut_livraison) === 1)
  const t = (v: unknown) => (v == null ? '' : String(v).trim())

  const s = await getSiteSnapshot()
  res.json({
    IDClient: id,
    prenom: t(contact?.prenom),
    nom: t(contact?.nom),
    telephone: t(contact?.tel),
    email: t(contact?.mail),
    societe: t(client.nom),
    facturation_adresse1: t(fact?.adresse1),
    facturation_adresse2: t(fact?.adresse2),
    facturation_adresse3: t(fact?.adresse3),
    facturation_code_postal: t(fact?.cp),
    facturation_ville: t(fact?.ville),
    facturation_pays: normalizePays(fact?.pays),
    livraison_societe: t(livr?.nom),
    livraison_adresse1: t(livr?.adresse1),
    livraison_adresse2: t(livr?.adresse2),
    livraison_adresse3: t(livr?.adresse3),
    livraison_code_postal: t(livr?.cp),
    livraison_ville: t(livr?.ville),
    livraison_pays: normalizePays(livr?.pays),
    ListeRefColoris: s.refColorisByClient[String(id)] ?? [],
  })
}))

// The technical sheet the documents link to (fiche_technique). The legacy
// service linked /fichiers/documents/FT<id>.pdf, which never existed.
const ficheCache = new Map<number, { at: number; pdf: Buffer }>()
const FICHE_TTL_MS = 60 * 60_000

webserviceSiteRouter.get('/fichiers/documents/:file', handle(async (req, res) => {
  const m = /^FT(\d+)\.pdf$/i.exec(req.params.file)
  const id = m ? Number(m[1]) : 0
  // Only references the public catalogue lists (not archived).
  if (!id || !(await getSiteSnapshot()).refInterne[String(id)]) { res.status(404).end(); return }
  let hit = ficheCache.get(id)
  if (!hit || Date.now() - hit.at > FICHE_TTL_MS) {
    const data = await buildFicheTechniquePdfData(id)
    if (!data) { res.status(404).end(); return }
    hit = { at: Date.now(), pdf: await renderFicheTechniquePdfBuffer(data) }
    ficheCache.set(id, hit)
  }
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="FT${id}.pdf"`)
  res.send(hit.pdf)
}))

// ── Catalogue / sample request (main site's Elementor forms) ─

const REQUIRED = ['date', 'prenom', 'nom', 'telephone', 'email', 'societe', 'adresse', 'code_postal', 'ville', 'pays', 'message'] as const

/** The form's date: YYYY-MM-DD, YYYYMMDD or DD/MM/YYYY → YYYYMMDD ('' if none). */
export function formDate(v: unknown): string {
  const s = String(v ?? '').trim()
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s)
  if (m) return `${m[1]}${m[2]}${m[3]}`
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s)
  return m ? `${m[3]}${m[2]}${m[1]}` : ''
}

const fold = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()

webserviceSiteRouter.post('/commande_catalogue', handle(async (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fault(res, 400, 'Bad Request', "le fichier .JSON n'a pas pu être lu")
    return
  }
  const b = body as Record<string, unknown>
  for (const k of REQUIRED) {
    if (b[k] === undefined || b[k] === null) { fault(res, 400, `Le paramètre '${k}' est manquant`); return }
  }
  const s = (k: (typeof REQUIRED)[number], max: number) => String(b[k]).trim().slice(0, max)

  // Legacy duplicate rule: same email, or same street + postcode. Compared in
  // JS — a typed value never goes into SQL (CLAUDE.md « a search term is a
  // write too »). Kept as-is: whether a known prospect may ask again is a
  // commercial decision the rewrite does not take.
  const existing = await query<{ email: string | null; adresse: string | null; code_postal: string | null }>(
    `SELECT email, adresse, code_postal FROM prospect`,
  )
  const email = fold(b.email)
  const adresse = fold(b.adresse)
  const cp = fold(b.code_postal)
  const dup = existing.some((p) =>
    (email !== '' && fold(p.email) === email) || (adresse !== '' && fold(p.adresse) === adresse && fold(p.code_postal) === cp),
  )
  // Legacy status code (500) kept: the theme's form handler is on the OVH
  // server and not in the repo, so it may test for it.
  if (dup) { fault(res, 500, 'Ce client existe déjà dans la BDD'); return }

  const today = new Date()
  const f: ProspectFields = {
    prenom: s('prenom', 50), nom: s('nom', 50), email: s('email', 50), societe: s('societe', 50),
    adresse: s('adresse', 50), code_postal: s('code_postal', 20), ville: s('ville', 100), pays: s('pays', 100),
    telephone: s('telephone', 50),
    status_catalogue: 1,
    date: formDate(b.date) || `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`,
    observation: String(b.message),
    notes_interne: '', expe_catalogue: '', tracking_number: '', IDtransporteur: 0, traite: 0, IDclient: 0,
  }
  try {
    const IDprospect = await insertProspect(f)
    res.json({ IDprospect })
  } catch (err) {
    console.error('[webservice-site] commande_catalogue insert failed:', err)
    fault(res, 500, "L'enregistrement des données dans la base a échoué")
  }
}))

// ── Health of the snapshot (monitoring) ─────────────────────

// ── Espace client (etsmalterre-site) ─────────────────────────
// Reached only by the sites VPS through the WireGuard tunnel (factory Caddy api-sites.intra…:9443, route allowlist +
// X-Site-Key). New routes live under espace/: the WordPress plugin never calls them, so their shapes are ours.
//
// ⚠️ They carry customer e-mails. The old public name alpha.etsmalterre.com also proxies /api/site (for the OVH
// shared-hosting IPs, shared with other OVH customers), so in production espace/* also checks the request came in
// through api-sites.intra… (Caddy keeps the original Host). The public Caddy block refuses /espace/* as well.
const ESPACE_HOST = process.env.NODE_ENV === 'production' ? 'api-sites.intra.etsmalterre.com' : null

webserviceSiteRouter.use('/espace', (req: Request, res: Response, next: NextFunction) => {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim().split(':')[0].toLowerCase()
  if (ESPACE_HOST && host !== ESPACE_HOST) {
    fault(res, 403, 'Accès refusé')
    return
  }
  next()
})

/**
 * Every ETS Malterre client (IDsociete 1, visible), id + name only — the espace client's admin picks one for
 * « voir comme le client ». No e-mails, no addresses. Cached 5 min to spare HFSQL.
 */
let espaceClientsCache: { at: number; clients: { IDClient: number; nom: string }[] } | null = null
webserviceSiteRouter.get('/espace/clients', handle(async (_req, res) => {
  if (!espaceClientsCache || Date.now() - espaceClientsCache.at > 5 * 60_000) {
    // client holds a binary memo → explicit columns only (same as Ref_Client).
    const rows = await fixEncoding(
      await query<{ IDclient: number; nom: string | null; IDsociete: number }>(
        `SELECT IDclient, nom, IDsociete FROM client WHERE est_visible = 1`,
      ),
      'client', 'IDclient', ['nom'],
    )
    const clients = rows
      .filter((r) => Number(r.IDsociete) === 1 && String(r.nom ?? '').trim())
      .map((r) => ({ IDClient: Number(r.IDclient), nom: String(r.nom).trim() }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
    espaceClientsCache = { at: Date.now(), clients }
  }
  res.json({ clients: espaceClientsCache.clients })
}))

/** Who may sign in to the espace client — decided in ETM (Clients › Gestion › Contacts), never by the portal.
 *  One row per contact, e-mail lowercased and unique (lib/espace-client-acces.ts). */
webserviceSiteRouter.get('/espace/acces', handle(async (_req, res) => {
  try {
    res.json({ acces: await listeAcces() })
  } catch (err) {
    if (err instanceof EspaceIndisponible) { fault(res, 503, 'Accès espace client non configuré'); return }
    throw err
  }
}))

const activiteSchema = z.object({
  evenements: z.array(z.object({
    idcontact: z.number().int().positive(),
    type: z.enum(['invitation', 'mot_de_passe', 'connexion']),
    le: z.string().datetime({ offset: true }),
  })).max(500),
})

/** What the portal reports back: invitation sent, password set, sign-in. Shown next to the switch in ETM. */
webserviceSiteRouter.post('/espace/activite', handle(async (req, res) => {
  const body = activiteSchema.safeParse(req.body)
  if (!body.success) { fault(res, 400, 'Requête invalide'); return }
  const now = Date.now()
  const evenements = body.data.evenements
    .map((e) => ({ idcontact: e.idcontact, type: e.type, le: new Date(e.le) }))
    .filter((e) => e.le.getTime() <= now + 5 * 60_000)
  try {
    res.json({ enregistres: await enregistrerActivite(evenements) })
  } catch (err) {
    if (err instanceof EspaceIndisponible) { fault(res, 503, 'Accès espace client non configuré'); return }
    throw err
  }
}))

webserviceSiteRouter.get('/_etat', (_req, res) => {
  res.json(siteSnapshotStatus())
})
