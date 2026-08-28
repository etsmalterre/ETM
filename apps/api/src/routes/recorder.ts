// Recorder — the write API for the TRS data collector (repo C:\dev\etsmalterre\TRS).
//
// The collector polls the S7-1200 over Modbus on the protected subnet and turns
// `Marche[i]` transitions into `evenement_machine` rows. It is the REPLACEMENT
// for the WinDev `Data_Recorder_V2` daemon on 10.10.11.2, and it reaches this
// API instead of writing HFSQL directly, for two reasons:
//
//   1. `evenement_machine` is a shared table, and this API is the only thing
//      that writes the shared tables — the same rule that keeps TRM out of them.
//   2. The recorder VM has NO ODBC stack at all (verified 2026-08-28: no iODBC,
//      no HFSQL driver, no odbc.ini — the WinDev binary uses its own bundled
//      runtime). Writing over HTTP means that box needs only Node.
//
// ⚠️ `evenement_machine` has exactly ONE writer, and TRM's Performance tab reads
// it. Two writers would double every transition, and each one's 30 s debounce
// would erase the other's rows. Never run this alongside the WinDev daemon in
// write mode.
//
// Auth is a shared secret, not a user session: the caller is a headless daemon,
// so there is no `IDutilisateur` to attach and the cookie/permission machinery
// does not apply. `attachUser()` is best-effort and there is no global gate, so
// this router carries its OWN guard — see CLAUDE.md § Paramètres > Utilisateurs.
// It FAILS CLOSED: with RECORDER_TOKEN unset, every call is refused.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query } from '../lib/hfsql-auto.js'
import { selectMachines, sqlText, parseDtMs } from '../lib/production-trm.js'
import { maxId } from './expeditions.js'

export const recorderRouter: RouterType = Router()

const n = (v: unknown): number => Number(v) || 0

/** HFSQL DATETIME literal: 'YYYYMMDDHHMMSS', local time. */
function hfsqlDt(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0')
  return (
    String(d.getFullYear()) +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  )
}

// ── Guard ─────────────────────────────────────────────────

function authorised(req: Request, res: Response): boolean {
  const expected = process.env.RECORDER_TOKEN
  if (!expected) {
    // Fail closed. A missing secret must never mean "let anyone write".
    res.status(503).json({ error: 'recorder API disabled: RECORDER_TOKEN is not configured' })
    return false
  }
  if (req.header('x-recorder-token') !== expected) {
    res.status(401).json({ error: 'bad or missing x-recorder-token' })
    return false
  }
  return true
}

// ── GET /api/recorder/bootstrap ───────────────────────────
//
// Everything the collector needs to resume: the métiers wired to the PLC, and
// the last event of each. Seeding from the last event is what makes a restart
// seamless — the recorder resumes the state it left rather than inventing a
// transition — so this is the call that makes the cutover from WinDev invisible.
//
// One request, two queries. The collector previously issued one `lastEvent`
// query per métier per cycle; with 30 running that was ~20 queries a second,
// which is exactly what must not become 30 HTTP calls.

recorderRouter.get('/bootstrap', async (req: Request, res: Response) => {
  if (!authorised(req, res)) return
  try {
    const machines = (await selectMachines()).filter((m) => m.adresseAutomate > 0)

    // Last event per machine in ONE pass: newest ids first, keep the first hit.
    // `DATE` is reserved on this table — always name it uppercase and alias it.
    const ids = machines.map((m) => Number(m.id))
    const events = ids.length
      ? await query<Record<string, unknown>>(
          'SELECT IDevenement_machine, IDmachine, DATE AS date_evt, etat FROM evenement_machine ' +
            'WHERE IDmachine IN (' +
            ids.join(',') +
            ') ORDER BY IDevenement_machine DESC',
        )
      : []

    const last = new Map<number, { id: number; etat: number; atMs: number | null }>()
    for (const e of events) {
      const id = n(e.IDmachine)
      if (last.has(id)) continue
      last.set(id, { id: n(e.IDevenement_machine), etat: n(e.etat), atMs: parseDtMs(e.date_evt) })
    }

    res.json({
      machines: machines.map((m) => ({
        idMachine: m.id,
        adresseAutomate: m.adresseAutomate,
        emplacement: m.emplacement,
        vitesse: m.vitesse,
        archive: m.archive,
        lastEvent: last.get(m.id) ?? null,
      })),
    })
  } catch (err) {
    console.error('[recorder] bootstrap failed:', err)
    res.status(500).json({ error: 'bootstrap failed' })
  }
})

