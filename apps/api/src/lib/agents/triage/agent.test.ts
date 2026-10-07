import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, AgentState } from '../store.js'
import type { MessageComplet } from '../../gmail-reader.js'

// ── In-memory store, Gmail, Mistral and the two agents behind ──

const runs = new Map<string, AgentRun[]>()
const etats = new Map<string, Partial<AgentState>>()
let n = 0
vi.mock('../store.js', () => ({
  ajouterRun: async (r: AgentRun) => { runs.set(r.slug, [...(runs.get(r.slug) ?? []), r]) },
  lireRuns: async (slug: string) => runs.get(slug) ?? [],
  modifierRun: async (slug: string, id: string, fn: (r: AgentRun) => void) => {
    const r = (runs.get(slug) ?? []).find((x) => x.id === id)
    if (!r) return null
    fn(r)
    return r
  },
  nouvelIdRun: () => `run-${++n}`,
  lireEtat: async (slug: string) => ({ mode: 'off', options: {}, ...etats.get(slug) }),
  optionDe: (s: AgentState, cle: string, d: boolean) => s.options?.[cle] ?? d,
  versionActive: () => ({ version: 1, model: 'mistral-small-latest', prompt: 'p', note: '' }),
}))

const labels: Array<{ op: 'add' | 'remove'; nom: string }> = []
let fil: MessageComplet[] = []
vi.mock('../../gmail-reader.js', () => ({
  lireFil: async () => fil,
  lireMessage: async (_b: string, id: string) => fil.find((m) => m.id === id),
  listerTousMessages: async () => fil.map((m) => ({ id: m.id, threadId: m.threadId })).reverse(), // Gmail: newest first
  assurerLibelle: async (_b: string, nom: string) => nom,
  ajouterLibelle: async (_b: string, _id: string, nom: string) => { labels.push({ op: 'add', nom }) },
  retirerLibelle: async (_b: string, _id: string, nom: string) => { labels.push({ op: 'remove', nom }) },
  sansCitation: (t: string) => t,
}))

let reponse: { raison: string; categories: string[] } = { raison: '', categories: [] }
vi.mock('../../mistral.js', () => ({ chatJson: async () => ({ data: reponse, raw: '', usage: {}, usd: 0.0004 }) }))

vi.mock('./annuaire.js', async (orig) => ({
  ...(await orig<typeof import('./annuaire.js')>()),
  annuaire: async () => [{ mail: 'mct.celine@mateltextiles.fr', type: 'sous_traitant', id: 9, nom: 'MATEL COULEURS TEXTILES' }],
}))

const recusBl: string[] = []
vi.mock('../bl-ennoblisseur.js', () => ({
  BL_ENNOBLISSEUR_BOITE: 'contact@etsmalterre.com',
  BL_ENNOBLISSEUR_SLUG: 'bl-ennoblisseur',
  BL_ENNOBLISSEUR_VERSION_INITIALE: { model: 'm', prompt: 'p', note: '' },
  traiterMessage: async (m: MessageComplet, ctx: { mode: string; source: string }) => {
    recusBl.push(m.id)
    const r = { id: `bl-${m.id}`, slug: 'bl-ennoblisseur', message: { id: m.id }, statut: ctx.mode === 'actif' ? 'ecrit' : 'simule', resume: 'BL lu', source: ctx.source, resultat: { profil: 'matel' } } as unknown as AgentRun
    runs.set('bl-ennoblisseur', [...(runs.get('bl-ennoblisseur') ?? []), r])
    return [r]
  },
}))
const recusFactures: string[] = []
vi.mock('../factures-sst/agent.js', () => ({
  FACTURES_SST_SLUG: 'factures-ennoblisseur',
  FACTURES_SST_VERSION_INITIALE: { model: 'm', prompt: 'p', note: '' },
  traiterMessage: async (m: MessageComplet) => {
    recusFactures.push(m.id)
    const r = { id: `fa-${m.id}`, slug: 'factures-ennoblisseur', message: { id: m.id }, statut: 'a_verifier', resume: 'Facture', resultat: { fournisseur: 'matel' } } as unknown as AgentRun
    runs.set('factures-ennoblisseur', [...(runs.get('factures-ennoblisseur') ?? []), r])
    return [r]
  },
}))

const { aTrier, corrigerTriage, resultatTriage, sonderBoite, trierMessage, CorrectionInvalide } = await import('./agent.js')

const version = { version: 1, model: 'mistral-small-latest', prompt: 'p', note: '', createdBy: null, createdAt: '' }
const par = { id: 1, nom: 'Vincent Malterre' }
const mail = (id: string, extra: Partial<MessageComplet> = {}): MessageComplet => ({
  id, threadId: 't1', de: 'Céline <mct.celine@mateltextiles.fr>', a: 'contact@etsmalterre.com', cc: '', sujet: 'BL métrages 109235',
  date: '2026-10-05T07:57:00.000Z', envoye: false, libelles: [], texte: 'Bonjour, ci-joint le BL.',
  piecesJointes: [{ nom: 'BL 109235.pdf', mimeType: 'application/pdf', attachmentId: 'a1', taille: 1000 }], ...extra,
})

