/**
 * "Where can I see this working?" — lists the local-dev records that actually
 * exercise Qualité › Actions: which actions carry mentions, which suivilots
 * resolve a live mention (→ the Actions tab is populated), and which commandes
 * sous-traitant print one (→ the Mentions qualité card + the PDF block).
 *
 * Read-only. Usage: npx tsx src/scripts/find-actions-qualite-demo-data.ts
 */
import { query, fixEncoding, closeConnection } from '../lib/hfsql-auto.js'
import {
  loadActions,
  loadAllMentions,
  loadConformites,
  mentionsForLine,
  type MentionRow,
} from '../lib/actions-qualite.js'

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

async function main() {
  const actions = await loadActions()
  const mentions = await loadAllMentions()
  const conformites = await loadConformites()
  const actionById = new Map(actions.map((a) => [a.IDaction_qualite, a]))
  const openIds = new Set(actions.filter((a) => a.termine === 0).map((a) => a.IDaction_qualite))
  const liveMentions = mentions.filter((m) => openIds.has(m.IDaction_qualite))

  // ── 1. Actions worth opening ───────────────────────────
  console.log('════ QUALITÉ › ACTIONS — actions with mentions (filter "En cours") ════\n')
  const byAction = new Map<number, MentionRow[]>()
  for (const m of liveMentions) {
    const arr = byAction.get(m.IDaction_qualite) ?? []
    arr.push(m)
    byAction.set(m.IDaction_qualite, arr)
  }
  const mentionIdsByAction = new Map<number, Set<number>>()
  for (const [aid, ms] of byAction) mentionIdsByAction.set(aid, new Set(ms.map((m) => m.IDmention_qualite)))

  const rows = [...byAction.entries()].map(([aid, ms]) => {
    const mine = mentionIdsByAction.get(aid)!
    const verdicts = conformites.filter((c) => mine.has(c.IDmention_qualite))
    return {
      aid,
      titre: actionById.get(aid)?.titre ?? '',
      mentions: ms.length,
      verdicts: verdicts.length,
      conforme: verdicts.filter((v) => v.conformite === 'conforme').length,
    }
  })
  rows.sort((a, b) => b.verdicts - a.verdicts || b.mentions - a.mentions)
  console.log(`${pad('id', 5)}${pad('titre', 34)}${pad('mentions', 10)}${pad('contrôles', 11)}conformes`)
  for (const r of rows) {
    console.log(
      `${pad(String(r.aid), 5)}${pad(r.titre || '(sans titre)', 34)}${pad(String(r.mentions), 10)}${pad(String(r.verdicts), 11)}${r.conforme}`,
    )
  }

  // ── 2. Suivilots whose Actions tab is populated ────────
  console.log('\n\n════ QUALITÉ › SUIVI LOTS — lots with a live action (onglet "Actions") ════\n')
  const lots = await query<{
    IDsuivilot: number; lot: string | null; lid: number | null; sst: number | null; etat: number | null
  }>(
    `SELECT IDsuivilot, lot, IDligne_commande_sous_traitant AS lid, IDsous_traitant AS sst, IDetatLot AS etat
     FROM suivilot`,
  )
  const refIds = [...new Set(liveMentions.map((m) => m.IDreference))]
  const lineRows = await query<{ lid: number; type_kind: number; refid: number; colid: number }>(
    `SELECT IDligne_commande_sous_traitant AS lid, type AS type_kind, IDreference AS refid, IDColoris AS colid
     FROM ligne_commande_sous_traitant WHERE IDreference IN (${refIds.join(',')})`,
  )
  const lineById = new Map(lineRows.map((r) => [Number(r.lid), r]))

  const hits: Array<{ id: number; lot: string; sst: number; etat: number | null; ms: MentionRow[] }> = []
  for (const l of lots) {
    const lr = lineById.get(Number(l.lid) || 0)
    if (!lr) continue
    const ms = mentionsForLine(
      {
        IDligne_commande_sous_traitant: Number(l.lid) || 0,
        IDcommande_sous_traitant: 0,
        type_kind: Number(lr.type_kind) || 0,
        IDreference: Number(lr.refid) || 0,
        IDColoris: Number(lr.colid) || 0,
        IDsous_traitant: Number(l.sst) || 0,
      },
      liveMentions,
    )
    if (ms.length) {
      hits.push({
        id: Number(l.IDsuivilot),
        lot: (l.lot ?? '').toString().trim(),
        sst: Number(l.sst) || 0,
        etat: l.etat == null ? null : Number(l.etat),
        ms,
      })
    }
  }

  const sstIds = [...new Set([...hits.map((h) => h.sst)].filter((x) => x > 0))]
  const sstNames = new Map<number, string>()
  if (sstIds.length) {
    const r = await query<{ IDsous_traitant: number; nom: string | null }>(
      `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${sstIds.join(',')})`,
    )
    for (const x of await fixEncoding(r, 'sous_traitant', 'IDsous_traitant', ['nom']))
      sstNames.set(Number(x.IDsous_traitant), (x.nom ?? '').toString())
  }

  // État 3 = Validé ⇒ the list's "Terminé" tab; everything else is "En Cours".
  const enCours = hits.filter((h) => h.etat !== 3)
  const termines = hits.filter((h) => h.etat === 3)
  console.log(`${hits.length} lots au total — ${enCours.length} sous "En Cours", ${termines.length} sous "Terminé".\n`)
  console.log('— Onglet "En Cours" (les 12 plus récents) —')
  console.log(`${pad('suivilot', 10)}${pad('lot', 14)}${pad('sous-traitant', 24)}mentions`)
  for (const h of enCours.slice(-12).reverse()) {
    console.log(
      `${pad(String(h.id), 10)}${pad(h.lot || '—', 14)}${pad(sstNames.get(h.sst) ?? `#${h.sst}`, 24)}${h.ms
        .map((m) => actionById.get(m.IDaction_qualite)?.titre || `#${m.IDaction_qualite}`)
        .join(' + ')}`,
    )
  }
  console.log('\n— Onglet "Terminé" (les 6 plus récents) —')
  for (const h of termines.slice(-6).reverse()) {
    console.log(
      `${pad(String(h.id), 10)}${pad(h.lot || '—', 14)}${pad(sstNames.get(h.sst) ?? `#${h.sst}`, 24)}${h.ms
        .map((m) => actionById.get(m.IDaction_qualite)?.titre || `#${m.IDaction_qualite}`)
        .join(' + ')}`,
    )
  }

  // ── 3. Commandes sst carrying a mention ────────────────
  console.log('\n\n════ SOUS-TRAITANTS › COMMANDES — commandes qui portent une mention ════\n')
  const cmdLines = await query<{ cid: number; lid: number; type_kind: number; refid: number; colid: number }>(
    `SELECT IDcommande_sous_traitant AS cid, IDligne_commande_sous_traitant AS lid, type AS type_kind,
            IDreference AS refid, IDColoris AS colid
     FROM ligne_commande_sous_traitant WHERE IDreference IN (${refIds.join(',')})`,
  )
  const cmdIds = [...new Set(cmdLines.map((c) => Number(c.cid)).filter((x) => x > 0))]
  const heads = new Map<number, { sst: number; soldee: number; date: string }>()
  if (cmdIds.length) {
    // Chunked so the IN list stays sane on HFSQL.
    for (let i = 0; i < cmdIds.length; i += 200) {
      const slice = cmdIds.slice(i, i + 200)
      const r = await query<{ cid: number; sst: number; soldee: number; d: string | null }>(
        `SELECT IDcommande_sous_traitant AS cid, IDsous_traitant AS sst, est_soldee AS soldee, date_commande AS d
         FROM commande_sous_traitant WHERE IDcommande_sous_traitant IN (${slice.join(',')})`,
      )
      for (const x of r)
        heads.set(Number(x.cid), {
          sst: Number(x.sst) || 0,
          soldee: Number(x.soldee) || 0,
          date: (x.d ?? '').toString(),
        })
    }
  }
  const moreSst = [...new Set([...heads.values()].map((h) => h.sst).filter((x) => x > 0 && !sstNames.has(x)))]
  if (moreSst.length) {
    const r = await query<{ IDsous_traitant: number; nom: string | null }>(
      `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${moreSst.join(',')})`,
    )
    for (const x of await fixEncoding(r, 'sous_traitant', 'IDsous_traitant', ['nom']))
      sstNames.set(Number(x.IDsous_traitant), (x.nom ?? '').toString())
  }

  const perCmd = new Map<number, Set<number>>()
  for (const cl of cmdLines) {
    const head = heads.get(Number(cl.cid))
    if (!head) continue
    const ms = mentionsForLine(
      {
        IDligne_commande_sous_traitant: Number(cl.lid) || 0,
        IDcommande_sous_traitant: Number(cl.cid) || 0,
        type_kind: Number(cl.type_kind) || 0,
        IDreference: Number(cl.refid) || 0,
        IDColoris: Number(cl.colid) || 0,
        IDsous_traitant: head.sst,
      },
      liveMentions,
    )
    if (!ms.length) continue
    const set = perCmd.get(Number(cl.cid)) ?? new Set<number>()
    for (const m of ms) set.add(m.IDmention_qualite)
    perCmd.set(Number(cl.cid), set)
  }

  const mentionById = new Map(mentions.map((m) => [m.IDmention_qualite, m]))
  const cmdRows = [...perCmd.entries()]
    .map(([cid, set]) => ({ cid, head: heads.get(cid)!, set }))
    .sort((a, b) => b.cid - a.cid)
  const open = cmdRows.filter((c) => c.head.soldee !== 1)
  console.log(`${cmdRows.length} commandes au total — ${open.length} non soldées (onglet "En cours").\n`)
  console.log(`${pad('cmd n°', 9)}${pad('date', 12)}${pad('sous-traitant', 22)}${pad('soldée', 8)}mention`)
  for (const c of cmdRows.slice(0, 15)) {
    const first = mentionById.get([...c.set][0])
    const d = c.head.date
    console.log(
      `${pad(String(c.cid), 9)}${pad(d.length === 8 ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : d, 12)}` +
        `${pad(sstNames.get(c.head.sst) ?? `#${c.head.sst}`, 22)}${pad(c.head.soldee === 1 ? 'oui' : 'non', 8)}` +
        `${(first?.mention ?? '').replace(/\s+/g, ' ').slice(0, 44)}`,
    )
  }

  console.log('\nAstuce : le bon de commande PDF de ces commandes affiche le bloc rouge « MENTIONS QUALITÉ ».')
  await closeConnection()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
