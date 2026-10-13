// Tricobot side panel: what Tricobot did with the Gmail conversation open in
// the active tab — Triage (categories, why, what it handed to which agent),
// BL Ennoblisseur (the rolls it pre-filled), Factures Ennoblisseur (the
// invoice and its checked lines) — and the corrections a person makes, sent
// to the existing ETM routes whose paths the conversation carries.
//
// Doctrine (CLAUDE.md « Agents IA »): users only see « Tricobot », silence is
// a réussite, a correction is an échec with a why. So there is no « juste »
// button: only « Tricobot s'est trompé ? » gestures.

import { ApiError, fetchConversation, fetchFil, login, logout, ouvrirPieceJointe, send } from './api'
import { contextKey, getSession, getSettings, saveSettings, type Session, type Settings } from './config'
import {
  formatDate, formatEuro, formatNombre, libelleCategorie, nomExpediteur, ORGANISATION_LABEL, STATUT_LABEL, statutTone,
  TRAITEMENT_LABEL, TRANSMISSION_LABEL, verdictLigne,
} from './format'
import type { RescanMessage, WorkerMessage } from './background'
import type { Avis, Bl, Conversation, Facture, GmailContext, LigneFacture, Message, MessageFil, RunStatut, Triage } from './types'

const COMMENT_MAX = 2000

type Onglet = 'agent' | 'conversation'

type Form =
  | { kind: 'triage'; categories: string[]; commentaire: string }
  | { kind: 'bl-echec'; commentaire: string }
  | { kind: 'bl-verifie'; commentaire: string }
  | { kind: 'ligne'; action: 'conforme' | 'ecart' | 'corriger'; commentaire: string }

const state = {
  tabId: null as number | null,
  context: null as GmailContext | null,
  conv: null as Conversation | null,
  session: null as Session | null,
  settings: null as Settings | null,
  view: 'main' as 'main' | 'settings',
  /** A Gmail tab whose content script no longer answers (the extension was
   *  reloaded or updated while Gmail stayed open). */
  orphan: false,
  loading: false,
  busy: false,
  error: null as string | null,
  notice: null as string | null,
  forms: new Map<string, Form>(),
  /** Triage runs whose reasoning the user unfolded (kept across re-renders). */
  raisonsOuvertes: new Set<string>(),
  /** Bottom tab bar: what Tricobot did, or the mails themselves as a chat. */
  onglet: 'agent' as Onglet,
  /** The thread's mails (« Conversation »), for the mailbox + thread in `cle`. */
  fil: null as { cle: string; messages: MessageFil[] } | null,
  filChargement: false,
  filErreur: null as string | null,
  /** Long mails the user unfolded in the conversation. */
  bullesDepliees: new Set<string>(),
  /** Scroll the conversation to its latest mail on the next render. */
  defilerEnBas: false,
}

// ---------------------------------------------------------------- DOM helper

type Child = Node | string | null | undefined | false
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
    else if (k === 'class') el.className = String(v)
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v
    else el.setAttribute(k, String(v))
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c)
  return el
}

// ---------------------------------------------------------------- data

async function currentTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab?.id ?? null
}

async function loadContext(): Promise<void> {
  state.tabId = await currentTabId()
  if (state.tabId === null) {
    state.context = null
    return
  }
  const key = contextKey(state.tabId)
  const stored = await chrome.storage.session.get(key)
  state.context = (stored[key] as GmailContext | null | undefined) ?? null
  state.orphan = false
  if (state.context) return
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.url?.startsWith('https://mail.google.com/')) return
  // Ask the page to report again; its answer lands in storage.session and
  // reloads the panel (storage.onChanged below). No answer = orphaned script.
  const msg: RescanMessage = { type: 'rescan' }
  await chrome.tabs.sendMessage(state.tabId, msg).catch(() => {
    state.orphan = true
  })
}

async function loadConversation(): Promise<void> {
  state.conv = null
  state.error = null
  if (!state.context || !state.session) {
    render()
    return
  }
  state.loading = true
  render()
  try {
    state.conv = await fetchConversation(state.context)
  } catch (e) {
    state.error = (e as Error).message
    if (e instanceof ApiError && e.status === 401) state.session = null
  } finally {
    state.loading = false
    render()
  }
}

function refreshBadge(): void {
  if (state.tabId === null) return
  const msg: WorkerMessage = { type: 'refresh', tabId: state.tabId }
  chrome.runtime.sendMessage(msg).catch(() => {})
}

async function act(key: string, fn: () => Promise<string | null>): Promise<void> {
  state.busy = true
  state.error = null
  state.notice = null
  render()
  try {
    const notice = await fn()
    state.forms.delete(key)
    await loadConversation()
    state.notice = notice
    refreshBadge()
  } catch (e) {
    state.error = (e as Error).message
  } finally {
    state.busy = false
    render()
  }
}

