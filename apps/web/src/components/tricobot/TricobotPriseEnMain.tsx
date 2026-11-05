// Tricobot takes over an order (claude_doc/agents_autonomie.md §6).
//
// Not a panel in the page: Tricobot comes OVER the software (Vincent,
// 2026-11-05 — « une vraie nouvelle entité qui vient par-dessus le
// logiciel »). The DETAIL goes dark — header, lines, right panel — while the
// list of cards on the left stays usable, so the person can move to another
// order. Only what he wrote stays lit (the line's délai, ringed in red).
// Tricobot stands on the left, big, and speaks: his bubble starts at his head.
// The mail he read fills the right-hand side, the words he relied on marked.
//
// Positions are read from the page:
//   [data-tricobot-liste]           the left list — the veil starts after it
//                                   (absent in stacked mode: the whole content);
//   [data-tricobot-cible="<id>"]    the délai on the line card, else
//   [data-tricobot-ligne="<id>"]    the whole line;
// all followed every frame (scroll, resize, a drawer opening).
// Escape or « Plus tard » lets the person look at the order first.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, Eye, Loader2, Mail, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { cn } from '@/lib/utils'
import { CHAMPS_MESURES, GesteDialog, jj, lireMesures, MailTricobotDialog, messageErreur, useGeste, useMailLu, type Geste, type SaisieTricobot } from './SaisiesTricobot'

/** Room around a lit value. */
const PAD = 8
/** The app header (h-14). */
const HAUT_ENTETE = 56
const MASCOTTE = 160
const LARGEUR_MAIL = 400
const LARGEUR_BULLE = 560

type Zone = { left: number; top: number; width: number; height: number }

const memes = (a: Zone[], b: Zone[]) =>
  a.length === b.length && a.every((r, i) => r.top === b[i].top && r.left === b[i].left && r.width === b[i].width && r.height === b[i].height)

const versZone = (r: DOMRect): Zone => ({ left: r.left, top: r.top, width: r.width, height: r.height })

/** The veiled zone and the lit values, followed every frame. [zone, ...cibles] */
function useMesures(idlignes: number[]): Zone[] {
  const [mesures, setMesures] = useState<Zone[]>([])
  const cle = [...new Set(idlignes)].join(',')
  useLayoutEffect(() => {
    let raf = 0
    const ids = cle ? cle.split(',') : []
    const mesurer = () => {
      const liste = document.querySelector('[data-tricobot-liste]')?.getBoundingClientRect()
      const visible = liste && liste.width > 0
      const left = visible ? liste.right + 8 : 0
      const top = visible ? liste.top - 8 : HAUT_ENTETE
      const out: Zone[] = [{ left, top, width: window.innerWidth - left, height: window.innerHeight - top }]
      for (const id of ids) {
        const el = document.querySelector(`[data-tricobot-cible="${id}"]`) ?? document.querySelector(`[data-tricobot-ligne="${id}"]`)
        if (el) out.push(versZone(el.getBoundingClientRect()))
      }
      setMesures((prev) => (memes(prev, out) ? prev : out))
      raf = requestAnimationFrame(mesurer)
    }
    mesurer()
    return () => cancelAnimationFrame(raf)
  }, [cle])
  return mesures
}

