/**
 * Guard for `client.siren` (Clients › Gestion — ticket #1088).
 *
 *   npx tsx src/scripts/check-siren.ts               audit the stored values
 *   npx tsx src/scripts/check-siren.ts --roundtrip   + write/read/restore via the API
 *
 * The audit proves two things the screen depends on: the column is readable by
 * name (it is NOT in `SELECT *` territory — `client` carries a memo-binary
 * column, so Windows ODBC returns 0 rows on a wide select), and every stored
 * value is either empty or a real 9-digit SIREN. A value of another length
 * would mean either junk typed around the validation or a column narrower than
 * 9 characters silently truncating — both invisible on screen.
 *
 * `--roundtrip` additionally drives the real route: PUT a valid SIREN, read it
 * back, check a malformed one is refused, then restore the original value.
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { normalizeSiren, isValidSiren, sirenLuhnOk } from '../lib/siren.js'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'
const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`

let failures = 0
const ok = (m: string) => console.log(`  ✓ ${m}`)
const fail = (m: string) => { console.log(`  ✗ ${m}`); failures++ }

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Cookie: COOKIE, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

async function audit() {
  console.log('\n── Valeurs stockées ──')
  const rows = await query<{ IDclient: number; nom: unknown; siren: unknown }>(
    `SELECT IDclient, nom, siren FROM client WHERE IDsociete = 1 ORDER BY IDclient`,
  )
  ok(`colonne lisible — ${rows.length} clients ETM`)

  const filled = rows.filter((r) => String(r.siren ?? '').trim() !== '')
  console.log(`  ℹ ${filled.length} client(s) avec un SIREN renseigné`)

  const bad = filled.filter((r) => !isValidSiren(String(r.siren)))
  if (bad.length === 0) ok('tous les SIREN stockés font 9 chiffres')
  else {
    fail(`${bad.length} SIREN de longueur invalide (troncature ou saisie hors validation)`)
    for (const r of bad.slice(0, 10)) {
      console.log(`      #${r.IDclient} ${String(r.nom).trim()} → ${JSON.stringify(String(r.siren))}`)
    }
  }

  // Advisory: the Luhn key never blocks a save, so a failure here is a hint to
  // re-check the entry, not a broken invariant.
  const oddKey = filled.filter((r) => isValidSiren(String(r.siren)) && !sirenLuhnOk(String(r.siren)))
  if (oddKey.length > 0) {
    console.log(`  ℹ ${oddKey.length} SIREN à clé de contrôle inhabituelle (à vérifier, non bloquant) :`)
    for (const r of oddKey.slice(0, 10)) {
      console.log(`      #${r.IDclient} ${String(r.nom).trim()} → ${normalizeSiren(String(r.siren))}`)
    }
  }
}

async function roundtrip() {
  console.log('\n── Aller-retour via la route ──')
  const target = await query<{ IDclient: number; nom: unknown; siren: unknown }>(
    `SELECT IDclient, nom, siren FROM client WHERE IDsociete = 1 AND est_visible = 1 ORDER BY IDclient`,
  )
  if (target.length === 0) { fail('aucun client ETM visible'); return }
  const id = Number(target[0].IDclient)
  const original = String(target[0].siren ?? '')
  console.log(`  ℹ client #${id} ${String(target[0].nom).trim()} — siren initial ${JSON.stringify(original)}`)

  const before = await api(`/clients/${id}`)
  if (before.status !== 200) { fail(`GET /clients/${id} → ${before.status}`); return }
  if (!('siren' in before.json)) { fail('le détail ne renvoie pas de champ `siren`'); return }
  ok('GET expose le champ `siren`')

  // The PUT body is the screen's own draftToBody shape — the GET payload cannot
  // be echoed back as-is (it carries nulls and the adresses/contacts arrays).
  const d = before.json
  const t = (v: unknown) => (v == null ? '' : String(v))
  const n = (v: unknown) => Number(v ?? 0) || 0
  const body = (siren: string) => JSON.stringify({
    nom: t(d.nom) || 'Client',
    tel: t(d.tel), fax: t(d.fax), num_tva: t(d.num_tva), compte: t(d.compte), siren,
    commentaire: t(d.commentaire), journal_commercial: t(d.journal_commercial),
    pct_remise: n(d.pct_remise), pct_ajeol: n(d.pct_ajeol),
    IDtva: n(d.IDtva), IDmode_paiement: n(d.IDmode_paiement), IDecheance: n(d.IDecheance),
    IDcode_comptable: n(d.IDcode_comptable), IDsecteur_activite: n(d.IDsecteur_activite),
    IDactivite: n(d.IDactivite),
    client_interne: !!d.client_interne, inclureRapportQualite: !!d.inclureRapportQualite,
    dernier_contact: t(d.dernier_contact),
  })

  try {
    // 1. a valid SIREN persists, spaces and all
    const put = await api(`/clients/${id}`, { method: 'PUT', body: body('552 100 554') })
    if (put.status !== 200) fail(`PUT SIREN valide → ${put.status} ${JSON.stringify(put.json)}`)
    else {
      const after = await api(`/clients/${id}`)
      if (after.json?.siren === '552100554') ok('PUT « 552 100 554 » → stocké « 552100554 »')
      else fail(`relecture: attendu 552100554, reçu ${JSON.stringify(after.json?.siren)}`)
    }

    // 2. a malformed one is refused, and does NOT overwrite what is stored
    const badPut = await api(`/clients/${id}`, { method: 'PUT', body: body('12345') })
    if (badPut.status === 400 && badPut.json?.error === 'siren_invalide') ok('PUT « 12345 » refusé (400 siren_invalide)')
    else fail(`PUT invalide → ${badPut.status} ${JSON.stringify(badPut.json)}`)
    const still = await api(`/clients/${id}`)
    if (still.json?.siren === '552100554') ok('un refus ne touche pas la valeur stockée')
    else fail(`après refus: ${JSON.stringify(still.json?.siren)}`)

    // 3. clearing is allowed — the field is optional
    const clear = await api(`/clients/${id}`, { method: 'PUT', body: body('') })
    const cleared = await api(`/clients/${id}`)
    if (clear.status === 200 && cleared.json?.siren === '') ok('PUT « » → champ vidé (le SIREN est facultatif)')
    else fail(`effacement → ${clear.status} / ${JSON.stringify(cleared.json?.siren)}`)
  } finally {
    // Always put the client back exactly as it was found.
    await api(`/clients/${id}`, { method: 'PUT', body: body(original) })
    const restored = await query<{ siren: unknown }>(`SELECT siren FROM client WHERE IDclient = ${id}`)
    const got = normalizeSiren(String(restored[0]?.siren ?? ''))
    if (got === normalizeSiren(original)) ok('valeur initiale restaurée')
    else fail(`RESTAURATION MANQUÉE: attendu ${JSON.stringify(original)}, en base ${JSON.stringify(got)}`)
  }
}

async function main() {
  console.log(`SIREN client — garde (API ${API})`)
  await audit()
  if (process.argv.includes('--roundtrip')) await roundtrip()
  console.log(failures === 0 ? '\n✓ OK\n' : `\n✗ ${failures} échec(s)\n`)
  await closeConnection().catch(() => {})
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
