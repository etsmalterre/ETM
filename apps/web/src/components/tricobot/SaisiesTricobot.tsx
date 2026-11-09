// What Tricobot wrote or asked on a sous-traitant order, and the gestures that
// judge it (claude_doc/agents_autonomie.md; API routes/tricobot-saisies.ts).
//
//   - the card pill: red « Tricobot : délai à valider » / « Tricobot demande
//     ton avis » (a Malterre action, now — doctrine §6), a neutral mascot when
//     Tricobot wrote alone;
//   - the revue on the order: each point with what was there before, what
//     Tricobot wrote (or proposes), the dyer's words, « Voir le mail », and the
//     gestures — Valider / Modifier / Supprimer, or Saisir / Pas de délai for an
//     aide. Validating = fiabilité 1/1, Modifier / Supprimer = 0/1 (why required);
//   - « Mails lus par Tricobot »: the replies he read without writing anything,
//     to confirm or flag an omission (the error nobody sees otherwise).

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, Loader2, Mail, Pencil, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

export interface SaisieTricobot {
  id: number
  runId: string
  creeLe: string
  mode: 'supervise' | 'autonome'
  decision: 'saisie' | 'rien' | 'aide'
  idcommande: number
  idligne: number
  /** Contrôles: the lot whose dyer measures were written. */
  idsuivilot: number
  competence: string
  champ: string | null
  valeurAvant: string | null
  proposition: string | null
  explication: string
  citation: string
  statut: 'a_revoir' | 'autonome' | 'validee' | 'corrigee' | 'supprimee' | 'omission' | 'resolue'
  valeurFinale: string | null
  commentaire: string | null
  revuPar: string | null
  revuLe: string | null
}

export interface CompteurTricobot { aValider: number; aide: number; autonome: number }

export const jj = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—')
export const messageErreur = (e: unknown) => {
  const b = (e as { body?: { message?: string } } | null)?.body
  return b?.message ?? (e instanceof Error ? e.message : 'Erreur')
}

export const CLE_COMPTEURS = ['tricobot-saisies', 'compteurs'] as const
export const cleSaisies = (idcommande: number) => ['tricobot-saisies', 'commande', idcommande] as const

export function useCompteursTricobot(enabled: boolean) {
  return useQuery<Record<number, CompteurTricobot>>({
    queryKey: CLE_COMPTEURS,
    queryFn: () => apiFetch('/tricobot/saisies/compteurs'),
    enabled,
    staleTime: 30_000,
  })
}

export const CLE_COMPTEURS_LOTS = ['tricobot-saisies', 'compteurs-lots'] as const

/** Per lot: what Tricobot waits for (Qualité › Suivi lots). */
export function useCompteursLotsTricobot(enabled: boolean) {
  return useQuery<Record<number, CompteurTricobot>>({
    queryKey: CLE_COMPTEURS_LOTS,
    queryFn: () => apiFetch('/tricobot/saisies/compteurs-lots'),
    enabled,
    staleTime: 30_000,
  })
}

export function useSaisiesLotTricobot(idsuivilot: number | null) {
  return useQuery<SaisieTricobot[]>({
    queryKey: ['tricobot-saisies', 'lot', idsuivilot ?? 0],
    queryFn: () => apiFetch(`/tricobot/saisies?lot=${idsuivilot}`),
    enabled: !!idsuivilot,
    staleTime: 0,
  })
}

// ── The dyer's measures (Contrôles) ──────────────────────

export interface MesuresSst { laize: number; poids: number; stabH: number | null; stabL: number | null; vrillage: number | null }

export function lireMesures(v: string | null): MesuresSst | null {
  if (!v) return null
  try { return JSON.parse(v) as MesuresSst } catch { return null }
}

export const CHAMPS_MESURES: Array<{ cle: keyof MesuresSst; libelle: string; unite: string }> = [
  { cle: 'laize', libelle: 'Laize', unite: 'cm' },
  { cle: 'poids', libelle: 'Poids', unite: 'g/m²' },
  { cle: 'stabH', libelle: 'Stab H', unite: '%' },
  { cle: 'stabL', libelle: 'Stab L', unite: '%' },
  { cle: 'vrillage', libelle: 'Vrillage', unite: '%' },
]

export function useSaisiesTricobot(idcommande: number | null) {
  return useQuery<SaisieTricobot[]>({
    queryKey: cleSaisies(idcommande ?? 0),
    queryFn: () => apiFetch(`/tricobot/saisies?commande=${idcommande}`),
    enabled: !!idcommande,
    staleTime: 0,
  })
}

