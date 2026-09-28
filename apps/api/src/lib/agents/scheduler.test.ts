import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake agent whose run the test finishes by hand: the manual launch must
// answer before the run ends (the Superviseur outlasts nginx's 60 s timeout).
const pending: Array<{ resolve: (runs: unknown[]) => void; reject: (err: unknown) => void }> = []

vi.mock('./catalog.js', () => {
  const def = {
    slug: 'lent',
    versionInitiale: { model: 'm', prompt: 'p', note: 'n' },
    declenchement: { type: 'quotidien', heure: 19, jours: [1, 2, 3, 4, 5] },
    sonder: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  }
  return { AGENTS: [def], agentDef: (slug: string) => (slug === 'lent' ? def : undefined) }
})

vi.mock('./store.js', () => ({
  lireEtat: async () => ({ mode: 'essai', activeVersion: 1, versions: [{ version: 1 }] }),
  versionActive: (s: { versions: unknown[] }) => s.versions[0],
  marquerPlanification: async () => undefined,
  nouvelIdRun: () => `l-${Math.random().toString(36).slice(2)}`,
}))

const { enregistrerTaches, etatSondage, lancerSondage, SondageEnCoursError, sousVerrou } = await import('./scheduler.js')

const par = { id: 1, nom: 'Test' }
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('lancerSondage', () => {
  beforeEach(() => {
    pending.length = 0
  })

  it('returns at once, then records the runs when the agent finishes', async () => {
    const l = lancerSondage('lent', par)
    expect(l.fin).toBeNull()
    await flush()
    expect(etatSondage('lent').enCours).toBe(true)
    expect(etatSondage('lent').dernierLancement?.id).toBe(l.id)

    pending[0].resolve([{ id: 'run-1', statut: 'simule', resume: '10 nouveaux points', resultat: { lourd: true } }])
    await flush()
    const e = etatSondage('lent')
    expect(e.enCours).toBe(false)
    expect(e.dernierLancement?.fin).not.toBeNull()
    expect(e.dernierLancement?.runs).toEqual([{ id: 'run-1', statut: 'simule', resume: '10 nouveaux points' }])
    expect(e.dernierLancement?.erreur).toBeNull()
  })

  it('refuses a second launch while one runs, synchronously', async () => {
    lancerSondage('lent', par)
    await flush()
    expect(() => lancerSondage('lent', par)).toThrow(SondageEnCoursError)
    pending[0].resolve([])
    await flush()
    expect(etatSondage('lent').enCours).toBe(false)
  })

  it('records a failed run as an error, with fin set', async () => {
    const l = lancerSondage('lent', par)
    await flush()
    pending[0].reject(new Error('Mistral en panne'))
    await flush()
    expect(l.erreur).toContain('Mistral en panne')
    expect(l.fin).not.toBeNull()
    expect(etatSondage('lent').enCours).toBe(false)
  })
})

describe('registered tâches (Agents IA › Automates)', () => {
  it('run through the same launch and lock as the agents', async () => {
    let fini: (() => void) | null = null
    enregistrerTaches([
      {
        cle: 'automate:test',
        declenchement: { type: 'releve', intervalleMs: 3_600_000 },
        lireEtat: async () => ({ mode: 'essai' }),
        marquerPlanification: async () => undefined,
        executer: () => new Promise((resolve) => (fini = () => resolve([{ id: 'r1', statut: 'simule', resume: 'ok' }]))),
      },
    ])
    const l = lancerSondage('automate:test', par)
    await flush()
    await expect(sousVerrou('automate:test', async () => 1)).rejects.toThrow(SondageEnCoursError)
    fini!()
    await flush()
    expect(l.runs).toEqual([{ id: 'r1', statut: 'simule', resume: 'ok' }])
    expect(await sousVerrou('automate:test', async () => 1)).toBe(1)
  })

  it('an unknown key is refused', () => {
    expect(() => lancerSondage('automate:inconnu', par)).toThrow(/inconnue/)
  })
})