function openForm(key: string, form: Form): void {
  state.forms.set(key, form)
  render()
}

function closeForm(key: string): void {
  state.forms.delete(key)
  render()
}

const categoryLabel = (cle: string): string => libelleCategorie(cle, state.conv?.categories ?? [])
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(x => b.includes(x))

// ---------------------------------------------------------------- small views

function pill(text: string, tone: string, extra = ''): HTMLElement {
  return h('span', { class: `pill ${tone}${extra ? ` ${extra}` : ''}` }, text)
}

function statutPill(s: RunStatut): HTMLElement {
  return pill(STATUT_LABEL[s] ?? s, statutTone(s))
}

function erpLink(path: string, text: string): HTMLElement {
  return h('a', { href: `${state.settings!.erpUrl}${path}`, target: '_blank', rel: 'noopener' }, text)
}

function avisLine(a: Avis | null, quoi = 'Noté'): HTMLElement | null {
  if (!a) return null
  const verdict = a.note === 'reussite' ? '✓ Juste' : '✗ Tricobot s’est trompé'
  return h(
    'div',
    { class: `muted small${a.note === 'echec' ? ' echec' : ''}` },
    `${verdict} — ${quoi.toLowerCase()} par ${a.par || '?'} le ${formatDate(a.le)}`,
    a.commentaire ? ` — « ${a.commentaire} »` : '',
  )
}

function essaiNote(mode: string): HTMLElement | null {
  return mode === 'essai' ? h('div', { class: 'muted small' }, 'Mode essai : Tricobot n’a rien écrit dans ETM ni dans Gmail.') : null
}

/** A why + submit / cancel, shared by every correction form. */
function commentForm(opts: {
  key: string
  label: string
  placeholder: string
  form: { commentaire: string }
  required: boolean
  submitLabel: string
  danger?: boolean
  before?: Child[]
  hint?: string | null
  /** Another condition the form must meet (the Triage: categories changed). */
  canSubmit?: () => boolean
  onSubmit: () => void
}): HTMLElement {
  const ready = () =>
    !state.busy && (!opts.required || opts.form.commentaire.trim().length > 0) && (opts.canSubmit?.() ?? true)
  const submit = h(
    'button',
    { class: `btn ${opts.danger ? 'danger' : 'primary'}`, disabled: !ready(), onclick: () => ready() && opts.onSubmit() },
    opts.submitLabel,
  )
  const textarea = h('textarea', {
    maxLength: COMMENT_MAX,
    placeholder: opts.placeholder,
    value: opts.form.commentaire,
    oninput: (e: Event) => {
      opts.form.commentaire = (e.target as HTMLTextAreaElement).value
      submit.disabled = !ready()
    },
  })
  return h(
    'div',
    { class: 'form' },
    ...(opts.before ?? []),
    h('label', {}, opts.label),
    textarea,
    opts.hint ? h('div', { class: 'muted small' }, opts.hint) : null,
    h('div', { class: 'actions' }, submit, h('button', { class: 'btn', onclick: () => closeForm(opts.key) }, 'Annuler')),
  )
}

// ---------------------------------------------------------------- Triage

function saveTriage(t: Triage, form: Extract<Form, { kind: 'triage' }>): void {
  const key = `triage:${t.runId}`
  void act(key, async () => {
    const res = (await send('PUT', t.cheminCorrection, { categories: form.categories, commentaire: form.commentaire.trim() })) as {
      dejaTraites?: Array<{ nom: string }>
    }
    if (sameSet(form.categories, t.categoriesAgent)) return 'Retour au choix de Tricobot : la correction est retirée.'
    const parts = [`Reclassé en ${form.categories.map(categoryLabel).join(', ')}. Merci, Tricobot en tiendra compte.`]
    const relais = form.categories
      .filter(c => !t.categories.includes(c))
      .map(c => state.conv?.categories.find(x => x.cle === c))
      .filter(c => c?.agent)
    if (relais.length > 0 && t.mode === 'actif') parts.push('Le mail est transmis à l’agent concerné : rouvrez le panneau dans une minute.')
    const deja = res?.dejaTraites ?? []
    if (deja.length > 0) parts.push(`Déjà traité par ${deja.map(d => d.nom).join(', ')} : ce qui a été fait n’est pas annulé.`)
    return parts.join(' ')
  })
}

