import { describe, expect, it } from 'vitest'
import type { AgentRun } from '../store.js'
import { competenceDuRun, SANS_COMPETENCE } from './competences-flux.js'
import { mailsDuFlux } from './mails.js'

const CLES = ['bl', 'delais', 'controles']
let n = 0
const run = (mail: string, o: Partial<AgentRun>): AgentRun => ({
  id: `r${++n}`, slug: 'bl-ennoblisseur', createdAt: `2026-11-10T10:00:${String(n).padStart(2, '0')}Z`, source: 'triage', mode: 'actif',
  fichiers: [{ nom: 'bl.pdf', fichier: 'x.pdf', taille: 1 }], version: 4, model: '', statut: 'ecrit', resultat: {}, resume: '', coutUsd: 0, dureeMs: 0,
  message: { id: mail, threadId: mail, de: 'celine@matel.fr', sujet: `Sujet ${mail}`, date: `2026-11-${mail.padStart(2, '0')}T08:00:00Z` },
  ...o,
})
const bl = (mail: string, numero: string, o: Partial<AgentRun> = {}) => run(mail, { resultat: { extraction: { numero_bordereau: numero } }, ...o })
const sansPdf = (mail: string, resume: string, o: Partial<AgentRun> = {}) => run(mail, { statut: 'ignore', fichiers: [], resume, ...o })

describe('the skill a run belongs to', () => {
  it('is the one it names, else the BL', () => {
    expect(competenceDuRun(run('1', { competence: 'delais' }))).toBe('delais')
    expect(competenceDuRun(bl('1', '109547A'))).toBe('bl')
  })
  it('is none for a mail no file was read from', () => {
    expect(competenceDuRun(sansPdf('1', 'Aucun PDF à lire dans « Palettes »'))).toBe(SANS_COMPETENCE)
  })
  it('stays the BL for a PDF it looked at and set aside', () => {
    expect(competenceDuRun(run('1', { statut: 'ignore', resume: 'Pas un BL d’ennoblisseur : plan.pdf' }))).toBe('bl')
  })
})

describe('the mails of the flux', () => {
  it('lists each mail once, newest first, with its runs per skill', () => {
    const mails = mailsDuFlux([
      bl('03', '109547A'),
      bl('05', '109600A'), bl('05', '109601A'),
      run('05', { competence: 'delais', resultat: { delais: [{ reponse: 's 47' }, { reponse: '' }, { reponse: '12/11' }] } }),
      run('05', { competence: 'controles', resultat: { controles: [{}, {}] } }),
    ], CLES)
    expect(mails.map((m) => m.messageId)).toEqual(['05', '03'])
    expect(mails[0].runs.bl.map((r) => r.titre)).toEqual(['BL 109600A', 'BL 109601A'])
    expect(mails[0].runs.delais.map((r) => r.titre)).toEqual(['2 délais'])
    expect(mails[0].runs.controles.map((r) => r.titre)).toEqual(['2 lots'])
    expect(mails[1].runs).toEqual({ bl: [expect.objectContaining({ titre: 'BL 109547A', statut: 'ecrit' })] })
    expect(mails[1].sansSuite).toBeNull()
  })

  it('says why a mail went to no skill', () => {
    const [m] = mailsDuFlux([sansPdf('02', 'Aucun PDF à lire dans « Palettes »')], CLES)
    expect(m.runs).toEqual({})
    expect(m.sansSuite).toBe('Aucun PDF à lire')
    expect(m.enAttente).toEqual([])
  })

  it('shows a reply to the Point held by the skills in observation, until they have read it', () => {
    const attente = sansPdf('09', 'Délais et Contrôles en observation : lu une fois qu’une personne aura réagi')
    const [avant] = mailsDuFlux([attente], CLES)
    expect(avant.enAttente).toEqual(['delais', 'controles'])
    expect(avant.sansSuite).toBeNull()
    // The hourly pass read it for the Délais once a person typed a délai: only Contrôles still waits.
    const [apres] = mailsDuFlux([attente, run('09', { competence: 'delais', source: 'observation', resultat: { delais: [{ reponse: 's 47' }] } })], CLES)
    expect(apres.enAttente).toEqual(['controles'])
    expect(apres.runs.delais.map((r) => r.titre)).toEqual(['1 délai'])
  })

  it('reads the waiting skills from the run when it stores them', () => {
    const [m] = mailsDuFlux([sansPdf('09', 'peu importe', { resultat: { enAttente: ['controles'] } })], CLES)
    expect(m.enAttente).toEqual(['controles'])
  })

  it('names what the BL made of a PDF: a document set aside, a mise à dispo', () => {
    const [m] = mailsDuFlux([
      run('07', { statut: 'ignore', resume: 'Pas un BL d’ennoblisseur : plan.pdf' }),
      run('07', { resultat: { typeDocument: 'mise_a_dispo', extraction: { numero_of: '530426' } } }),
    ], CLES)
    expect(m.runs.bl.map((r) => r.titre)).toEqual(['Pas un BL', 'Mise à dispo OF 530426'])
  })

  it('replaces a run read again by its re-run', () => {
    const premier = bl('04', '109486A', { statut: 'a_verifier' })
    const [m] = mailsDuFlux([premier, bl('04', '109486A', { retraiteDe: premier.id })], CLES)
    expect(m.runs.bl).toHaveLength(1)
    expect(m.runs.bl[0].statut).toBe('ecrit')
  })
})

describe('the agents of the group', () => {
  const FACTURES = 'factures-ennoblisseur'
  const facture = (mail: string, numero: string | null, o: Partial<AgentRun> = {}) =>
    run(mail, { slug: FACTURES, resultat: numero ? { extraction: { numero_facture: numero } } : {}, ...o })
  const membre = (runs: AgentRun[]) => [{
    slug: FACTURES, runs,
    titre: (r: AgentRun) => `Facture ${(r.resultat as { extraction?: { numero_facture?: string } }).extraction?.numero_facture ?? '?'}`,
  }]

  it('are one more column, keyed by their slug, their runs naming their agent', () => {
    const mails = mailsDuFlux([bl('03', '109547A')], CLES, membre([facture('06', 'FA2865', { statut: 'a_verifier' })]))
    expect(mails.map((m) => m.messageId)).toEqual(['06', '03'])
    expect(mails[0].runs[FACTURES]).toMatchObject([{ titre: 'Facture FA2865', statut: 'a_verifier', agent: FACTURES }])
    expect(mails[0].sansSuite).toBeNull()
    // A run of the flux names no agent: it opens on the flux itself.
    expect(mails[1].runs.bl[0].agent).toBeUndefined()
  })

  it('share a mail with the skills: a BL and its invoice in the same mail', () => {
    const [m] = mailsDuFlux([bl('05', '109600A')], CLES, membre([facture('05', 'FA2866')]))
    expect(Object.keys(m.runs).sort()).toEqual(['bl', FACTURES].sort())
  })

  it('leave a mail without a file to no one, with why', () => {
    const [m] = mailsDuFlux([], CLES, membre([facture('08', null, { statut: 'ignore', fichiers: [], resume: 'Aucune facture jointe à « Relevé »' })]))
    expect(m.runs).toEqual({})
    expect(m.sansSuite).toBe('Aucune facture jointe')
  })
})
