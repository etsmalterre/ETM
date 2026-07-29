/**
 * Guard for Qualité › Actions' data layer.
 *
 * Part 1 (read-only) — asserts the legacy tables still parse into the ASCII row
 * shapes the routes rely on, and that the mention→sst-line matching rule still
 * reproduces the conformité rows legacy itself wrote. If the matching rule ever
 * drifts, this is what catches it.
 *
 * Part 2 (round-trip, opt-in with `--write`) — exercises the write paths on a
 * throwaway action: create → rename → toggle terminé → add/edit/delete a mention
 * → set/clear a conformité verdict → delete. Run it with `--linux` to force the
 * positional-rewrite branch that production actually takes, so the Linux path is
 * verified from a Windows dev box.
 *
 *   npx tsx src/scripts/check-actions-qualite.ts
 *   npx tsx src/scripts/check-actions-qualite.ts --write
 *   npx tsx src/scripts/check-actions-qualite.ts --write --linux
 */
import { closeConnection, query } from '../lib/hfsql-auto.js'

// `--linux` must be applied BEFORE lib/actions-qualite.ts is imported: it reads
// IS_WINDOWS at module load. A dynamic import after the patch is the only way to
// flip the branch.
const WRITE = process.argv.includes('--write')
const FORCE_LINUX = process.argv.includes('--linux')