// ── POST /api/recorder/cycle ──────────────────────────────
//
// One polling cycle's worth of writes, batched. The collector owns the state
// machine and the 30 s debounce — it decides WHAT changed, and this route only
// executes it. Keeping that decision on the collector is deliberate: the logic
// is about the PLC, so it belongs with the code that reads the PLC.
//
// `speeds` drives two things on different cadences, which is why it carries
// flags rather than being split into two endpoints:
//   - machine.vitesse           — live measured speed, whole tr/min
//   - ordre_fabrication.vitesse — running average, (existing + new) / 2
// The average is computed HERE because it needs the current stored value, and
// splitting that read-modify-write across HTTP would be a race for no benefit.

const CycleBody = z.object({
  at: z.string().datetime().optional(),
  insert: z
    .array(
      z.object({
        idMachine: z.number().int().positive(),
        etat: z.union([z.literal(0), z.literal(1)]),
        commentaire: z.string().max(200),
        at: z.string().datetime().optional(),
      }),
    )
    .max(64)
    .optional(),
  delete: z.array(z.number().int().positive()).max(64).optional(),
  speeds: z
    .array(
      z.object({
        idMachine: z.number().int().positive(),
        vitesseTrMin: z.number().min(0).max(1000),
        running: z.boolean(),
      }),
    )
    .max(64)
    .optional(),
  writeMachineVitesse: z.boolean().optional(),
  writeOfVitesse: z.boolean().optional(),
  /** Below this speed the OF average is not updated. WinDev used raw 50 = 5 tr/min. */
  ofMinVitesse: z.number().min(0).max(100).optional(),
})

recorderRouter.post('/cycle', async (req: Request, res: Response) => {
  if (!authorised(req, res)) return

  const parsed = CycleBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', detail: parsed.error.flatten() })
    return
  }
  const body = parsed.data
  const cycleAt = body.at ? new Date(body.at) : new Date()

  try {
    const inserted: { idMachine: number; id: number }[] = []

    // ── transitions ──
    //
    // No RETURNING on HFSQL, so ids are MAX(pk) + 1, taken once and stepped
    // locally across the batch. INSERT is POSITIONAL — evenement_machine column
    // order, verified live 2026-08-28:
    //   IDevenement_machine, IDmachine, DATE, nb_tour, commentaire, meta, etat
    if (body.insert?.length) {
      let nextId = (await maxId('evenement_machine', 'IDevenement_machine')) + 1
      for (const e of body.insert) {
        const at = e.at ? new Date(e.at) : cycleAt
        await query(
          'INSERT INTO evenement_machine VALUES (' +
            [
              nextId,
              Number(e.idMachine),
              "'" + hfsqlDt(at) + "'",
              0,
              sqlText(e.commentaire),
              "''",
              Number(e.etat),
            ].join(', ') +
            ')',
        )
        inserted.push({ idMachine: e.idMachine, id: nextId })
        nextId++
      }
    }

    // ── the destructive 30 s debounce ──
    //
    // The collector decides a transition was a flap and erases the event before
    // it, so the pair vanishes. Reproduced from WinDev rather than fixed, so
    // behaviour matches during the parallel run; whether to KEEP it is an open
    // question in TRS docs/recorder.md §4.
    let deleted = 0
    if (body.delete?.length) {
      for (const id of body.delete) {
        await query('DELETE FROM evenement_machine WHERE IDevenement_machine = ' + Number(id))
        deleted++
      }
    }

    // ── speeds ──
    let machineVitesse = 0
    let ofVitesse = 0
    const minTr = body.ofMinVitesse ?? 5

    for (const s of body.speeds ?? []) {
      if (body.writeMachineVitesse) {
        const rounded = Math.round(s.vitesseTrMin)
        await query(
          'UPDATE machine SET vitesse = ' + rounded + ' WHERE IDmachine = ' + Number(s.idMachine),
        )
        machineVitesse++
      }

      if (body.writeOfVitesse && s.running && s.vitesseTrMin >= minTr) {
        // Only when the métier carries exactly one active OF — otherwise there
        // is no single order the speed belongs to.
        const rows = await query<{ IDordre_fabrication: number; vitesse: number }>(
          'SELECT IDordre_fabrication, vitesse FROM ordre_fabrication ' +
            'WHERE est_actif = 1 AND IDmachine = ' +
            Number(s.idMachine),
        )
        if (rows.length === 1) {
          const cur = n(rows[0].vitesse)
          const next = cur === 0 ? Math.round(s.vitesseTrMin) : Math.round((cur + s.vitesseTrMin) / 2)
          if (next !== cur) {
            await query(
              'UPDATE ordre_fabrication SET vitesse = ' +
                next +
                ' WHERE IDordre_fabrication = ' +
                Number(rows[0].IDordre_fabrication),
            )
            ofVitesse++
          }
        }
      }
    }

    res.json({ inserted, deleted, machineVitesse, ofVitesse })
  } catch (err) {
    console.error('[recorder] cycle failed:', err)
    res.status(500).json({ error: 'cycle failed' })
  }
})