function renderTriage(t: Triage): HTMLElement {
  const key = `triage:${t.runId}`
  const form = state.forms.get(key) as Extract<Form, { kind: 'triage' }> | undefined
  const corrige = t.corrections.length > 0 && !sameSet(t.categories, t.categoriesAgent)
  const peutCorriger = !!state.conv?.droits.corrigerTriage && t.statut === 'trie'

  // A mail nobody corrected counts as well classified. The category pills
  // are the way to correct it: click → the right categories + why.
  const toggle = () => (form ? closeForm(key) : openForm(key, { kind: 'triage', categories: [...t.categories], commentaire: '' }))
  const cats = t.categories.map(c => {
    const sous = t.sousCategories[c]
    return sous ? `${categoryLabel(c)} · ${sous}` : categoryLabel(c)
  })
  const title = h(
    'div',
    { class: 'section-title' },
    'Triage',
    corrige ? h('span', { class: 'pill label struck' }, t.categoriesAgent.map(categoryLabel).join(', ')) : null,
    peutCorriger
      ? h(
          'button',
          {
            class: `pill label editable${form ? ' open' : ''}`,
            title: 'Mal classé ? Cliquez pour corriger',
            disabled: state.busy,
            onclick: toggle,
          },
          cats.join(', '),
          h('span', { class: 'caret' }, '▾'),
        )
      : h('span', { class: 'pill label' }, cats.join(', ')),
    t.statut === 'erreur' ? statutPill('erreur') : null,
  )

  const o = t.organisation
  const org = o ? h('div', { class: 'muted small' }, `${ORGANISATION_LABEL[o.type] ?? o.type} reconnu : ${o.nom}`) : null

  const transmissions = t.transmissions.length
    ? h(
        'ul',
        { class: 'hand-offs' },
        ...t.transmissions.map(x =>
          h(
            'li',
            {},
            h('span', {}, `→ ${x.nom}`),
            pill(TRANSMISSION_LABEL[x.statut] ?? x.statut, x.statut === 'erreur' ? 'bad' : x.statut === 'transmis' ? 'ok' : 'muted'),
            x.raison ? h('span', { class: 'muted small' }, x.raison) : null,
          ),
        ),
      )
    : null

  const history = t.corrections.length
    ? h(
        'div',
        { class: 'muted small' },
        ...t.corrections.map(c =>
          h(
            'div',
            {},
            `Corrigé par ${c.par || '?'} le ${formatDate(c.le)} : ${c.avant.map(categoryLabel).join(', ')} → ${c.apres.map(categoryLabel).join(', ')}`,
            c.commentaire ? ` — « ${c.commentaire} »` : '',
          ),
        ),
      )
    : null

  return h(
    'div',
    { class: 'section' },
    title,
    form ? renderTriageForm(t, form) : null,
    t.raison ? renderRaison(t) : null,
    t.erreur ? h('div', { class: 'error small' }, t.erreur) : null,
    org,
    transmissions,
    history,
    essaiNote(t.mode),
  )
}

/** Folded by default: the categories say what Tricobot decided, the why is
 *  there for whoever wants it. */
function renderRaison(t: Triage): HTMLElement {
  const details = h(
    'details',
    { class: 'reasoning', open: state.raisonsOuvertes.has(t.runId) },
    h('summary', {}, 'Raisonnement'),
    h('p', {}, t.raison),
  )
  details.addEventListener('toggle', () => {
    if (details.open) state.raisonsOuvertes.add(t.runId)
    else state.raisonsOuvertes.delete(t.runId)
  })
  return details
}

function renderTriageForm(t: Triage, form: Extract<Form, { kind: 'triage' }>): HTMLElement {
  const key = `triage:${t.runId}`
  const revert = sameSet(form.categories, t.categoriesAgent)
  const chips = h(
    'div',
    { class: 'chips' },
    ...(state.conv?.categories ?? []).map(c =>
      h(
        'button',
        {
          class: `chip${form.categories.includes(c.cle) ? ' on' : ''}`,
          title: c.description,
          onclick: () => {
            form.categories = form.categories.includes(c.cle) ? form.categories.filter(x => x !== c.cle) : [...form.categories, c.cle]
            render()
          },
        },
        c.libelle,
      ),
    ),
  )
  return commentForm({
    key,
    label: 'Pourquoi ?',
    placeholder: revert ? 'Facultatif : retour au choix de Tricobot' : 'Ce qui aurait dû le faire classer autrement (obligatoire)',
    form,
    required: !revert,
    submitLabel: 'Enregistrer',
    before: [h('label', {}, 'Bonnes catégories (une ou plusieurs)'), chips],
    hint: 'Les libellés ETM/… du mail sont remplacés. Une catégorie traitée par un agent (BL, facture) lui transmet le mail.',
    // Nothing to save while the categories are the current ones (or none).
    canSubmit: () => form.categories.length > 0 && !sameSet(form.categories, t.categories),
    onSubmit: () => saveTriage(t, form),
  })
}

// ---------------------------------------------------------------- BL