/** The mail body with the words Tricobot relied on marked. */
function TexteMarque({ texte, citations }: { texte: string; citations: string[] }) {
  const morceaux = useMemo(() => {
    const cs = [...new Set(citations.map((c) => c.trim()).filter((c) => c.length >= 2))]
    if (!cs.length) return [texte]
    const re = new RegExp(`(${cs.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
    return texte.split(re)
  }, [texte, citations])
  const cs = citations.map((c) => c.trim().toLowerCase())
  return (
    <>
      {morceaux.map((m, i): ReactNode => (cs.includes(m.toLowerCase())
        ? <mark key={i} className="rounded bg-red-500 px-0.5 font-semibold text-white">{m}</mark>
        : <span key={i}>{m}</span>))}
    </>
  )
}

const jjmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
const heure = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '')

/** The conversation Tricobot read: our Point (the question, §5 only, the
 *  orders he wrote on lit), then the dyer's reply (the words he relied on lit). */
function MailPanneau({ runId, citations, idlignes, section }: { runId: string | null; citations: string[]; idlignes: number[]; section: 2 | 5 }) {
  const q = useMailLu(runId)
  const point = q.data?.point ?? null
  const question = point ? (point.sections?.[String(section) as '2' | '5'] ?? (section === 5 ? { titre: point.titre, lignes: point.lignes } : null)) : null
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-black/10">
      <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5">
        <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center bg-gold text-gold-foreground shadow-sm"><Mail className="h-[18px] w-[18px]" /></div>
        <div className="min-w-0 flex-1">
          <p className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">Les mails que j’ai lus</p>
          <p className="text-xs text-white/70 truncate">{q.data ? q.data.sujet : '…'}</p>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent bg-zinc-100 p-3 space-y-3">
        {q.isLoading && <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>}
        {q.isError && <p className="text-sm text-destructive">{messageErreur(q.error)}</p>}
        {point && (
          <div className="rounded-lg border bg-white p-3 shadow-sm">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">La question · notre Point du {jjmm(point.jour)}</p>
            <p className="text-xs text-muted-foreground">Envoyé{point.envoyeLe ? ` à ${heure(point.envoyeLe)}` : ''}{point.envoyePar ? ` par ${point.envoyePar}` : ''}</p>
            <p className="mt-2 text-sm font-medium">{section}) {question?.titre}</p>
            <ul className="mt-1 space-y-0.5">
              {(question?.lignes ?? []).map((l, i) => {
                const lue = idlignes.includes(l.idligne)
                return (
                  <li key={i} className={cn('rounded px-1.5 py-0.5 text-sm', lue ? 'bg-red-500 font-semibold text-white' : 'text-muted-foreground')}>
                    Cde {l.commande} · {l.article}{l.commentaire ? ` · ${l.commentaire}` : ''}
                  </li>
                )
              })}
              {(question?.lignes.length ?? 0) === 0 && <li className="text-sm italic text-muted-foreground">Aucune commande en section {section}.</li>}
            </ul>
          </div>
        )}
        {q.data && (
          <div className="rounded-lg border bg-white p-3 shadow-sm">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">La réponse · {q.data.de.replace(/<.*>/, '').trim() || q.data.de}</p>
            <p className="text-xs text-muted-foreground">Reçue le {new Date(q.data.date).toLocaleString('fr-FR')}</p>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed"><TexteMarque texte={q.data.texte || '(mail vide)'} citations={citations} /></pre>
          </div>
        )}
      </div>
    </div>
  )
}

/** How Tricobot got from the mail to this line, step by step — the chain the
 *  code really follows (lib/agents/flux-ennoblisseur/delais.ts), so a person
 *  can check it: which question, which answer, which rule. */
function Raisonnement({ s }: { s: SaisieTricobot }) {
  const q = useMailLu(s.runId)
  const point = q.data?.point ?? null
  const etapes: ReactNode[] = []
  if (s.competence === 'controles') {
    // Contrôles: §2 « Puis-je avoir vos contrôles… », the lot's line in the reply.
    const lu = q.data?.controles?.find((c) => c.idsuivilot === s.idsuivilot)
    const n = point?.sections?.['2']?.lignes.length ?? 0
    if (point) {
      etapes.push(lu?.demande === false
        ? <>C’est la réponse à notre <span className="font-semibold">Point du {jjmm(point.jour)}</span>. Ce lot n’y était pas demandé : l’ennoblisseur a donné ses mesures de lui-même.</>
        : <>C’est la réponse à notre <span className="font-semibold">Point du {jjmm(point.jour)}</span>, qui demandait en section 2 les contrôles de {n > 1 ? <>{n} commandes, dont celle de ce lot</> : <>la commande de ce lot</>}.</>)
    }
    if (s.citation) etapes.push(<>En section 2, il a écrit : <span className="font-semibold">« {s.citation.replace(/\s+/g, ' ')} »</span>.</>)
  } else {
    // Délais: §5 « Pouvez-vous me confirmer les délais… ».
    const lu = q.data?.delais.find((d) => d.idligne === s.idligne)
    const commande = point?.lignes.find((l) => l.idligne === s.idligne)?.commande ?? lu?.commande ?? null
    const n = point?.lignes.length ?? 0
    if (point) {
      etapes.push(<>C’est la réponse à notre <span className="font-semibold">Point du {jjmm(point.jour)}</span>, qui demandait en section 5 le délai de {n > 1 ? <>{n} commandes, dont la <span className="font-semibold">{commande}</span></> : <>la commande <span className="font-semibold">{commande}</span></>}.</>)
    }
    if (s.citation) {
      etapes.push(
        lu?.nommee === true
          ? <>Sa réponse nomme la commande {commande} : <span className="font-semibold">« {s.citation} »</span>.</>
          : lu?.nommee === false && n > 1
          ? <>Sa réponse, <span className="font-semibold">« {s.citation} »</span>, ne nomme aucune commande : elle vaut pour les {n}.</>
          : <>L’ennoblisseur a répondu <span className="font-semibold">« {s.citation} »</span>.</>,
      )
    }
  }
  etapes.push(<span className={s.decision === 'aide' ? 'font-medium text-red-700' : undefined}>{s.decision === 'aide' ? 'Je ne suis pas sûr : ' : ''}{s.explication}</span>)
  return (
    <ol className="mt-1 space-y-1">
      {etapes.map((e, i) => (
        <li key={i} className="flex gap-2 text-sm">
          <span className="mt-0.5 h-4 w-4 flex-shrink-0 rounded-full bg-zinc-200 text-[10px] font-semibold flex items-center justify-center text-muted-foreground">{i + 1}</span>
          <span className="min-w-0">{e}</span>
        </li>
      ))}
    </ol>
  )
}

/** A proposal he could apply as is: a date, or every measure read (laize, poids, both stabilités). */
function propositionComplete(s: SaisieTricobot): boolean {
  if (!s.proposition) return false
  if (s.champ !== 'mesures_sst') return /^\d{4}-\d{2}-\d{2}$/.test(s.proposition)
  const m = lireMesures(s.proposition)
  return !!m && [m.laize, m.poids, m.stabH, m.stabL].every((v) => typeof v === 'number')
}

/** What he wrote: a délai (before → after), or the dyer's measures (a small table). */
function Valeur({ s }: { s: SaisieTricobot }) {
  if (s.champ === 'mesures_sst') {
    // Two rows: what is on the lot today, then what he proposes. Only the values
    // he would change are struck and in red; the same value stays plain.
    const avant = lireMesures(s.valeurAvant)
    const apres = lireMesures(s.proposition)
    // In a proposal, a measure he could not read is « ? » (never a 0); an absent vrillage is « — ».
    const fmt = (v: number | null | undefined, cle?: string, proposee = false) =>
      v == null ? (proposee && s.decision === 'aide' && cle !== 'vrillage' ? '?' : '—') : String(v).replace('.', ',')
    const change = (cle: keyof NonNullable<typeof avant>) => !!avant && !!apres && (avant[cle] ?? null) !== (apres[cle] ?? null)
    return (
      <div className="ml-auto grid grid-cols-[auto_repeat(5,minmax(0,1fr))] items-baseline gap-x-3 text-right text-xs tabular-nums">
        <span />
        {CHAMPS_MESURES.map((c) => <span key={c.cle} className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.libelle}</span>)}
        {avant && (
          <>
            <span className="text-left text-[10px] text-muted-foreground">sur le lot</span>
            {CHAMPS_MESURES.map((c) => (
              <span key={c.cle} className={cn('text-muted-foreground', change(c.cle) && 'line-through')}>{fmt(avant[c.cle])}</span>
            ))}
          </>
        )}
        <span className="text-left text-[10px] text-muted-foreground">{s.decision === 'saisie' ? 'je saisis' : 'je propose'}</span>
        {CHAMPS_MESURES.map((c) => {
          const inconnue = apres?.[c.cle] == null && c.cle !== 'vrillage'
          return (
            <span key={c.cle} className={cn('font-semibold', (avant ? change(c.cle) : s.decision === 'saisie') || inconnue ? 'text-red-600' : 'text-foreground')}>
              {fmt(apres?.[c.cle], c.cle, true)}
            </span>
          )
        })}
      </div>
    )
  }
  // A délai: what the line says today (struck) → what he writes or proposes.
  const avant = s.valeurAvant ? jj(s.valeurAvant) : 'sans délai'
  if (!s.proposition) return null
  return (
    <span className="ml-auto flex items-center gap-1.5 text-sm tabular-nums">
      <span className="text-muted-foreground line-through">{avant}</span>
      <span>→</span>
      <span className={cn('rounded px-1.5 font-semibold', s.decision === 'saisie' ? 'bg-red-500 text-white' : 'border border-red-500 text-red-600')}>
        {s.decision === 'aide' && <span className="mr-1 text-[10px] font-normal">je propose</span>}{jj(s.proposition)}
      </span>
    </span>
  )
}

/** A click that would WRITE (an action, a field, a status) — as opposed to
 *  reading (scroll, hover, a tab). Elements of reading that happen to be
 *  buttons are marked `data-tricobot-lecture` (or are ARIA tabs). */
const ECRIT = 'button, a[href], input, select, textarea, label, [contenteditable="true"], [role="button"], [role="switch"], [role="checkbox"], [role="combobox"], [role="menuitem"], [role="option"]'
const LECTURE = '[role="tab"], [data-tricobot-lecture]'
function ecrit(cible: EventTarget | null): boolean {
  const el = cible instanceof Element ? cible : null
  if (!el) return false
  if (el.closest(LECTURE)) return false
  return !!el.closest(ECRIT)
}

/** Tricobot's speech bubble. */
const BULLE = 'rounded-2xl bg-white p-4 shadow-2xl ring-2 ring-red-500'

/** The tail of his bubble, slanting down and left so the words come out
 *  of his mouth. Above the bubble (z-10) so its white base covers the bubble's
 *  red ring where they join; only the two outer edges are stroked. */
function Queue() {
  return (
    <svg className="absolute -left-[22px] bottom-[92px] z-10 h-[26px] w-[26px] overflow-visible" viewBox="0 0 26 26" aria-hidden>
      <path d="M26 0 L0 26 L26 16 Z" fill="white" />
      <path d="M24 1 L0 26 L24 16.8" fill="none" stroke="rgb(239 68 68)" strokeWidth={2} strokeLinejoin="round" />
    </svg>
  )
}

/** `libelle(s)` names what he wrote on (« 029A - vert sauge », « Lot MA109516 »). */
export function TricobotPriseEnMain({ saisies, libelle, onChanged, sujet = 'commande' }: {
  saisies: SaisieTricobot[]
  libelle: (s: SaisieTricobot) => string
  onChanged?: () => void
  /** What he took over: « cette commande » (Délais) or « ce lot » (Contrôles). */
  sujet?: 'commande' | 'lot'
}) {
  const geste = useGeste(onChanged)
  // The mail on the right is the one these saisies came from: it follows the
  // card opened (the screens key this component by order / lot).
  const mailRun = saisies[0]?.runId ?? null
  const [dialog, setDialog] = useState<{ s: SaisieTricobot; action: Geste['action'] } | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  /** Narrow screens: no room for the mail beside him, it opens in a dialog. */
  const [mailDialog, setMailDialog] = useState<string | null>(null)
  /** « Regarder le détail » (a click on the veil, hinted at its foot —
   *  Vincent, 2026-11-05): veil, bubble and mail go, Tricobot waits in a pill
   *  at the bottom left, and the detail can be read and scrolled freely. Any
   *  gesture that would write in it (Modifier, an action, a field, the status)
   *  does not happen: Tricobot comes back instead. The list stays free. */
  const [consultation, setConsultation] = useState(false)
  /** An aide being settled: first what to write (`valeur`), then « Tu as bien
   *  fait de me demander ? » — asked apart, the Discernement measure (a right
   *  proposal can still have been worth asking about, Vincent 2026-11-05). */
  const [choix, setChoix] = useState<{ id: number; valeur: string | null; quoi: string; commentaire: string } | null>(null)
  const [avisJustifie, setAvisJustifie] = useState<boolean | null>(null)
  const [pourquoiAvis, setPourquoiAvis] = useState('')
  const choisir = (c: { id: number; valeur: string | null; quoi: string; commentaire?: string }) => {
    setChoix({ ...c, commentaire: c.commentaire ?? '' })
    setAvisJustifie(null)
    setPourquoiAvis('')
  }
  /** When a writing gesture brought him back: the rest of that click must not land on the veil. */
  const retourLe = useRef(0)
  const [zone, ...cibles] = useMesures(saisies.map((s) => s.idligne).filter((x) => x > 0))

  // While consulting: catch every writing gesture inside the detail before it acts.
  useEffect(() => {
    if (!consultation || !zone) return
    const dedans = (x: number, y: number) => x >= zone.left && x <= zone.left + zone.width && y >= zone.top && y <= zone.top + zone.height
    const pointeur = (e: MouseEvent | PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-tricobot-pastille]')) return
      if (!dedans(e.clientX, e.clientY) || !ecrit(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type === 'pointerdown') { retourLe.current = Date.now(); setConsultation(false) }
    }
    const focus = (e: FocusEvent) => {
      const el = e.target as Element | null
      if (!el?.getBoundingClientRect || el.closest('[data-tricobot-pastille]')) return
      const r = el.getBoundingClientRect()
      if (!dedans(r.left + r.width / 2, r.top + r.height / 2) || !ecrit(el)) return
      ;(el as HTMLElement).blur?.()
      setConsultation(false)
    }
    window.addEventListener('pointerdown', pointeur, true)
    window.addEventListener('mousedown', pointeur, true)
    window.addEventListener('click', pointeur, true)
    window.addEventListener('focusin', focus, true)
    return () => {
      window.removeEventListener('pointerdown', pointeur, true)
      window.removeEventListener('mousedown', pointeur, true)
      window.removeEventListener('click', pointeur, true)
      window.removeEventListener('focusin', focus, true)
    }
  }, [consultation, zone?.left, zone?.top, zone?.width, zone?.height])

  const lancer = (g: Geste) => {
    setErreur(null)
    geste.mutate(g, { onSuccess: () => setDialog(null), onError: (e) => setErreur(messageErreur(e)) })
  }
  if (!zone) return null
  const aRevoir = saisies.filter((s) => s.statut === 'a_revoir')
  const citations = saisies.filter((s) => s.runId === mailRun).map((s) => s.citation)
  const controles = saisies[0]?.competence === 'controles'
  const ce = sujet === 'lot' ? 'ce lot' : 'cette commande'

  // Inside the zone: the mail on the right when there is room, Tricobot and
  // his bubble under the lit values on the left.
  const avecMail = zone.width >= 1000
  const largeurMail = avecMail ? Math.min(LARGEUR_MAIL, zone.width * 0.34) : 0
  const gauche = 16
  const largeurParole = Math.min(MASCOTTE + LARGEUR_BULLE, zone.width - largeurMail - 3 * 16)
  const basCibles = cibles.length ? Math.max(...cibles.map((r) => r.top + r.height)) - zone.top : 80
  const haut = Math.max(16, Math.min(basCibles + PAD + 20, zone.height - 460))

  if (consultation) {
    // Reading the detail: only the pill, at the bottom left of the detail.
    return createPortal(
      <button
        type="button"
        data-tricobot-pastille
        onClick={() => setConsultation(false)}
        className="fixed z-[45] flex items-center gap-2 rounded-full bg-white py-1.5 pl-1.5 pr-4 shadow-2xl ring-2 ring-red-500 transition-transform hover:scale-[1.02] animate-in slide-in-from-bottom-4 fade-in-0 duration-300"
        style={{ left: zone.left + 16, top: zone.top + zone.height - 76 }}
        title="Reprendre"
      >
        <TricobotMascot className="h-12 w-12" />
        <span className="text-left leading-tight">
          <span className="block text-[11px] font-bold uppercase tracking-wide text-red-600">Tricobot attend ta validation</span>
          <span className="block text-sm font-semibold text-foreground underline underline-offset-2">Reprendre</span>
        </span>
      </button>,
      document.body,
    )
  }

  return createPortal(
    <>
    <div
      className="fixed z-[45] animate-in fade-in-0 duration-300"
      style={{ left: zone.left, top: zone.top, width: zone.width, height: zone.height }}
      role="dialog"
      aria-modal
      aria-label={`Tricobot a pris la main sur ${ce}`}
    >
      {/* The veil over the detail: a click on it = look at the detail. */}
      <div
        className="absolute inset-0 rounded-xl bg-slate-900/70 cursor-pointer"
        title="Clique pour regarder le détail"
        onClick={() => { if (Date.now() - retourLe.current > 500) setConsultation(true) }}
      />
      {/* How to look under the veil, said once, discreetly (no button in the bubble). */}
      <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-slate-900/50 px-3 py-1 text-xs text-white/80">
        <Eye className="h-3.5 w-3.5" />Clique sur le fond pour regarder le détail
      </p>

      {/* Tricobot speaking: he stands on the left, at the foot of his bubble. */}
      {(
      <div className="absolute flex items-end" style={{ left: gauche, top: haut, width: largeurParole }}>
        <TricobotMascot className="relative z-10 -mb-4 h-40 w-40 flex-shrink-0 drop-shadow-2xl animate-in slide-in-from-left-6 fade-in-0 duration-500" />
        {/* One bubble: what he did (the order line), then — its own section —
            why, with the gestures. */}
        <div className="relative -ml-3 min-w-0 flex-1">
          <Queue />
          <div className={cn(BULLE, 'relative')}>
            <p className="text-[11px] font-bold uppercase tracking-wide text-red-600">Tricobot a pris la main sur {ce}</p>
            <p className="mt-0.5 text-sm font-semibold">
              {aRevoir.length > 0 && aRevoir.every((x) => x.decision === 'aide')
                ? `Je n’ai rien ${controles ? 'reporté' : 'saisi'} : j’ai besoin de ton avis sur ${controles ? 'les contrôles' : aRevoir.length > 1 ? 'les délais' : 'le délai'} de l’ennoblisseur${avecMail ? ' (son mail, à droite)' : ''}.`
                : controles
                ? (aRevoir.length
                  ? `Je te propose les contrôles de l’ennoblisseur, d’après son mail${avecMail ? ' à droite' : ''}. Rien n’est écrit tant que tu n’as pas validé.`
                  : 'J’ai reporté ces contrôles seul. Tu peux encore les corriger.')
                : (aRevoir.length
                  ? `Je te propose ${aRevoir.length > 1 ? `${aRevoir.length} délais` : 'ce délai'}, d’après le mail de l’ennoblisseur${avecMail ? ' à droite' : ''}. Rien n’est écrit tant que tu n’as pas validé.`
                  : 'J’ai saisi ce délai seul. Tu peux encore le corriger.')}
            </p>

            {saisies.map((s) => (
              <div key={s.id} className="mt-3">
                {/* What he wrote. */}
                <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-zinc-50 px-2.5 py-2">
                  <span className="min-w-0 truncate text-sm font-medium">{libelle(s)}</span>
                  <Valeur s={s} />
                </div>

                {/* Why — its own section. */}
                <div className="mt-3 border-t border-border/60 pt-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Mon raisonnement</p>
                  <Raisonnement s={s} />
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {/* The mail on the right follows the card opened; only a narrow screen,
                        with no room for it, opens it on demand. */}
                    {!avecMail && (
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setMailDialog(s.runId)}><Mail className="mr-1 h-3.5 w-3.5" />Voir le mail</Button>
                    )}
                    <span className="ml-auto" />
                    {s.decision === 'saisie' && (
                      <>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-destructive hover:text-destructive" disabled={geste.isPending} onClick={() => setDialog({ s, action: 'supprimer' })}><Trash2 className="mr-1 h-3.5 w-3.5" />Supprimer</Button>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={geste.isPending} onClick={() => setDialog({ s, action: 'corriger' })}><Pencil className="mr-1 h-3.5 w-3.5" />Modifier</Button>
                        {s.statut === 'a_revoir' && (
                          <Button size="sm" className="h-7 px-2 text-xs" disabled={geste.isPending} onClick={() => lancer({ id: s.id, action: 'valider' })}><Check className="mr-1 h-3.5 w-3.5" />Valider</Button>
                        )}
                      </>
                    )}
                    {s.decision === 'aide' && choix?.id !== s.id && (
                      <>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={geste.isPending} onClick={() => choisir({ id: s.id, valeur: null, quoi: 'tu ne saisis rien' })}>Ne rien saisir</Button>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={geste.isPending} onClick={() => setDialog({ s, action: 'trancher' })}><Pencil className="mr-1 h-3.5 w-3.5" />Saisir autre chose</Button>
                        {propositionComplete(s) && (
                          <Button size="sm" className="h-7 px-2 text-xs" disabled={geste.isPending} onClick={() => choisir({ id: s.id, valeur: s.proposition, quoi: 'tu appliques ma proposition' })}><Check className="mr-1 h-3.5 w-3.5" />Appliquer ma proposition</Button>
                        )}
                      </>
                    )}
                  </div>

                  {/* Then Tricobot asks whether asking was right (Discernement). */}
                  {s.decision === 'aide' && choix?.id === s.id && (
                    <div className="mt-3 rounded-lg border border-red-200 bg-red-50/60 p-3 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        D’accord, <span className="font-semibold text-foreground">{choix.quoi}</span>.{' '}
                        <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setChoix(null)}>Changer</button>
                      </p>
                      {/* The question and its answer on one line: the text wraps, the buttons stay beside it. */}
                      <div className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 text-sm font-semibold">Avais-je raison de demander ton avis ?</p>
                        <Button size="sm" variant={avisJustifie === true ? 'default' : 'outline'} className="h-7 flex-shrink-0 px-3 text-xs" onClick={() => setAvisJustifie(true)}>Oui</Button>
                        <Button size="sm" variant={avisJustifie === false ? 'default' : 'outline'} className="h-7 flex-shrink-0 px-3 text-xs" onClick={() => setAvisJustifie(false)}>Non</Button>
                      </div>
                      {avisJustifie !== null && (
                        <textarea
                          rows={2}
                          autoFocus
                          value={pourquoiAvis}
                          onChange={(e) => setPourquoiAvis(e.target.value)}
                          placeholder={avisJustifie ? 'Qu’est-ce qui rendait ce cas douteux ? (facultatif)' : 'Qu’est-ce qui m’aurait permis de décider seul ? (obligatoire)'}
                          className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                        />
                      )}
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          className="h-7 px-3 text-xs"
                          disabled={geste.isPending || avisJustifie === null || (avisJustifie === false && !pourquoiAvis.trim())}
                          onClick={() => lancer({ id: s.id, action: 'trancher', valeur: choix.valeur, commentaire: choix.commentaire, justifie: avisJustifie!, pourquoiAvis })}
                        >
                          {geste.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Envoyer à Tricobot
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {erreur && !dialog && <p className="mt-2 flex items-center gap-1.5 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{erreur}</p>}
          </div>
        </div>
      </div>
      )}

      {/* The mail he read, where the right-hand panel was. */}
      {avecMail && (
        <div className="absolute bottom-4 right-4 top-4 animate-in slide-in-from-right-6 fade-in-0 duration-500" style={{ width: largeurMail }}>
          <MailPanneau runId={mailRun} citations={citations} idlignes={saisies.filter((x) => x.runId === mailRun).map((x) => x.idligne)} section={controles ? 2 : 5} />
        </div>
      )}
    </div>
      {/* Dialogs outside the veiled zone: they centre on the screen, above it. */}
      <GesteDialog
        open={!!dialog}
        titre={dialog?.action === 'supprimer' ? 'Supprimer la saisie de Tricobot' : controles ? (dialog?.action === 'trancher' ? 'Saisir les mesures de l’ennoblisseur' : 'Corriger les mesures') : dialog?.action === 'trancher' ? 'Saisir le délai' : 'Corriger le délai'}
        avecDate={dialog?.action !== 'supprimer'}
        dateInitiale={dialog?.s.proposition}
        mesuresInitiales={controles ? lireMesures(dialog?.s.proposition ?? null) : undefined}
        pourquoiFacultatif={dialog?.action === 'trancher'}
        libelle={dialog?.action === 'supprimer' ? 'Supprimer' : 'Enregistrer'}
        isPending={geste.isPending}
        error={dialog ? erreur : null}
        onClose={() => { setDialog(null); setErreur(null) }}
        onConfirm={(date, pourquoi) => {
          if (!dialog) return
          if (dialog.action === 'trancher') { choisir({ id: dialog.s.id, valeur: date, quoi: 'tu saisis autre chose', commentaire: pourquoi }); setDialog(null); return }
          lancer({ id: dialog.s.id, action: dialog.action, valeur: date, commentaire: pourquoi })
        }}
      />
      <MailTricobotDialog runId={mailDialog} onClose={() => setMailDialog(null)} />
    </>,
    document.body,
  )
}