beforeEach(() => {
  runs.clear(); etats.clear(); labels.length = 0; recusBl.length = 0; recusFactures.length = 0
  fil = [mail('m1')]
  reponse = { raison: 'BL de MATEL.', categories: ['bl_ennoblisseur'] }
})

describe('aTrier (which mails a poll triages)', () => {
  const ids = [{ id: 'a', threadId: 't' }, { id: 'b', threadId: 't' }, { id: 'c', threadId: 't' }]
  const run = (mid: string, statut: string) => ({ message: { id: mid }, statut }) as AgentRun
  it('skips triaged mails, retries a failed one up to 3 times', () => {
    expect(aTrier(ids, [run('a', 'trie'), run('b', 'erreur'), run('b', 'erreur')]).map((x) => x.id)).toEqual(['b', 'c'])
    expect(aTrier(ids, [run('b', 'erreur'), run('b', 'erreur'), run('b', 'erreur')]).map((x) => x.id)).toEqual(['a', 'c'])
    expect(aTrier(ids, [run('b', 'erreur'), run('b', 'trie')]).map((x) => x.id)).toEqual(['a', 'c'])
  })
})

describe('trierMessage', () => {
  it('essai: categories stored, no label, no hand-off; the dyer from the sender', async () => {
    etats.set('bl-ennoblisseur', { mode: 'actif', options: {} })
    const r = await trierMessage('m1', 't1', { mode: 'essai', version, source: 'gmail', lancePar: null })
    const res = resultatTriage(r)
    expect(r.statut).toBe('trie')
    expect(res.categories).toEqual(['bl_ennoblisseur'])
    expect(res.sousCategories.bl_ennoblisseur).toBe('MATEL')
    expect(res.expediteur.organisation).toMatchObject({ type: 'sous_traitant', id: 9 })
    expect(labels).toEqual([])
    expect(recusBl).toEqual([])
    expect(r.resume).toBe('BL ennoblisseur (MATEL) — BL métrages 109235')
  })

  it('actif: handed to BL Ennoblisseur (its own mode), labelled with the dyer it read', async () => {
    etats.set('bl-ennoblisseur', { mode: 'essai', options: {} })
    const r = await trierMessage('m1', 't1', { mode: 'actif', version, source: 'gmail', lancePar: null })
    const res = resultatTriage(r)
    expect(recusBl).toEqual(['m1'])
    expect(res.transmissions).toMatchObject([{ agent: 'bl-ennoblisseur', statut: 'transmis', runs: [{ id: 'bl-m1', statut: 'simule' }] }])
    expect(labels).toEqual([{ op: 'add', nom: 'ETM/BL ennoblisseur/MATEL' }])
    expect(runs.get('bl-ennoblisseur')![0].source).toBe('triage')
  })

  it('hands to an agent in service without any option (the old « via_triage » switch is gone), never to one that is off', async () => {
    etats.set('bl-ennoblisseur', { mode: 'actif', options: {} })
    const r = await trierMessage('m1', 't1', { mode: 'actif', version, source: 'gmail', lancePar: null })
    expect(recusBl).toEqual(['m1'])
    expect(resultatTriage(r).transmissions[0]).toMatchObject({ statut: 'transmis' })
    runs.delete('bl-ennoblisseur'); recusBl.length = 0
    etats.set('bl-ennoblisseur', { mode: 'off', options: {} })
    const r2 = await trierMessage('m1', 't1', { mode: 'actif', version, source: 'gmail', lancePar: null })
    expect(recusBl).toEqual([])
    expect(resultatTriage(r2).transmissions[0].raison).toMatch(/à l’arrêt/)
  })

  it('an agent that already has a run for the mail is not called again', async () => {
    etats.set('bl-ennoblisseur', { mode: 'actif', options: {} })
    runs.set('bl-ennoblisseur', [{ id: 'old', message: { id: 'm1' }, statut: 'ecrit', resume: 'x', resultat: {} } as unknown as AgentRun])
    const r = await trierMessage('m1', 't1', { mode: 'actif', version, source: 'gmail', lancePar: null })
    expect(recusBl).toEqual([])
    expect(resultatTriage(r).transmissions[0]).toMatchObject({ statut: 'deja_traite', runs: [{ id: 'old' }] })
  })

  it('a BL and an invoice in one mail go to both agents', async () => {
    etats.set('bl-ennoblisseur', { mode: 'actif', options: {} })
    etats.set('factures-ennoblisseur', { mode: 'actif', options: {} })
    reponse = { raison: 'BL et facture.', categories: ['bl_ennoblisseur', 'facture_sous_traitant'] }
    const r = await trierMessage('m1', 't1', { mode: 'actif', version, source: 'gmail', lancePar: null })
    expect(recusBl).toEqual(['m1'])
    expect(recusFactures).toEqual(['m1'])
    expect(labels.map((l) => l.nom)).toEqual(['ETM/BL ennoblisseur/MATEL', 'ETM/Facture sous-traitant/MATEL'])
    expect(r.resume).toBe('BL ennoblisseur (MATEL) + Facture sous-traitant (MATEL) — BL métrages 109235')
  })

  it('a simulation stores nothing and refuses actif', async () => {
    await trierMessage('m1', 't1', { mode: 'essai', version, source: 'gmail', lancePar: null, simulation: true })
    expect(runs.get('triage')).toBeUndefined()
    await expect(trierMessage('m1', 't1', { mode: 'actif', version, source: 'gmail', lancePar: null, simulation: true })).rejects.toThrow()
  })
})