function renderBl(b: Bl): HTMLElement {
  const key = `bl:${b.runId}`
  const form = state.forms.get(key)
  const piloter = !!state.conv?.droits.piloter

  const pieces = b.pieces.length
    ? h(
        'table',
        { class: 'pieces' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Pièce'), h('th', { class: 'num' }, 'Poids'), h('th', { class: 'num' }, 'Ml'))),
        h(
          'tbody',
          {},
          ...b.pieces.flatMap(p => [
            h(
              'tr',
              {},
              h('td', {}, p.numero, p.statut && p.statut !== 'ok' ? h('span', { class: 'pill bad tiny' }, p.statut.replace(/_/g, ' ')) : null),
              h('td', { class: 'num' }, formatNombre(p.poids, 'kg')),
              h('td', { class: 'num' }, formatNombre(p.metrage)),
            ),
            p.observations ? h('tr', { class: 'obs' }, h('td', { colSpan: 3 }, p.observations)) : null,
          ].filter((x): x is HTMLTableRowElement => x !== null)),
          b.totaux
            ? h(
                'tr',
                { class: 'total' },
                h('td', {}, `${b.totaux.pieces ?? b.pieces.length} pièce(s)`),
                h('td', { class: 'num' }, formatNombre(b.totaux.poids, 'kg')),
                h('td', { class: 'num' }, formatNombre(b.totaux.metrage)),
              )
            : null,
        ),
      )
    : null

  const meta = [b.bordereau && `BL ${b.bordereau}`, b.commande && `commande ${b.commande}`, b.lot && `lot ${b.lot}`].filter(Boolean).join(' · ')

  const controles = b.controles.length
    ? h('ul', { class: 'checks' }, ...b.controles.map(c => h('li', { class: c.gravite }, c.message)))
    : null

  const links = h(
    'div',
    { class: 'actions small' },
    b.lienCommande ? erpLink(b.lienCommande, 'Ouvrir la commande ↗') : null,
    erpLink(b.lien, 'Détail dans Agents IA ↗'),
  )

  const actions =
    piloter && !form
      ? h(
          'div',
          { class: 'actions' },
          b.statut === 'a_verifier' || b.statut === 'erreur'
            ? h('button', { class: 'btn primary', disabled: state.busy, onclick: () => openForm(key, { kind: 'bl-verifie', commentaire: '' }) }, 'Marquer vérifié…')
            : null,
          b.evaluation?.note !== 'echec'
            ? h('button', { class: 'btn ghost', disabled: state.busy, onclick: () => openForm(key, { kind: 'bl-echec', commentaire: '' }) }, 'Tricobot s’est trompé ?')
            : null,
        )
      : null

  let formEl: HTMLElement | null = null
  if (form?.kind === 'bl-verifie') {
    formEl = commentForm({
      key,
      label: 'Vérifié — comment ?',
      placeholder: 'Ex. pièces réceptionnées à la main (facultatif)',
      form,
      required: false,
      submitLabel: 'Marquer vérifié',
      hint: 'Ce n’est pas une note : le mail passe en « BL traité ».',
      onSubmit: () => void act(key, async () => {
        await send('POST', b.cheminVerifie, { commentaire: form.commentaire.trim() })
        return 'BL marqué vérifié.'
      }),
    })
  } else if (form?.kind === 'bl-echec') {
    formEl = commentForm({
      key,
      label: 'Qu’est-ce qui ne va pas ?',
      placeholder: 'Ex. pièce 3589/4 : poids 20 au lieu de 21,4 (obligatoire)',
      form,
      required: true,
      danger: true,
      submitLabel: 'Enregistrer l’échec',
      hint: 'Rien n’est retiré d’ETM : corrigez la réception dans Sous-traitants si besoin.',
      onSubmit: () => void act(key, async () => {
        await send('PUT', b.cheminEvaluation, { note: 'echec', commentaire: form.commentaire.trim() })
        return 'Merci, la correction est enregistrée pour la prochaine version de Tricobot.'
      }),
    })
  }

  return h(
    'div',
    { class: 'section' },
    h('div', { class: 'section-title' }, b.typeDocument === 'mise_a_dispo' ? 'Mise à disposition' : 'BL ennoblisseur', h('span', { class: 'spacer' }), statutPill(b.statut)),
    h('div', { class: 'headline' }, b.resume),
    meta ? h('div', { class: 'muted small' }, meta) : null,
    pieces,
    controles,
    b.erreur ? h('div', { class: 'error small' }, b.erreur) : null,
    essaiNote(b.mode),
    b.verification
      ? h('div', { class: 'muted small' }, `Vérifié par ${b.verification.par} le ${formatDate(b.verification.le)}`, b.verification.commentaire ? ` — « ${b.verification.commentaire} »` : '')
      : null,
    avisLine(b.evaluation),
    links,
    actions,
    formEl,
  )
}

// ---------------------------------------------------------------- Factures

const ACTION_LABEL: Record<Extract<Form, { kind: 'ligne' }>['action'], { title: string; placeholder: string; submit: string }> = {
  conforme: { title: 'C’est conforme — pourquoi ?', placeholder: 'Ex. prix convenu par mail avec le teinturier (obligatoire)', submit: 'Passer conforme' },
  ecart: { title: 'Écart manqué — lequel ?', placeholder: 'Ce que Tricobot aurait dû voir (obligatoire)', submit: 'Signaler l’écart' },
  corriger: { title: 'L’écart est réel, mais pas pour cette raison', placeholder: 'La vraie raison ou le bon montant (obligatoire)', submit: 'Corriger Tricobot' },
}

function renderLigne(f: Facture, l: LigneFacture, i: number): HTMLElement {
  const key = `ligne:${l.id ?? `${f.runId}-${i}`}`
  const form = state.forms.get(key) as Extract<Form, { kind: 'ligne' }> | undefined
  const v = verdictLigne(l)
  const final = l.verdictFinal && l.verdictFinal !== (l.verdict === 'conforme' ? 'conforme' : 'ecart')
  // Same gestures as Sous-traitants › Factures, while the invoice is open.
  const peut = !!state.conv?.droits.factures && l.id !== null && !f.traitement && l.verdict !== 'info' && !form

  const chemin = l.id !== null ? `/factures-sst/lignes/${l.id}/avis` : ''
  const gestures = peut
    ? h(
        'div',
        { class: 'actions small' },
        l.avis || l.verdictFinal
          ? h('button', { class: 'btn link', disabled: state.busy, onclick: () => void act(key, async () => {
              await send('PUT', chemin, { action: null, commentaire: '' })
              return 'Décision annulée.'
            }) }, 'Annuler ma décision')
          : l.verdict === 'conforme'
            ? h('button', { class: 'btn ghost', disabled: state.busy, onclick: () => openForm(key, { kind: 'ligne', action: 'ecart', commentaire: '' }) }, 'Signaler un écart…')
            : h(
                'span',
                { class: 'actions' },
                h('button', { class: 'btn ghost', disabled: state.busy, onclick: () => openForm(key, { kind: 'ligne', action: 'conforme', commentaire: '' }) }, 'C’est conforme…'),
                h('button', { class: 'btn ghost', disabled: state.busy, onclick: () => openForm(key, { kind: 'ligne', action: 'corriger', commentaire: '' }) }, 'Mauvaise raison…'),
              ),
      )
    : null

  return h(
    'li',
    { class: 'line' },
    h(
      'div',
      { class: 'line-head' },
      h('span', { class: 'lbl' }, l.designation || l.lot || 'Ligne'),
      pill(v.label, v.tone, final ? 'struck' : ''),
      final ? pill(l.verdictFinal === 'conforme' ? 'Conforme' : 'Écart', l.verdictFinal === 'conforme' ? 'ok' : 'bad') : null,
    ),
    h(
      'div',
      { class: 'muted small' },
      [l.lot && `lot ${l.lot}`, l.quantite !== null && `${formatNombre(l.quantite)} ${l.unite}`.trim(), l.prixUnitaire !== null && `× ${formatEuro(l.prixUnitaire)}`, l.montant !== null && `= ${formatEuro(l.montant)}`]
        .filter(Boolean)
        .join(' '),
      l.prixAttendu !== null ? ` · tarif ETM ${formatEuro(l.prixAttendu)}` : '',
      l.ecartMontant ? ` · écart ${formatEuro(l.ecartMontant)}` : '',
    ),
    l.controles.length ? h('ul', { class: 'checks' }, ...l.controles.map(c => h('li', {}, c))) : null,
    avisLine(l.avis, 'Décidé'),
    gestures,
    form
      ? commentForm({
          key,
          label: ACTION_LABEL[form.action].title,
          placeholder: ACTION_LABEL[form.action].placeholder,
          form,
          required: true,
          submitLabel: ACTION_LABEL[form.action].submit,
          onSubmit: () => void act(key, async () => {
            await send('PUT', chemin, { action: form.action, commentaire: form.commentaire.trim() })
            return 'Merci, la décision est enregistrée sur la facture.'
          }),
        })
      : null,
  )
}

function renderFacture(f: Facture): HTMLElement {
  const head = [f.fournisseur, f.numero && `n° ${f.numero}`, f.date && `du ${f.date.split('-').reverse().join('/')}`].filter(Boolean).join(' · ')
  const statut = f.statutFacture
    ? f.statutFacture === 'conforme'
      ? pill('Conforme', 'ok')
      : pill(f.ecartMontant ? `Écarts · ${formatEuro(f.ecartMontant)}` : 'Écarts', 'bad')
    : null
  return h(
    'div',
    { class: 'section' },
    h('div', { class: 'section-title' }, 'Facture ennoblisseur', h('span', { class: 'spacer' }), statut, statutPill(f.statut)),
    h('div', { class: 'headline' }, head || f.resume),
    f.totalHt !== null ? h('div', { class: 'muted small' }, `Total HT ${formatEuro(f.totalHt)}`) : null,
    f.traitement
      ? h('div', { class: 'muted small' }, `${TRAITEMENT_LABEL[f.traitement] ?? f.traitement}${f.traitePar ? ` par ${f.traitePar}` : ''} — lignes figées`)
      : null,
    f.controles.length ? h('ul', { class: 'checks' }, ...f.controles.map(c => h('li', {}, c))) : null,
    f.lignes.length ? h('ul', { class: 'lines' }, ...f.lignes.map((l, i) => renderLigne(f, l, i))) : null,
    f.erreur ? h('div', { class: 'error small' }, f.erreur) : null,
    essaiNote(f.mode),
    h(
      'div',
      { class: 'actions small' },
      erpLink(f.lien, f.idFacture ? 'Ouvrir la facture dans ETM ↗' : 'Détail dans Agents IA ↗'),
      f.idFacture ? erpLink(f.lienRun, 'Lecture de Tricobot ↗') : null,
    ),
  )
}

// ---------------------------------------------------------------- views

function renderHeader(): HTMLElement {
  return h(
    'div',
    { class: 'header' },
    h('img', { src: 'icons/tricobot-avatar.png', alt: '' }),
    h('div', { class: 'brand' }, h('span', { class: 'title' }, 'Tricobot'), h('span', { class: 'tagline' }, 'Agents IA · ETM')),
    h('span', { class: 'spacer' }),
    state.session ? h('span', { class: 'user' }, state.session.prenom || state.session.identifiant) : null,
    h(
      'button',
      {
        class: 'btn icon',
        title: state.view === 'settings' ? 'Retour' : 'Réglages',
        onclick: () => {
          state.view = state.view === 'settings' ? 'main' : 'settings'
          render()
        },
      },
      state.view === 'settings' ? '←' : '⚙',
    ),
  )
}

function renderSettings(): HTMLElement {
  const s = state.settings!
  const api = h('input', { value: s.apiUrl, placeholder: 'https://etm.intra.etsmalterre.com/api' })
  const erp = h('input', { value: s.erpUrl, placeholder: 'https://etm.intra.etsmalterre.com' })
  return h(
    'div',
    { class: 'content' },
    h(
      'div',
      { class: 'form' },
      h('label', {}, 'URL de l’API ETM'),
      api,
      h('label', {}, 'URL d’ETM'),
      erp,
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              await saveSettings({ apiUrl: api.value, erpUrl: erp.value })
              state.settings = await getSettings()
              state.view = 'main'
              await loadConversation()
            },
          },
          'Enregistrer',
        ),
      ),
    ),
    h('p', { class: 'muted small' }, 'Dev : API http://localhost:808N/api, ETM http://localhost:300N (slot N du worktree).'),
    state.session
      ? h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              await logout()
              state.session = null
              state.view = 'main'
              refreshBadge()
              render()
            },
          },
          `Se déconnecter (${state.session.identifiant})`,
        )
      : null,
  )
}