/** The open points of an order: waiting for a person, or written alone. */
export const ouvertes = (xs: readonly SaisieTricobot[] | undefined) => (xs ?? []).filter((s) => s.statut === 'a_revoir' || s.statut === 'autonome')

/** True when Tricobot waits for a person on the order (red, doctrine §6). */
export const tricobotAttend = (c: CompteurTricobot | undefined) => !!c && c.aValider + c.aide > 0

/** On the order's card, left of its number: Tricobot in a round, ringed red
 *  when he waits for a person (his whole figure inside it — the needle he
 *  holds would stick out of a plain fit); small and plain when he wrote alone. */
export function TricobotAvatar({ c, className }: { c: CompteurTricobot | undefined; className?: string }) {
  if (!c) return null
  const aFaire = c.aValider + c.aide
  if (aFaire > 0) {
    // Neutral words: the same figure sits on a sst order (délais) and on a lot (contrôles).
    const titre = c.aide > 0 && c.aValider === 0
      ? 'Tricobot demande ton avis'
      : `Tricobot a saisi pour toi${aFaire > 1 ? ` (${aFaire} points)` : ''} : à valider`
    return (
      <span title={titre} className={cn('h-11 w-11 flex-shrink-0 flex items-center justify-center', className)}>
        {/* Tricobot alone, no round: the red card already says « act now ». */}
        <TricobotMascot className="h-11 w-11 drop-shadow" />
      </span>
    )
  }
  if (c.autonome > 0) {
    return (
      <span title="Saisi seul par Tricobot — rien à faire, corrigeable ici" className={cn('h-6 w-6 flex-shrink-0 flex items-center justify-center', className)}>
        <TricobotMascot className="h-6 w-6" />
      </span>
    )
  }
  return null
}

// ── The mail Tricobot read ───────────────────────────────

/** The question a reply answers: our « Point du JJ/MM », its §5 lines. */
export interface PointQuestion {
  jour: string
  envoyeLe: string | null
  envoyePar: string | null
  sujet: string
  titre: string
  lignes: Array<{ commande: string; idligne: number; article: string; commentaire: string }>
  /** §2 « Puis-je avoir vos contrôles… » and §5 « Pouvez-vous me confirmer les délais… ». */
  sections?: Record<'2' | '5', { titre: string; lignes: Array<{ commande: string; idligne: number; article: string; commentaire: string }> }>
}

export interface MailLu {
  id: string; de: string; sujet: string; date: string; texte: string; resume: string
  point: PointQuestion | null
  /** How the reply was read, per order of §5 (`nommee` null on runs before 2026-11-05). */
  delais: Array<{ commande: string; idligne: number; reponse: string; nommee: boolean | null }>
  competence?: string
  /** How §2 was read, per lot: was the lot's order line asked by the Point? */
  controles?: Array<{ lot: string; idsuivilot: number | null; idligne: number; texte: string; demande: boolean | null }>
}

export function useMailLu(runId: string | null) {
  return useQuery<MailLu>({
    queryKey: ['tricobot-saisies', 'mail', runId],
    queryFn: () => apiFetch(`/tricobot/saisies/mail/${runId}`),
    enabled: !!runId,
  })
}