describe('sonderBoite', () => {
  it('a mail whose triage fails leaves an « erreur » run, retried next time', async () => {
    const state = { mode: 'essai', startedAt: new Date(Date.now() - 3600_000).toISOString() } as AgentState
    fil = [mail('m1'), mail('m2', { date: '2026-10-05T08:00:00.000Z' })]
    reponse = null as unknown as typeof reponse // an unreadable answer: the triage throws
    const r1 = await sonderBoite(state, version)
    expect(r1.map((r) => r.statut)).toEqual(['erreur', 'erreur'])
    reponse = { raison: 'Rien de précis.', categories: [] }
    const r2 = await sonderBoite(state, version)
    expect(r2.map((r) => [r.message?.id, r.statut, resultatTriage(r).categories[0]])).toEqual([['m1', 'trie', 'autre'], ['m2', 'trie', 'autre']])
    expect(await sonderBoite(state, version)).toEqual([])
  })
})

describe('corrigerTriage', () => {
  it('a correction re-labels, hands the mail to the new category’s agent and scores an échec with why', async () => {
    etats.set('factures-ennoblisseur', { mode: 'actif', options: {} })
    reponse = { raison: 'Point du jour.', categories: ['sous_traitant'] }
    const r = await trierMessage('m1', 't1', { mode: 'actif', version, source: 'gmail', lancePar: null })
    expect(labels).toEqual([{ op: 'add', nom: 'ETM/Échange sous-traitant' }])
    labels.length = 0
    const c = await corrigerTriage(r.id, ['facture_sous_traitant'], 'La facture FA2974 est jointe.', par)
    expect(recusFactures).toEqual(['m1'])
    expect(labels).toEqual([{ op: 'remove', nom: 'ETM/Échange sous-traitant' }, { op: 'add', nom: 'ETM/Facture sous-traitant/MATEL' }])
    const res = resultatTriage(c!.run)
    expect(res.categories).toEqual(['facture_sous_traitant'])
    expect(res.categoriesAgent).toEqual(['sous_traitant'])
    expect(res.corrections).toHaveLength(1)
    expect(c!.run.evaluation).toMatchObject({ note: 'echec', commentaire: 'La facture FA2974 est jointe.' })
  })

  it('removing a category an agent already handled lists it (never undone)', async () => {
    etats.set('bl-ennoblisseur', { mode: 'actif', options: {} })
    const r = await trierMessage('m1', 't1', { mode: 'actif', version, source: 'gmail', lancePar: null })
    const c = await corrigerTriage(r.id, ['sous_traitant'], 'Pas un BL, une relance.', par)
    expect(c!.dejaTraites).toMatchObject([{ agent: 'bl-ennoblisseur', runs: [{ id: 'bl-m1' }] }])
  })

  it('a why is required; going back to the model’s categories withdraws the score', async () => {
    const r = await trierMessage('m1', 't1', { mode: 'essai', version, source: 'gmail', lancePar: null })
    await expect(corrigerTriage(r.id, ['qualite'], '  ', par)).rejects.toThrow(CorrectionInvalide)
    await expect(corrigerTriage(r.id, ['bl_ennoblisseur'], 'x', par)).rejects.toThrow(CorrectionInvalide)
    await corrigerTriage(r.id, ['qualite'], 'Réclamation.', par)
    const back = await corrigerTriage(r.id, ['bl_ennoblisseur'], '', par)
    expect(back!.run.evaluation).toBeNull()
    expect(resultatTriage(back!.run).corrections).toHaveLength(2)
  })

  it('an essai run is corrected without label nor hand-off', async () => {
    etats.set('factures-ennoblisseur', { mode: 'actif', options: {} })
    const r = await trierMessage('m1', 't1', { mode: 'essai', version, source: 'gmail', lancePar: null })
    await corrigerTriage(r.id, ['facture_sous_traitant'], 'Facture.', par)
    expect(recusFactures).toEqual([])
    expect(labels).toEqual([])
  })
})