function renderLogin(): HTMLElement {
  const identifiant = h('input', { type: 'text', placeholder: 'Identifiant ou email', autocomplete: 'username' })
  const password = h('input', { type: 'password', placeholder: 'Mot de passe', autocomplete: 'current-password' })
  const submit = async (e: Event) => {
    e.preventDefault()
    state.busy = true
    state.error = null
    render()
    try {
      state.session = await login(identifiant.value.trim(), password.value)
      refreshBadge()
      await loadConversation()
    } catch (err) {
      state.error = (err as Error).message
    } finally {
      state.busy = false
      render()
    }
  }
  return h(
    'div',
    { class: 'content' },
    h('p', {}, 'Connectez-vous avec votre compte ETM pour voir ce que Tricobot a fait de vos mails.'),
    h(
      'form',
      { class: 'auth', onsubmit: submit },
      identifiant,
      password,
      h('button', { class: 'btn primary', type: 'submit', disabled: state.busy }, 'Se connecter'),
    ),
    state.error ? h('div', { class: 'error' }, state.error) : null,
  )
}

// ---------------------------------------------------------------- Conversation

const filCle = (ctx: GmailContext | null): string | null => (ctx?.mailbox && ctx.threadId ? `${ctx.mailbox}|${ctx.threadId}` : null)

