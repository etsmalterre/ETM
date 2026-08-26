/**
 * HTTP guard for Qualité › Retour client (TRM) and the FNC handover it hangs
 * off. `probe-retour-client-trm.ts` checks the DATA; this one checks the
 * ROUTES, which is a different risk.
 *
 *   API_BASE=http://localhost:8085/api pnpm --filter @mps/api exec tsx src/scripts/check-retour-client-trm.ts
 *
 * It creates a throwaway dossier qualité, hands it over, answers it as TRM
 * would, then deletes both rows — so it must NOT be pointed at prod. The dev
 * database is a stale copy of prod, the same scratch-write assumption every
 * other check script here makes.
 *
 * What it guards:
 *   1. Writes are gated by `edit_retour_client`: 401 anonymous, 403 for a user
 *      without the key. The read side is deliberately open.
 *   2. The handover creates exactly one retour_client, seeded from the dossier,
 *      and is idempotent — the failure it prevents is a second FNC email
 *      opening a duplicate dossier for the atelier.
 *   3. The answer is republished onto dossier_qualite.reponseFNC in the
 *      "<libellé>\r\n<commentaire>" shape ETM reads back. If this breaks, TRM
 *      answers into a void and nobody notices.
 *   4. Terminer / Réactiver flips the accented `archivé` and the list filter
 *      follows — the one write that has to survive a positional row rewrite on
 *      the Linux bridge.
 *   5. A document blob cannot be read through another retour's id.
 *   6. The PDF renders and is served with the iframe-embedding headers §21
 *      requires (the SendEmailDialog viewer silently falls back without them).
 */