// ⚠️ --linux is NOT a faithful simulation and MUST NOT run off a Linux host.
//
// It flips the WRITE branch to the positional path, but the READ branch it pairs
// with (queryB64Text) is a plain passthrough to query() on Windows — no encoding
// repair. So every accented value reads back as U+FFFD, and because the Linux
// mention path rewrites the whole IDreference bucket, those replacement chars get
// written straight back over the neighbouring rows as '?'.
//
// That is not theoretical: running `--write --linux` on Windows during
// development silently stripped the accents from mention_qualite rows 18 and 26
// ("Problèmes" → "Probl?mes", "60°" → "60?"), which had to be restored by hand.
// The real Linux path is safe because queryB64Text there genuinely decodes
// Latin-1; only the Windows simulation is destructive. Hence: hard refusal.
if (FORCE_LINUX) {
  if (process.platform !== 'linux') {
    console.error(
      '--linux only works ON Linux. On this host queryB64Text() is a passthrough,\n' +
      'so reads come back mangled and the bucket rewrite would write U+FFFD over\n' +
      'neighbouring rows. Run the plain `--write` check here, and run this script\n' +
      'on the Linux API host to exercise the positional path.',
    )
    process.exit(2)
  }
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
}

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  const aq = await import('../lib/actions-qualite.js')
  console.log(`platform branch: ${FORCE_LINUX ? 'linux (forced)' : process.platform}\n`)

  // ── Part 1: reads ──────────────────────────────────────
  console.log('── reads ──')
  const actions = await aq.loadActions()
  check('action_qualite parses', actions.length > 0, `${actions.length} rows`)
  check('every action has an id', actions.every((a) => a.IDaction_qualite > 0))
  // NB: a titre is NOT guaranteed. Legacy row 35 is a blank action created and
  // abandoned in 2022 (already terminé). The screen must fall back to a
  // placeholder label rather than rendering an empty list row.
  const untitled = actions.filter((a) => a.titre.length === 0)
  check(
    'untitled legacy actions stay within the known set',
    untitled.length <= 1,
    untitled.length ? `ids ${untitled.map((a) => a.IDaction_qualite).join(', ')}` : 'none',
  )
  check(
    'terminé decodes to 0/1 on both sides',
    actions.some((a) => a.termine === 0) && actions.some((a) => a.termine === 1),
    `${actions.filter((a) => a.termine === 0).length} open / ${actions.filter((a) => a.termine === 1).length} closed`,
  )
  // Accents must survive the read — a mangled read would silently write U+FFFD
  // back into HFSQL on the next positional rewrite.
  const accented = actions.filter((a) => /[éèêàçôûî]/i.test(`${a.titre} ${a.description}`))
  check('accents survive the action read', accented.length > 0, `${accented.length} rows with accents`)
  check(
    'no replacement char left in actions',
    !actions.some((a) => `${a.titre}${a.description}`.includes('�')),
  )

  const mentions = await aq.loadAllMentions()
  check('mention_qualite parses (accented PK)', mentions.length > 0, `${mentions.length} rows`)
  check('every mention has a PK', mentions.every((m) => m.IDmention_qualite > 0))
  check('every mention has a parent action', mentions.every((m) => m.IDaction_qualite > 0))
  check(
    'every mention has a référence (the only ASCII handle for writes)',
    mentions.every((m) => m.IDreference > 0),
  )
  check('no replacement char left in mentions', !mentions.some((m) => m.mention.includes('�')))

  const conformites = await aq.loadConformites()
  check('conformite_action parses', conformites.length > 0, `${conformites.length} rows`)
  const codes = new Set(conformites.map((c) => c.conformite))
  check(
    'every verdict maps to a known code',
    [...codes].every((c) => aq.CONFORMITE_VALUES.includes(c)),
    [...codes].join(', '),
  )

  // ── Matching rule vs legacy's own data ─────────────────
  // Legacy wrote one conformite_action row per (line, mention) it considered a
  // match. Our rule must accept every one of those pairs; a miss means the rule
  // drifted from what the WinDev app does.
  console.log('\n── matching rule vs legacy conformité rows ──')
  const lines = await aq.loadLinesForMentions(mentions)
  const lineById = new Map(lines.map((l) => [l.IDligne_commande_sous_traitant, l]))
  const mentionById = new Map(mentions.map((m) => [m.IDmention_qualite, m]))
  let checked = 0
  let missed = 0
  const misses: string[] = []
  for (const c of conformites) {
    const line = lineById.get(c.IDligne_commande_sous_traitant)
    const mention = mentionById.get(c.IDmention_qualite)
    if (!line || !mention) continue // orphan legacy row — not our rule's business
    checked++
    if (aq.mentionsForLine(line, [mention]).length === 0) {
      missed++
      if (misses.length < 5) {
        misses.push(
          `line ${line.IDligne_commande_sous_traitant} (type ${line.type_kind}, ref ${line.IDreference}, col ${line.IDColoris}, sst ${line.IDsous_traitant}) vs mention ${mention.IDmention_qualite} (type ${mention.IDtype_sst}, ref ${mention.IDreference}, col ${mention.IDColoris}, sst ${mention.IDsous_traitant})`,
        )
      }
    }
  }
  check(
    'rule reproduces every legacy (line, mention) pair',
    missed === 0,
    `${checked - missed}/${checked} matched${misses.length ? `; e.g. ${misses[0]}` : ''}`,
  )
  if (misses.length > 1) for (const m of misses.slice(1)) console.log(`        ${m}`)

  // ── Part 2: writes ─────────────────────────────────────
  if (!WRITE) {
    console.log('\n(skipping write round-trip; pass --write to run it)')
  } else {
    console.log('\n── write round-trip ──')
    // A reference that already carries mentions, so the Linux bucket-rewrite path
    // has neighbours to preserve — the case most likely to lose data.
    const busyRef = mentions.reduce<{ ref: number; type: number; count: number }>(
      (best, m) => {
        const count = mentions.filter((x) => x.IDreference === m.IDreference).length
        return count > best.count ? { ref: m.IDreference, type: m.IDtype_sst, count } : best
      },
      { ref: 0, type: 2, count: 0 },
    )
    const neighboursBefore = mentions
      .filter((m) => m.IDreference === busyRef.ref)
      .map((m) => `${m.IDmention_qualite}:${m.IDaction_qualite}:${m.mention}`)
      .sort()
    console.log(`  using référence ${busyRef.ref} (${busyRef.count} existing mentions)`)

    // Baselines — the round-trip must leave all three tables exactly as found.
    // Without this the script can silently corrupt the dev DB (it did, once:
    // a bad PK regex made every computed id collapse to 1 and overwrite a real
    // conformité row).
    const baseline = {
      actions: actions.length,
      mentions: mentions.length,
      conformites: conformites.length,
    }

    let actionId = 0
    let mentionId = 0
    try {
      // No em-dash / smart quotes in the fixtures: HFSQL columns are Latin-1 and
      // sqlText() deliberately folds those to ASCII, so asserting on them would
      // fail on correct behaviour rather than on a bug.
      const TITRE = 'ZZ TEST actions-qualite - a supprimer'
      const DESC = 'Contrôle round-trip: accents é è ê à ç ô'
      actionId = await aq.createAction(TITRE, DESC)
      check('createAction returns a PK', actionId > 0, `id ${actionId}`)
      let a = await aq.loadAction(actionId)
      check('created action reads back with accents intact', a?.titre === TITRE && a?.description === DESC)
      check('created action is open', a?.termine === 0)

      await aq.updateActionText(actionId, `${TITRE} (modifié)`, `${DESC} !`)
      a = await aq.loadAction(actionId)
      check('updateActionText persists', a?.titre === `${TITRE} (modifié)` && a?.description === `${DESC} !`)

      // The accented-column write — named UPDATE on Windows, full positional
      // rewrite on Linux. The text must survive the rewrite unchanged.
      await aq.setActionTermine(actionId, 1)
      a = await aq.loadAction(actionId)
      check('setActionTermine(1) persists', a?.termine === 1)
      check('rewrite preserved the accented text', a?.description === `${DESC} !`)
      await aq.setActionTermine(actionId, 0)
      check('setActionTermine(0) persists', (await aq.loadAction(actionId))?.termine === 0)

      const MENTION = 'ATTENTION contrôle qualité: épaisseur à surveiller'
      mentionId = await aq.createMention({
        IDaction_qualite: actionId,
        IDtype_sst: busyRef.type,
        IDsous_traitant: 0,
        IDreference: busyRef.ref,
        IDColoris: 0,
        mention: MENTION,
      })
      check('createMention returns a PK', mentionId > 0, `id ${mentionId}`)
      let m = (await aq.loadAllMentions()).find((x) => x.IDmention_qualite === mentionId)
      check('mention reads back with accents intact', m?.mention === MENTION)
      check('mention keeps its parent action', m?.IDaction_qualite === actionId)

      await aq.updateMention(mentionId, {
        IDtype_sst: busyRef.type,
        IDsous_traitant: 0,
        IDreference: busyRef.ref,
        IDColoris: 0,
        mention: `${MENTION} (v2)`,
      })
      m = (await aq.loadAllMentions()).find((x) => x.IDmention_qualite === mentionId)
      check('updateMention persists', m?.mention === `${MENTION} (v2)`)
      check('updateMention keeps the parent action', m?.IDaction_qualite === actionId)

      // Verdicts — writes the accented `sconformité` column.
      const someLine = lines.find((l) => l.IDligne_commande_sous_traitant > 0)
      if (someLine) {
        const lineId = someLine.IDligne_commande_sous_traitant
        await aq.setConformite(lineId, mentionId, 'conforme')
        let got = (await aq.loadConformites({ ligneIds: [lineId] })).find(
          (c) => c.IDmention_qualite === mentionId,
        )
        check('setConformite creates the verdict', got?.conformite === 'conforme')
        await aq.setConformite(lineId, mentionId, 'non_conforme')
        got = (await aq.loadConformites({ ligneIds: [lineId] })).find(
          (c) => c.IDmention_qualite === mentionId,
        )
        check('setConformite updates in place', got?.conformite === 'non_conforme')
        await aq.setConformite(lineId, mentionId, 'non_controle')
        got = (await aq.loadConformites({ ligneIds: [lineId] })).find(
          (c) => c.IDmention_qualite === mentionId,
        )
        check('accented verdict Non_Contrôlé round-trips', got?.conformite === 'non_controle')
      }
    } finally {
      // Always clean up — this runs against the shared dev DB.
      if (actionId > 0) {
        await aq.deleteAction(actionId)
        check('deleteAction removes the action', (await aq.loadAction(actionId)) === null)
      }
      const after = await aq.loadAllMentions()
      check(
        'test mention is gone',
        !after.some((m) => m.IDmention_qualite === mentionId),
      )
      const neighboursAfter = after
        .filter((m) => m.IDreference === busyRef.ref)
        .map((m) => `${m.IDmention_qualite}:${m.IDaction_qualite}:${m.mention}`)
        .sort()
      check(
        'bucket rewrite preserved every neighbouring mention',
        JSON.stringify(neighboursBefore) === JSON.stringify(neighboursAfter),
        `${neighboursBefore.length} before / ${neighboursAfter.length} after`,
      )
      // Row counts must return to baseline on all three tables — the single
      // assertion that catches "the round-trip left something behind".
      const finalActions = await aq.loadActions()
      const finalMentions = await aq.loadAllMentions()
      const finalConformites = await aq.loadConformites()
      check(
        'action_qualite row count back to baseline',
        finalActions.length === baseline.actions,
        `${baseline.actions} → ${finalActions.length}`,
      )
      check(
        'mention_qualite row count back to baseline',
        finalMentions.length === baseline.mentions,
        `${baseline.mentions} → ${finalMentions.length}`,
      )
      check(
        'conformite_action row count back to baseline',
        finalConformites.length === baseline.conformites,
        `${baseline.conformites} → ${finalConformites.length}`,
      )
      if (mentionId > 0) {
        check(
          'no orphan conformité rows left behind',
          !finalConformites.some((c) => c.IDmention_qualite === mentionId),
        )
      }
      // Duplicate PKs are the fingerprint of a collapsed max+1.
      const pkCounts = new Map<number, number>()
      for (const c of finalConformites) {
        pkCounts.set(c.IDconformite_action, (pkCounts.get(c.IDconformite_action) ?? 0) + 1)
      }
      const dupes = [...pkCounts.entries()].filter(([, n]) => n > 1)
      check(
        'no duplicate conformite_action primary keys',
        dupes.length === 0,
        dupes.length ? `pk ${dupes.map(([pk]) => pk).join(', ')}` : 'none',
      )
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  await closeConnection()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