async function loadFil(): Promise<void> {
  const cle = filCle(state.context)
  if (!cle || !state.session || state.fil?.cle === cle) {
    render()
    return
  }
  state.fil = null
  state.filErreur = null
  state.filChargement = true
  render()
  try {
    const { messages } = await fetchFil(state.context!.mailbox!, state.context!.threadId!)
    state.fil = { cle, messages }
    state.defilerEnBas = true
  } catch (e) {
    state.filErreur = (e as Error).message
  } finally {
    state.filChargement = false
    render()
  }
}

function changerOnglet(o: Onglet): void {
  if (state.onglet === o) return
  state.onglet = o
  chrome.storage.local.set({ onglet: o }).catch(() => {})
  window.scrollTo(0, 0)
  if (o === 'conversation') {
    state.defilerEnBas = true
    void loadFil()
  } else {
    render()
  }
}

const jour = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
const heure = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' })

function formatTaille(octets: number): string {
  if (octets < 1024) return `${octets} o`
  if (octets < 1024 * 1024) return `${Math.round(octets / 1024)} Ko`
  return `${(octets / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`
}

/** A long mail shows its first lines; « Voir plus » unfolds it. */
const BULLE_LIGNES = 12
const BULLE_CARACTERES = 700

function texteBulle(m: MessageFil): HTMLElement {
  const lignes = m.texte.split('\n')
  const long = lignes.length > BULLE_LIGNES || m.texte.length > BULLE_CARACTERES
  const deplie = state.bullesDepliees.has(m.id)
  let texte = m.texte
  if (long && !deplie) {
    texte = lignes.slice(0, BULLE_LIGNES).join('\n')
    if (texte.length > BULLE_CARACTERES) texte = texte.slice(0, BULLE_CARACTERES)
    texte = `${texte.trimEnd()}…`
  }
  return h(
    'div',
    {},
    h('div', { class: 'bubble-text' }, texte || '(message vide)'),
    long
      ? h(
          'button',
          {
            class: 'btn link',
            onclick: () => {
              if (deplie) state.bullesDepliees.delete(m.id)
              else state.bullesDepliees.add(m.id)
              render()
            },
          },
          deplie ? 'Voir moins' : 'Voir plus',
        )
      : null,
  )
}