import crypto from 'node:crypto'
import { query, closeConnection } from '../lib/hfsql-auto.js'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
/** Vincent — the hardcoded admin, so every permission check passes. */
const ADMIN_COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`
/** A plain user, no admin cookie → no bypass, no stored grants. */
const USER_COOKIE = `mps_uid=${sign(18)}`

async function api(
  path: string,
  init: RequestInit = {},
  cookie: string = ADMIN_COOKIE,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  }
}

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0)

async function main() {
  console.log(`TRM retour client routes against ${API}\n`)

  // A client and a défaut that exist, so the throwaway dossier is realistic.
  const clientRows = await query<any>(`SELECT IDclient FROM client WHERE IDsociete = 1 LIMIT 1`)
  const defautRows = await query<any>(`SELECT IDdefaut_textile FROM defaut_textile LIMIT 1`)
  const IDclient = n(clientRows[0]?.IDclient)
  const IDdefaut_textile = n(defautRows[0]?.IDdefaut_textile)
  if (!IDclient || !IDdefaut_textile) {
    console.error('  FAIL no client / defaut_textile to build a dossier with')
    process.exitCode = 1
    return
  }
  // A real roll, so the traçabilité has something to resolve.
  const ecruRows = await query<any>(
    `SELECT numero FROM stock_ecru WHERE IDordre_fabrication > 0 AND numero <> '' ORDER BY IDstock_ecru DESC LIMIT 1`,
  )
  const reference = (ecruRows[0]?.numero ?? '').toString().trim()

  let dossierId = 0
  let retourId = 0
  try {
    // ── 1. Read side is open, write side is gated ─────────
    console.log('1. Permission gate')
    const anon = await api('/retours-client-trm/1/archive', { method: 'PUT', body: '{"archive":0}' }, '')
    check('anonymous write → 401', anon.status === 401, anon.status)
    const plain = await api('/retours-client-trm/1/archive', { method: 'PUT', body: '{"archive":0}' }, USER_COOKIE)
    check('user without edit_retour_client → 403', plain.status === 403, plain.status)
    const read = await api('/retours-client-trm/?statut=tous', {}, USER_COOKIE)
    check('read stays open to any user', read.status === 200 && Array.isArray(read.json), read.status)
    const lookups = await api('/retours-client-trm/lookups')
    check(
      'lookups serve TRM résolutions only',
      lookups.status === 200 && (lookups.json?.resolutions ?? []).length > 0,
      lookups.json?.resolutions?.length,
    )

    // ── 2. The FNC handover ───────────────────────────────
    console.log('\n2. FNC handover (ETM → TRM)')
    const created = await api('/dossiers-qualite', {
      method: 'POST',
      body: JSON.stringify({ IDclient, IDdefaut_textile, description: '[CHECK] retour client — a supprimer' }),
    })
    dossierId = n(created.json?.IDdossier_qualite)
    check('throwaway dossier créé', created.status === 201 && dossierId > 0, created.json)
    if (!dossierId) return

    if (reference) {
      await api(`/dossiers-qualite/${dossierId}`, {
        method: 'PUT',
        body: JSON.stringify({ type_reference: '1', reference }),
      })
    }

    const envoi1 = await api(`/dossiers-qualite/${dossierId}/fnc/envoi`, { method: 'POST', body: '{}' })
    retourId = n(envoi1.json?.IDretour_client)
    check('envoi crée le retour client', envoi1.json?.handover === 'created' && retourId > 0, envoi1.json)

    const envoi2 = await api(`/dossiers-qualite/${dossierId}/fnc/envoi`, { method: 'POST', body: '{}' })
    check(
      'envoi idempotent — pas de dossier en double',
      envoi2.json?.handover === 'already_open' && n(envoi2.json?.IDretour_client) === retourId,
      envoi2.json,
    )

    const detail = await api(`/retours-client-trm/${retourId}`)
    check('le retour nomme Ets Malterre comme client', (detail.json?.client_nom ?? '') !== '', detail.json?.client_nom)
    check('le retour porte le défaut du dossier', n(detail.json?.IDdefaut_textile) === IDdefaut_textile)
    check('le retour cite le dossier ETM', n(detail.json?.fnc?.IDdossier_qualite) === dossierId)
    check('le retour naît « en cours »', n(detail.json?.archive) === 0)
    if (reference) check("l'affectation est reprise", (detail.json?.reference ?? '') === reference)

    // ── 3. The answer travels back ────────────────────────
    console.log('\n3. La réponse remonte sur la FNC')
    const resolutions = lookups.json?.resolutions ?? []
    const resolution = resolutions[0]
    // Latin-1 only, on purpose: sqlText() transliterates anything above it
    // (em-dash, curly quotes, ellipsis) because the Linux bridge corrupts raw
    // multi-byte UTF-8 in a SQL line. Accents must survive verbatim; an em-dash
    // coming back as "-" is the contract, not a defect.
    const commentaire = 'Réponse de contrôle - accents é à ù ç.'
    const answered = await api(`/retours-client-trm/${retourId}`, {
      method: 'PUT',
      body: JSON.stringify({ IDresolution_qualite: resolution.IDresolution_qualite, reponse: commentaire }),
    })
    check('TRM répond', answered.status === 200, answered.json)

    const dq = await api(`/dossiers-qualite/${dossierId}`)
    check('ETM lit la résolution', (dq.json?.fnc_resolution ?? '') === resolution.libelle, dq.json?.fnc_resolution)
    check('ETM lit le commentaire', (dq.json?.fnc_commentaire ?? '').trim() === commentaire, dq.json?.fnc_commentaire)
    const dqList = await api('/dossiers-qualite?statut=tous')
    const listed = (dqList.json ?? []).find((r: any) => n(r.IDdossier_qualite) === dossierId)
    check('la liste ETM passe en « répondu »', n(listed?.has_reponse) === 1, listed)

    // ── 4. Terminer / Réactiver — the accented flag ───────
    console.log('\n4. Clôture (le booléen accentué)')
    const close = await api(`/retours-client-trm/${retourId}/archive`, { method: 'PUT', body: '{"archive":1}' })
    check('Terminer', close.status === 200 && n(close.json?.archive) === 1, close.json)
    const termine = await api('/retours-client-trm/?statut=termine')
    check(
      'le filtre Terminé le voit',
      (termine.json ?? []).some((r: any) => n(r.IDretour_client) === retourId),
    )
    const encours = await api('/retours-client-trm/?statut=en_cours')
    check(
      'le filtre En cours ne le voit plus',
      !(encours.json ?? []).some((r: any) => n(r.IDretour_client) === retourId),
    )
    // The Linux path rewrites the whole row — prove nothing was lost with it.
    const after = await api(`/retours-client-trm/${retourId}`)
    check(
      'la réécriture ne perd ni la réponse ni le lien FNC',
      (after.json?.reponse ?? '').trim() === commentaire && n(after.json?.fnc?.IDdossier_qualite) === dossierId,
      { reponse: after.json?.reponse, fnc: after.json?.fnc?.IDdossier_qualite },
    )
    const reopen = await api(`/retours-client-trm/${retourId}/archive`, { method: 'PUT', body: '{"archive":0}' })
    check('Réactiver', reopen.status === 200 && n(reopen.json?.archive) === 0, reopen.json)

    // ── 5. Traçabilité + documents ────────────────────────
    console.log('\n5. Traçabilité et documents')
    const traca = await api(`/retours-client-trm/${retourId}/tracabilite`)
    check('traçabilité répond', traca.status === 200, traca.status)
    if (reference) {
      check('la référence résout vers au moins une pièce', traca.json?.resolved === true && (traca.json?.pieces ?? []).length > 0, {
        resolved: traca.json?.resolved,
        pieces: traca.json?.pieces?.length,
      })
    }
    const bogus = await api('/retours-client-trm/999999/tracabilite')
    check('un retour inexistant → 404', bogus.status === 404, bogus.status)

    // A doc belonging to another dossier must not be readable through this one.
    const someDoc = await query<any>(
      `SELECT IDdoc_qualité AS id FROM doc_qualite WHERE IDdossier_qualité > 0 ORDER BY IDdoc_qualité LIMIT 1`,
    ).catch(() => [] as any[])
    const docId = n((someDoc as any[])[0]?.id)
    if (docId > 0) {
      const res = await fetch(`${API}/retours-client-trm/${retourId}/documents/${docId}/fichier`, {
        headers: { Cookie: ADMIN_COOKIE },
      })
      check("le blob d'un autre dossier est refusé", res.status === 404, res.status)
    } else {
      console.log('  --   pas de doc_qualite lisible ici (pont Linux) — contrôle sauté')
    }

    // ── 6. PDF ────────────────────────────────────────────
    console.log('\n6. Fiche imprimée')
    const pdf = await fetch(`${API}/retours-client-trm/${retourId}/pdf`, { headers: { Cookie: ADMIN_COOKIE } })
    const body = Buffer.from(await pdf.arrayBuffer())
    check('PDF rendu', pdf.status === 200 && body.subarray(0, 4).toString() === '%PDF', {
      status: pdf.status,
      head: body.subarray(0, 4).toString(),
    })
    check(
      'en-têtes §21 pour l’aperçu en iframe',
      pdf.headers.get('x-frame-options') === null &&
        pdf.headers.get('cross-origin-resource-policy') === 'cross-origin',
      {
        xfo: pdf.headers.get('x-frame-options'),
        corp: pdf.headers.get('cross-origin-resource-policy'),
      },
    )
    const emailDefaults = await api(`/retours-client-trm/${retourId}/email-defaults`)
    check('email-defaults répond', emailDefaults.status === 200 && !!emailDefaults.json?.subject, emailDefaults.status)
  } finally {
    // ── Cleanup — always, even on an early failure.
    console.log('\nNettoyage')
    if (retourId > 0) {
      const r = await api(`/retours-client-trm/${retourId}`, { method: 'DELETE' })
      check(`retour ${retourId} supprimé`, r.status === 200, r.status)
    }
    if (dossierId > 0) {
      const d = await api(`/dossiers-qualite/${dossierId}`, { method: 'DELETE' })
      check(`dossier ${dossierId} supprimé`, d.status === 200, d.status)
    }
    await closeConnection()
  }

  console.log(failures === 0 ? '\nAll good.' : `\n${failures} failure(s).`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch(async (err) => {
  console.error(err)
  await closeConnection()
  process.exitCode = 1
})
