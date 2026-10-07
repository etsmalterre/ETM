// Agent « Rapport d'activité » (2026-10-06) — on working days at 9, 10, 11, 12,
// 15, 16, 17 and 18 h (Paris, since 2026-10-07) it mails Vincent — only him
// since 2026-10-07 — what one salarié did since the previous report: logins,
// actions in ETM and TRM (lib/journal-activite.ts), mails sent and received
// in his mailbox (read-only, the Superviseur's client), and
// the points to check — technical (errors, refusals, likely input mistakes)
// and behavioural (tone, a commitment with no trace in ETM, a client left
// without answer…).
//
// Facts are code (regles.ts: code signals, tables); the model only writes the
// summary, one line per mail and its points of attention, labelled as leads.
// If the model fails the report still goes out with the facts.
//
// ⚠️ Monitoring a salarié: he is informed BEFORE the agent goes « actif »
// (Code du travail L1222-4 — decision Vincent 2026-10-06). The recipients are
// fixed here, not a subscription anyone could tick. A run keeps counts and
// addresses only — never the report body (Agents IA is open to more people
// than the reader).

import { ajouterRun, nouvelIdRun, type AgentRun, type AgentState, type AgentVersion, type Auteur, type RunStatut, type VersionInitiale } from '../store.js'
import { chatJson } from '../../mistral.js'
import { sendMail } from '../../gmail.js'
import { renderNotificationEmail } from '../../notification-email.js'
import { mpsPg } from '../../mps-pg.js'
import { journalDe, purgerJournal } from '../../journal-activite.js'
import { partiesParis } from '../../pointage-etat.js'
import { collecterEntetes, lireMessage, type EnteteMessage } from '../superviseur/boites.js'
import { appDe, estPersonnel, menuDe, periode, resultatDe, signaux, HEURES_RAPPORT, HEURES_TEXTE, JOURS_RAPPORT, type ConnexionJour, type Signal } from './regles.js'
import { entreeRapport, hhmm, PROMPT_V1, PROMPT_V2, RAPPORT_SCHEMA, type MailEntree, type ReponseRapport } from './prompt.js'
import { chargerRefs, decrire, refsVides, regrouper } from './libelles.js'
import { contenuEmail, sujetRapport, type ActionRapport, type ContenuRapport, type MailRapport } from './email.js'

export const RAPPORT_ACTIVITE_SLUG = 'rapport-activite'
export { HEURES_RAPPORT, HEURES_TEXTE }
/** Working days only: Monday 9:00 covers the weekend. */
export const RAPPORT_ACTIVITE_JOURS = JOURS_RAPPORT