function renderBulle(m: MessageFil, agent: Message | undefined): HTMLElement {
  const ctx = state.context!
  const triage = agent?.triage
  const pieces = m.piecesJointes.length
    ? h(
        'div',
        { class: 'attachments' },
        ...m.piecesJointes.map(p =>
          h(
            'button',
            {
              class: 'attachment',
              title: `Ouvrir ${p.nom}`,
              onclick: () =>
                ouvrirPieceJointe(ctx.mailbox!, ctx.threadId!, m.id, p.n).catch((e: Error) => {
                  state.error = e.message
                  render()
                }),
            },
            `📎 ${p.nom}`,
            h('span', { class: 'muted' }, ` · ${formatTaille(p.taille)}`),
          ),
        ),
      )
    : null
  return h(
    'div',
    { class: `bubble-row ${m.interne ? 'out' : 'in'}` },
    h(
      'div',
      { class: 'bubble', title: [m.a && `À : ${m.a}`, m.cc && `Cc : ${m.cc}`].filter(Boolean).join('\n') },
      h('div', { class: 'bubble-from' }, nomExpediteur(m.de)),
      texteBulle(m),
      pieces,
      h(
        'div',
        { class: 'bubble-foot' },
        triage
          ? h(
              'button',
              { class: 'pill label tricobot', title: 'Ce que Tricobot en a fait', onclick: () => changerOnglet('agent') },
              triage.categories.map(categoryLabel).join(', '),
            )
          : null,
        h('span', { class: 'time' }, heure.format(new Date(m.date))),
      ),
    ),
  )
}

function renderConversation(): HTMLElement {
  if (!state.context?.threadId || !state.context.mailbox) {
    return h('div', { class: 'empty' }, 'Conversation introuvable dans Gmail.')
  }
  if (state.filErreur) {
    return h(
      'div',
      { class: 'error' },
      state.filErreur,
      ' ',
      h('button', { class: 'btn link', onclick: () => void loadFil() }, 'Réessayer'),
    )
  }
  if (state.filChargement || !state.fil) return h('div', { class: 'empty' }, 'Lecture du fil dans Gmail…')
  const parId = new Map((state.conv?.messages ?? []).map(m => [m.id, m]))
  const chat = h('div', { class: 'chat' })
  let jourPrecedent = ''
  for (const m of state.fil.messages) {
    const j = jour.format(new Date(m.date))
    if (j !== jourPrecedent) {
      chat.append(h('div', { class: 'day' }, h('span', {}, j)))
      jourPrecedent = j
    }
    chat.append(renderBulle(m, parId.get(m.id)))
  }
  return chat
}