export function MailTricobotDialog({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const q = useQuery<MailLu>({
    queryKey: ['tricobot-saisies', 'mail', runId],
    queryFn: () => apiFetch(`/tricobot/saisies/mail/${runId}`),
    enabled: !!runId,
  })
  return (
    <Dialog open={!!runId} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Mail className="h-5 w-5 text-accent" />Le mail lu par Tricobot</DialogTitle>
        </DialogHeader>
        <div className="mt-4 flex-1 min-h-0 overflow-y-auto space-y-3">
          {q.isLoading && <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>}
          {q.isError && <p className="text-sm text-destructive">{messageErreur(q.error)}</p>}
          {q.data && (
            <>
              <div className="rounded-lg border bg-zinc-100/80 p-3 text-xs space-y-0.5">
                <p><span className="text-muted-foreground">De :</span> {q.data.de}</p>
                <p><span className="text-muted-foreground">Objet :</span> <span className="font-medium">{q.data.sujet}</span></p>
                <p><span className="text-muted-foreground">Reçu le :</span> {new Date(q.data.date).toLocaleString('fr-FR')}</p>
              </div>
              <pre className="whitespace-pre-wrap font-sans text-sm rounded-lg border bg-white p-3">{q.data.texte || '(mail vide)'}</pre>
              <p className="text-xs text-muted-foreground flex items-center gap-1.5"><TricobotMascot className="h-4 w-4" />{q.data.resume}</p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Gestures ─────────────────────────────────────────────

export type Geste = {
  id: number
  action: 'valider' | 'corriger' | 'supprimer' | 'trancher' | 'omission'
  valeur?: string | null
  commentaire?: string
  /** trancher: « Tu as bien fait de me demander ? » (Discernement) and, on a « non », why. */
  justifie?: boolean
  pourquoiAvis?: string
}

export function useGeste(onChanged?: () => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (g: Geste) => apiFetch(`/tricobot/saisies/${g.id}/${g.action}`, {
      method: 'POST',
      body: JSON.stringify({ valeur: g.valeur, commentaire: g.commentaire ?? '', justifie: g.justifie, pourquoiAvis: g.pourquoiAvis ?? '' }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tricobot-saisies'] })
      // The red counter of Sous-traitants › Ennoblissement counts his waits too.
      qc.invalidateQueries({ queryKey: ['commandes-sst-urgency-counts'] })
      qc.invalidateQueries({ queryKey: ['commandes-sst'] })
      qc.invalidateQueries({ queryKey: ['suivi-lots'] })
      qc.invalidateQueries({ queryKey: ['suivi-lot'] })
      onChanged?.()
    },
  })
}

/** Asks for the new délai (Modifier, Saisir) and/or why (required unless `pourquoiFacultatif`). */
export function GesteDialog({ open, titre, avecDate, dateInitiale, mesuresInitiales, pourquoiFacultatif, libelle, isPending, error, onClose, onConfirm }: {
  open: boolean
  titre: string
  /** A value to give: a délai (default), or the dyer's measures when `mesuresInitiales` is set. */
  avecDate: boolean
  dateInitiale?: string | null
  mesuresInitiales?: MesuresSst | null
  pourquoiFacultatif?: boolean
  libelle: string
  isPending: boolean
  error: string | null
  onClose: () => void
  /** `valeur`: 'YYYY-MM-DD', or the measures as JSON; null when no value is asked. */
  onConfirm: (valeur: string | null, pourquoi: string) => void
}) {
  const [date, setDate] = useState('')
  const [mesures, setMesures] = useState<Record<string, string>>({})
  const [pourquoi, setPourquoi] = useState('')
  const avecMesures = avecDate && mesuresInitiales !== undefined
  useEffect(() => {
    if (!open) return
    setDate(dateInitiale ?? '')
    setMesures(Object.fromEntries(CHAMPS_MESURES.map((c) => [c.cle, mesuresInitiales?.[c.cle] == null ? '' : String(mesuresInitiales[c.cle])])))
    setPourquoi('')
  }, [open, dateInitiale, mesuresInitiales])
  const nombre = (v: string) => v.trim() !== '' && Number.isFinite(Number(v.replace(',', '.')))
  const mesuresOk = ['laize', 'poids', 'stabH', 'stabL'].every((k) => nombre(mesures[k] ?? '')) && ((mesures.vrillage ?? '') === '' || nombre(mesures.vrillage))
  const valeurOk = !avecDate || (avecMesures ? mesuresOk : /^\d{4}-\d{2}-\d{2}$/.test(date))
  const ok = valeurOk && (pourquoiFacultatif || !!pourquoi.trim())
  const valeur = () => {
    if (!avecDate) return null
    if (!avecMesures) return date
    const n = (v: string) => Number(v.replace(',', '.'))
    return JSON.stringify({ laize: n(mesures.laize), poids: n(mesures.poids), stabH: n(mesures.stabH), stabL: n(mesures.stabL), vrillage: (mesures.vrillage ?? '') === '' ? null : n(mesures.vrillage) })
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader><DialogTitle className="flex items-center gap-2"><TricobotMascot className="h-6 w-6" />{titre}</DialogTitle></DialogHeader>
        <div className="mt-4 space-y-3">
          {avecDate && !avecMesures && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Délai de la ligne</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
          )}
          {avecMesures && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {CHAMPS_MESURES.map((c) => (
                <div key={c.cle} className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{c.libelle} <span className="font-normal">({c.unite})</span></label>
                  <input
                    inputMode="decimal"
                    value={mesures[c.cle] ?? ''}
                    placeholder={c.cle === 'vrillage' ? 'non mesuré' : ''}
                    onChange={(e) => setMesures((m) => ({ ...m, [c.cle]: e.target.value }))}
                    className="w-full h-9 px-2 text-sm text-right tabular-nums rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              ))}
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{pourquoiFacultatif ? 'Une remarque pour Tricobot (facultatif)' : 'Pourquoi ? Tricobot s’en sert pour s’améliorer'}</label>
            <textarea rows={3} value={pourquoi} onChange={(e) => setPourquoi(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
          </div>
          {error && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button disabled={!ok || isPending} onClick={() => onConfirm(valeur(), pourquoi.trim())}>
            {isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}{libelle}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Mails read without writing anything ──────────────────

interface RienARevoir extends SaisieTricobot { mail: { sujet: string; de: string; date: string } | null }

/** Search-bar counter (§41): red, the mails Tricobot read without writing
 *  anything, to confirm (supervisé). Hidden at 0. */
export function MailsTricobotBouton() {
  const [open, setOpen] = useState(false)
  const q = useQuery<RienARevoir[]>({ queryKey: ['tricobot-saisies', 'mails'], queryFn: () => apiFetch('/tricobot/saisies/mails'), staleTime: 30_000 })
  const n = q.data?.length ?? 0
  const geste = useGeste()
  const [mailRun, setMailRun] = useState<string | null>(null)
  const [omis, setOmis] = useState<RienARevoir | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  if (n === 0) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Mails lus par Tricobot : rien saisi, ou rien su où écrire — à vérifier"
        className="h-7 pl-0.5 pr-1.5 inline-flex items-center gap-1 rounded-md text-xs font-semibold tabular-nums border bg-red-500/10 text-red-800 border-red-500/30 hover:bg-red-500/20 flex-shrink-0"
      >
        <TricobotMascot className="h-5 w-5" />{n}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl max-h-[90dvh] flex flex-col" onClose={() => setOpen(false)}>
          <DialogHeader><DialogTitle className="flex items-center gap-2"><TricobotMascot className="h-6 w-6" />Mails lus par Tricobot</DialogTitle></DialogHeader>
          <p className="mt-2 text-xs text-muted-foreground">Les réponses au Point où Tricobot n’a rien saisi : confirme qu’il n’y avait rien, ou dis-lui ce qu’il a raté. Et ce qu’il n’a pas su où écrire (un lot ou un Point introuvable) : à toi de voir.</p>
          <div className="mt-3 flex-1 min-h-0 overflow-y-auto space-y-2">
            {q.data!.map((s) => (
              <div key={s.id} className="rounded-lg border bg-card shadow-sm p-3">
                <p className="text-sm font-medium truncate">{s.mail?.sujet ?? 'Mail'}</p>
                <p className="text-[11px] text-muted-foreground truncate">{s.mail ? `${s.mail.de} · ${new Date(s.mail.date).toLocaleString('fr-FR')}` : ''}</p>
                <p className={cn('mt-1 text-xs', s.decision === 'aide' ? 'font-medium text-red-700' : 'text-muted-foreground')}>
                  {s.decision === 'aide' ? `Je ne sais pas où l’écrire : ${s.explication}` : s.explication}
                </p>
                {s.decision === 'aide' && s.citation && <p className="mt-0.5 text-xs italic text-muted-foreground">« {s.citation.replace(/\s+/g, ' ')} »</p>}
                <div className="mt-2 flex items-center gap-1.5">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setMailRun(s.runId)}><Mail className="h-3.5 w-3.5 mr-1" />Voir le mail</Button>
                  <span className="ml-auto" />
                  {s.decision === 'aide' ? (
                    <Button size="sm" className="h-7 px-2 text-xs" disabled={geste.isPending} title="Tu t’en occupes à la main (ou il n’y a rien à faire)" onClick={() => geste.mutate({ id: s.id, action: 'trancher', valeur: null, justifie: true })}><Check className="h-3.5 w-3.5 mr-1" />Je m’en occupe</Button>
                  ) : (
                    <>
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={geste.isPending} onClick={() => setOmis(s)}>Il y avait un délai</Button>
                      <Button size="sm" className="h-7 px-2 text-xs" disabled={geste.isPending} onClick={() => geste.mutate({ id: s.id, action: 'valider' })}><Check className="h-3.5 w-3.5 mr-1" />Rien à saisir</Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <GesteDialog
        open={!!omis}
        titre="Tricobot a raté un délai"
        avecDate={false}
        libelle="Envoyer à Tricobot"
        isPending={geste.isPending}
        error={erreur}
        onClose={() => { setOmis(null); setErreur(null) }}
        onConfirm={(_d, pourquoi) => omis && geste.mutate({ id: omis.id, action: 'omission', commentaire: pourquoi }, { onSuccess: () => setOmis(null), onError: (e) => setErreur(messageErreur(e)) })}
      />
      <MailTricobotDialog runId={mailRun} onClose={() => setMailRun(null)} />
    </>
  )
}