/** The salarié followed — his ETM/TRM account is found by this e-mail. */
export const PERSONNE_SUIVIE = 'pierre-emmanuel@etsmalterre.com'
/** Who reads the report. Fixed in code on purpose (see header). */
export const DESTINATAIRES: readonly string[] = (process.env.RAPPORT_ACTIVITE_DESTINATAIRES?.trim() || 'vincent@etsmalterre.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const EXPEDITEUR = 'tricotbot@etsmalterre.com'
const EXPEDITEUR_NOM = 'ETM - Rapport d’activité'

export const RAPPORT_ACTIVITE_VERSION_INITIALE: VersionInitiale = {
  model: 'mistral-medium-latest',
  prompt: PROMPT_V1,
  note: 'Version initiale — synthèse, résumé des mails et points d’attention (les faits et les signaux du code ne passent pas par le modèle).',
}

/** Offered in Agents IA › Prompt until published (prompt.ts PROMPT_V2). */
export const RAPPORT_ACTIVITE_PROMPT_LIVRE: VersionInitiale = {
  model: 'mistral-medium-latest',
  prompt: PROMPT_V2,
  note: 'Version 2 — rapport toutes les heures, actions en clair avec les numéros affichés à l’écran ; une libération ou un retrait de pièce n’est pas une suppression, un commentaire de commande n’est pas un engagement.',
}

/** Mails read by the model at most (headers of the others are still listed). */
const MAX_MAILS_LUS = 80

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const p2 = (n: number) => String(n).padStart(2, '0')
function jourLong(ms: number): string {
  const p = partiesParis(ms)
  return `${JOURS[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()]} ${p2(p.d)}/${p2(p.mo)}`
}

async function personneSuivie(): Promise<{ id: number; nom: string; identifiant: string | null } | null> {
  const [r] = await mpsPg()<{ idutilisateur: number; prenom: string | null; nom: string | null; identifiant: string | null }[]>`
    SELECT idutilisateur, prenom, nom, identifiant FROM utilisateur WHERE lower(email) = lower(${PERSONNE_SUIVIE}) LIMIT 1`
  if (!r) return null
  const nom = [r.prenom, r.nom].map((v) => (v ?? '').trim()).filter(Boolean).join(' ') || PERSONNE_SUIVIE
  return { id: r.idutilisateur, nom, identifiant: r.identifiant }
}

async function connexionsDe(p: { id: number; identifiant: string | null }, du: Date, au: Date): Promise<ConnexionJour[]> {
  const ids = [p.identifiant, PERSONNE_SUIVIE].filter((x): x is string => !!x).map((x) => x.toLowerCase())
  return mpsPg()<ConnexionJour[]>`
    SELECT le, succes, motif FROM connexion
    WHERE (idutilisateur = ${p.id} OR lower(identifiant) IN ${mpsPg()(ids)}) AND le >= ${du} AND le < ${au}
    ORDER BY le`
}

/** A reply's quoted history adds nothing the thread's other mails don't say. */
export function sansCitation(texte: string): string {
  const lignes = texte.split('\n')
  const i = lignes.findIndex((l) => /^(>|Le .{5,80} a écrit ?:|On .{5,80} wrote:|-{2,} ?(Message d'origine|Original Message)|De ?: .+@|From: .+@)/i.test(l.trim()))
  return (i > 0 ? lignes.slice(0, i) : lignes).join('\n').trim()
}

const correspondant = (m: EnteteMessage) =>
  m.envoye ? `${m.a[0] ?? '?'}${m.a.length + m.cc.length > 1 ? ` (+${m.a.length + m.cc.length - 1})` : ''}` : (m.deNom && m.deNom !== m.de ? `${m.deNom} <${m.de}>` : m.de)

export interface DonneesRapport {
  contenu: ContenuRapport
  /** Nothing happened at all (no action, no mail sent or received, no login). */
  vide: boolean
  coutUsd: number
  compteurs: Record<string, number>
}

/** Everything the report says about [du, au) — read-only, sends nothing. */
export async function construireRapport(version: Pick<AgentVersion, 'model' | 'prompt'>, nowMs: number, planifie = false): Promise<DonneesRapport> {
  const p = await personneSuivie()
  if (!p) throw new Error(`Aucun compte ETM/TRM avec l’adresse ${PERSONNE_SUIVIE} (Paramètres › Utilisateurs).`)
  const { du, au } = periode(nowMs, planifie)
  const [journal, connexions, entetes] = await Promise.all([
    journalDe(p.id, new Date(du), new Date(au)),
    connexionsDe(p, new Date(du), new Date(au)),
    collecterEntetes(PERSONNE_SUIVIE, du),
  ])

  // Names as people see them on screen; a lookup failure keeps the raw paths.
  const refs = await chargerRefs(journal).catch((err: unknown) => {
    console.error(`[agents] ${RAPPORT_ACTIVITE_SLUG}: names not resolved:`, err instanceof Error ? err.message : err)
    return refsVides()
  })
  const decrits = journal.map((l) => ({ ...l, ...decrire(l, refs) }))
  const lignes = regrouper(decrits)
  const actions: ActionRapport[] = lignes.map((l) => ({
    heure: hhmm(l.le.getTime()),
    app: appDe(l),
    menu: menuDe(l.chemin),
    action: l.texte,
    resultat: resultatDe(l.statut),
    erreur: l.erreur,
    n: l.n,
  }))
  const sig: Signal[] = signaux(decrits, connexions)

  const mailsPeriode = entetes.filter((m) => m.date >= du && m.date < au)
  const automatiques = mailsPeriode.filter((m) => m.automatique && !m.envoye).length
  const humains = mailsPeriode.filter((m) => m.envoye || !m.automatique)
  const entreesMails: MailEntree[] = []
  const mails: Array<MailRapport & { ref: string }> = []
  let lus = 0
  for (const [i, m] of humains.entries()) {
    const ref = `m${i + 1}`
    const personnel = estPersonnel(m.sujet)
    const sens = m.envoye ? 'envoyé' : 'reçu'
    mails.push({ ref, heure: hhmm(m.date), sens, correspondant: correspondant(m), sujet: m.sujet, resume: null, sansReponse: false, personnel })
    if (personnel || lus >= MAX_MAILS_LUS) continue
    lus++
    let extrait = ''
    try {
      extrait = sansCitation((await lireMessage(PERSONNE_SUIVIE, m.id)).texte)
    } catch {
      extrait = '(corps illisible)'
    }
    entreesMails.push({ ref, heure: hhmm(m.date), sens, correspondant: correspondant(m), sujet: m.sujet, extrait })
  }

  const connexionsTexte = connexions.map((c) => `${hhmm(c.le.getTime())} ${c.succes ? 'réussie' : `échouée${c.motif ? ` (${c.motif})` : ''}`}`)
  const periodeTexte = `${jourLong(du)} ${hhmm(du)} au ${jourLong(au)} ${hhmm(au)}`

  let ia: ContenuRapport['ia'] = null
  let iaErreur: string | null = null
  let coutUsd = 0
  const vide = !journal.length && !mails.length && !connexions.some((c) => c.succes)
  if (!vide) {
    try {
      const r = await chatJson({
        model: version.model,
        system: version.prompt,
        user: entreeRapport({
          personne: p.nom,
          periode: periodeTexte,
          connexions: connexionsTexte,
          // A known route is said in full by its sentence; only an unknown one
          // still needs its raw body.
          actions: lignes.map((l, i) => ({ ...actions[i], resultat: `${actions[i].resultat} (${l.statut})`, ecran: l.connue ? null : l.ecran, corps: l.connue ? null : l.corps })),
          signaux: sig,
          mails: entreesMails,
        }),
        schemaName: 'rapport_activite',
        schema: RAPPORT_SCHEMA,
      })
      coutUsd = r.usd
      const rep = r.data as Partial<ReponseRapport>
      for (const m of rep.mails ?? []) {
        const cible = mails.find((x) => x.ref === m.ref)
        if (cible && !cible.personnel) {
          cible.resume = m.resume || null
          cible.sansReponse = cible.sens === 'reçu' && !!m.sans_reponse
        }
      }
      ia = { synthese: rep.synthese ?? '', etm: rep.etm ?? [], trm: rep.trm ?? [], alertes: rep.alertes ?? [] }
    } catch (err) {
      iaErreur = err instanceof Error ? err.message.slice(0, 200) : String(err)
    }
  }

  const contenu: ContenuRapport = {
    personne: p.nom,
    periode: periodeTexte,
    jour: `${jourLong(au)} ${hhmm(au)}`,
    connexions: connexionsTexte,
    actions,
    mails: mails.map(({ ref: _ref, ...m }) => m),
    signaux: sig,
    ia,
    iaErreur,
  }
  return {
    contenu,
    vide,
    coutUsd,
    compteurs: {
      connexions: connexions.length,
      actionsEtm: decrits.filter((l) => appDe(l) === 'ETM').length,
      actionsTrm: decrits.filter((l) => appDe(l) === 'TRM').length,
      erreurs: actions.filter((a) => a.resultat === 'erreur').length,
      refus: actions.filter((a) => a.resultat === 'refus').length,
      mailsEnvoyes: mails.filter((m) => m.sens === 'envoyé').length,
      mailsRecus: mails.filter((m) => m.sens === 'reçu').length,
      mailsAutomatiques: automatiques,
      mailsPersonnels: mails.filter((m) => m.personnel).length,
      signaux: sig.length,
      alertesIa: ia?.alertes.length ?? 0,
    },
  }
}

export async function envoyerRapport(contenu: ContenuRapport, a: readonly string[], test = false): Promise<{ envoyes: string[]; echecs: string[] }> {
  const rendu = renderNotificationEmail(contenuEmail(contenu))
  const sujet = `${test ? '[Test] ' : ''}${sujetRapport(contenu)}`
  const envoyes: string[] = []
  const echecs: string[] = []
  for (const to of a) {
    try {
      await sendMail({ from: EXPEDITEUR, fromName: EXPEDITEUR_NOM, to: [to], subject: sujet, body: rendu.text, bodyHtml: rendu.html, inlineImages: rendu.inlineImages, signatureHtml: null })
      envoyes.push(to)
    } catch (err) {
      console.error(`[agents] ${RAPPORT_ACTIVITE_SLUG}: send to ${to} failed:`, err)
      echecs.push(to)
    }
  }
  return { envoyes, echecs }
}

export async function executer(state: AgentState, version: AgentVersion, par: Auteur | null): Promise<AgentRun[]> {
  if (state.mode === 'off') return []
  const t0 = Date.now()
  const base: Omit<AgentRun, 'statut' | 'resultat' | 'resume'> = {
    id: nouvelIdRun(),
    slug: RAPPORT_ACTIVITE_SLUG,
    createdAt: new Date(t0).toISOString(),
    source: par ? 'manuel' : 'planifie',
    mode: state.mode,
    lancePar: par,
    message: null,
    fichiers: [],
    version: version.version,
    model: version.model,
    coutUsd: 0,
    dureeMs: 0,
  }
  let run: AgentRun
  try {
    if (!par) {
      const purges = await purgerJournal().catch(() => 0)
      if (purges) console.log(`[agents] ${RAPPORT_ACTIVITE_SLUG}: ${purges} journal rows past retention deleted`)
    }
    const d = await construireRapport(version, t0, !par)
    const resultat: Record<string, unknown> = { periode: d.contenu.periode, compteurs: d.compteurs, destinataires: DESTINATAIRES }
    const chiffres = `${d.compteurs.actionsEtm} actions ETM · ${d.compteurs.actionsTrm} TRM · ${d.compteurs.mailsEnvoyes} mails envoyés · ${d.compteurs.mailsRecus} reçus · ${d.compteurs.signaux + d.compteurs.alertesIa} points`
    let statut: RunStatut
    let resume: string
    if (d.vide) {
      statut = 'rien_a_signaler'
      resume = 'Aucune activité depuis le rapport précédent : pas d’e-mail.'
    } else if (state.mode === 'essai') {
      statut = 'simule'
      resume = `Enverrait « ${sujetRapport(d.contenu)} » à ${DESTINATAIRES.length} destinataires — ${chiffres}.`
    } else {
      const { envoyes, echecs } = await envoyerRapport(d.contenu, DESTINATAIRES)
      resultat.envoyes = envoyes
      resultat.echecs = echecs
      statut = echecs.length ? 'erreur' : 'mail_envoye'
      resume = echecs.length ? `Envoyé à ${envoyes.length} sur ${DESTINATAIRES.length} ; échec pour ${echecs.join(', ')}.` : `Envoyé à ${envoyes.join(', ')} — ${chiffres}.`
    }
    if (d.contenu.iaErreur) resultat.iaErreur = d.contenu.iaErreur
    run = { ...base, statut, resultat, resume, coutUsd: d.coutUsd, dureeMs: Date.now() - t0 }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    run = { ...base, statut: 'erreur', resultat: {}, resume: 'Rapport non construit', erreur: msg, dureeMs: Date.now() - t0 }
  }
  await ajouterRun(run)
  return [run]
}