function renderOnglets(): HTMLElement {
  const onglet = (o: Onglet, icone: Element, libelle: string) =>
    h('button', { class: `tab${state.onglet === o ? ' on' : ''}`, onclick: () => changerOnglet(o) }, icone, h('span', {}, libelle))
  // Static markup, no data in it: a chat bubble.
  const bulle = h('span', { class: 'tab-icon' })
  bulle.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>'
  return h(
    'nav',
    { class: 'tabs' },
    onglet('agent', h('img', { class: 'tab-icon', src: 'icons/tricobot-32.png', alt: '' }), 'Agent'),
    onglet('conversation', bulle, 'Conversation'),
  )
}

function renderMessage(m: Message): HTMLElement {
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('strong', {}, nomExpediteur(m.de)), ` · ${formatDate(m.date)}`),
    m.triage ? renderTriage(m.triage) : null,
    ...m.bl.map(renderBl),
    ...m.factures.map(renderFacture),
  )
}

function renderMain(): HTMLElement {
  const content = h('div', { class: 'content' })
  if (!state.context && state.orphan) {
    content.append(
      h('div', { class: 'empty' }, 'L’extension a été mise à jour : rechargez l’onglet Gmail pour que Tricobot le retrouve.',
        h('div', {}, h('button', { class: 'btn primary', onclick: () => state.tabId !== null && void chrome.tabs.reload(state.tabId) }, 'Recharger Gmail'))),
    )
    return content
  }
  if (!state.context) {
    content.append(h('div', { class: 'empty' }, 'Ouvrez une conversation dans Gmail (contact@) pour voir ce que Tricobot en a fait.'))
    return content
  }
  content.append(
    h(
      'div',
      { class: 'subject' },
      state.context.subject ?? '',
      state.context.mailbox ? h('span', { class: 'mailbox' }, state.context.mailbox) : null,
    ),
  )
  if (state.notice) content.append(h('div', { class: 'notice' }, state.notice))
  if (state.error) {
    content.append(
      h('div', { class: 'error' }, state.error, ' ', h('button', { class: 'btn link', onclick: () => void loadConversation() }, 'Réessayer')),
    )
  }
  if (state.loading && !state.conv) {
    content.append(h('div', { class: 'empty' }, 'Chargement…'))
    return content
  }
  if (state.conv && !state.conv.suivie) {
    content.append(h('div', { class: 'empty' }, `Tricobot ne lit pas encore la boîte ${state.conv.boite ?? 'ouverte'}.`))
    return content
  }
  if (state.onglet === 'conversation') {
    content.append(renderConversation())
    return content
  }
  if (state.conv && state.conv.messages.length === 0) {
    content.append(h('div', { class: 'empty' }, 'Tricobot n’a pas traité cette conversation.'))
  }
  // Newest first: the mail just opened is usually the latest one.
  for (const m of [...(state.conv?.messages ?? [])].reverse()) content.append(renderMessage(m))
  return content
}

function render(): void {
  const app = document.getElementById('app')!
  // Typing never re-renders (commentForm updates its button in place), so
  // replacing every node here loses no focus; the scroll is put back.
  const y = window.scrollY
  const onglets = state.view === 'main' && !!state.session && !!state.context && state.conv?.suivie !== false
  const body = state.view === 'settings' ? renderSettings() : state.session ? renderMain() : renderLogin()
  app.replaceChildren(renderHeader(), body, onglets ? renderOnglets() : '')
  document.body.classList.toggle('with-tabs', onglets)
  if (state.defilerEnBas && state.onglet === 'conversation' && state.fil) {
    state.defilerEnBas = false
    window.scrollTo(0, document.body.scrollHeight)
  } else {
    window.scrollTo(0, y)
  }
}

// ---------------------------------------------------------------- wiring

async function reloadForTab(): Promise<void> {
  state.forms.clear()
  state.raisonsOuvertes.clear()
  state.bullesDepliees.clear()
  state.notice = null
  await loadContext()
  await loadConversation()
  if (state.onglet === 'conversation') await loadFil()
}

chrome.tabs.onActivated.addListener(() => void reloadForTab())

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && state.tabId !== null && contextKey(state.tabId) in changes) {
    const next = (changes[contextKey(state.tabId)].newValue as GmailContext | null | undefined) ?? null
    if (JSON.stringify(next) !== JSON.stringify(state.context)) void reloadForTab()
  }
  if (area === 'local' && 'session' in changes && !changes.session.newValue && state.session) {
    state.session = null
    render()
  }
})

async function init(): Promise<void> {
  state.settings = await getSettings()
  state.session = await getSession()
  try {
    const { onglet } = await chrome.storage.local.get('onglet')
    if (onglet === 'agent' || onglet === 'conversation') state.onglet = onglet
  } catch {
    // The last tab is a convenience: the panel opens on « Agent » without it.
  }
  await reloadForTab()
}

void init()
