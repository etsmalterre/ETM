import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const envoi = vi.hoisted(() => ({
  destinataires: vi.fn(),
  construireRapport: vi.fn(),
  envoyerRapport: vi.fn(),
}))
vi.mock('../../rapports-pointage-envoi.js', () => envoi)

const { executeur, etatInitial } = await import('./rapports-pointage.js')

const rapport = {
  subject: 'Rapport de pointage - Mardi 29 septembre',
  content: { intro: '**Mardi 29 septembre** · 12 salariés pointés, 2 pointages à vérifier.' },
}

describe('pointage report automates — one run', () => {
  beforeEach(() => {
    envoi.destinataires.mockResolvedValue({ adresses: ['isabelle@x.fr', 'vincent@x.fr'], ecartes: [] })
    envoi.construireRapport.mockResolvedValue(rapport)
    envoi.envoyerRapport.mockResolvedValue(1)
  })
  afterEach(() => vi.clearAllMocks())

  it('essai builds the report and sends nothing', async () => {
    const resultat: Record<string, unknown> = {}
    const issue = await executeur('notif_rapport_pointage')('essai', resultat)
    expect(issue.statut).toBe('simule')
    expect(issue.resume).toContain('2 destinataires')
    expect(envoi.envoyerRapport).not.toHaveBeenCalled()
    expect(resultat.apercu).toBe('Mardi 29 septembre · 12 salariés pointés, 2 pointages à vérifier.')
  })

  it('actif sends one mail per address', async () => {
    const resultat: Record<string, unknown> = {}
    const issue = await executeur('notif_rapport_pointage')('actif', resultat)
    expect(issue.statut).toBe('applique')
    expect(envoi.envoyerRapport).toHaveBeenCalledTimes(2)
    expect(resultat.envoyes).toEqual(['isabelle@x.fr', 'vincent@x.fr'])
  })

  it('a failed address makes the run an error that names it', async () => {
    envoi.envoyerRapport.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    const issue = await executeur('notif_rapport_pointage')('actif', {})
    expect(issue.statut).toBe('erreur')
    expect(issue.resume).toContain('1 sur 2')
    expect(issue.resume).toContain('vincent@x.fr')
  })

  it('nothing to report, or nobody allowed: no mail, the run says why', async () => {
    envoi.construireRapport.mockResolvedValueOnce(null)
    expect((await executeur('notif_bilan_heures')('actif', {})).statut).toBe('inchange')
    envoi.destinataires.mockResolvedValueOnce({ adresses: [], ecartes: [{ nom: 'Nicolas Antonino', raison: 'n’a plus accès au menu Pointage' }] })
    const issue = await executeur('notif_bilan_heures')('actif', {})
    expect(issue.statut).toBe('inchange')
    expect(issue.resume).toContain('Nicolas Antonino')
    expect(envoi.envoyerRapport).not.toHaveBeenCalled()
  })

  it('never keeps the report body in the run', async () => {
    const resultat: Record<string, unknown> = {}
    await executeur('notif_rapport_pointage')('actif', resultat)
    expect(Object.keys(resultat).sort()).toEqual(['apercu', 'destinataires', 'ecartes', 'echecs', 'envoyes', 'sujet'])
  })
})

describe('etatInitial', () => {
  const env = process.env.NODE_ENV
  afterEach(() => { process.env.NODE_ENV = env })

  it('starts « essai » outside production, so a manual launch never mails anyone', () => {
    process.env.NODE_ENV = 'development'
    expect(etatInitial('notif_rapport_pointage')()).toEqual({ mode: 'essai' })
  })

  it('starts « actif » in production (the reports were already live)', () => {
    process.env.NODE_ENV = 'production'
    expect(etatInitial('notif_rapport_pointage')().mode).toBe('actif')
  })
})
