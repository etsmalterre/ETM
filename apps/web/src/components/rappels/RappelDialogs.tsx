// Rappels: the dialogs (mps_designer §18.A).
//   RappelsDialog           the reminders of ONE object, and the form to put a new one (the « Rappel »
//                           button of a lot, a piece, an order)
//   RappelFaitDialog        « Fait »: closes a reminder, with an optional word on how it ended
//   RappelRepousserDialog   « Repousser »: a new date
// The last two are also opened from the reminder's card in the notification centre.

import { useEffect, useState } from 'react'
import { AlarmClock, AlarmClockPlus, CalendarClock, Check, CheckCheck, Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { messageErreur, useUser } from '@/contexts/UserContext'
import { usePermissions } from '@/contexts/PermissionsContext'
import { cn } from '@/lib/utils'
import { aujourdhuiIso, dateFr, useDestinataires, useGestesRappel, useRappelsObjet, type Rappel, type TypeObjet } from './rappels'

const champ = 'w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
const zoneTexte = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y'
const etiquette = 'text-xs font-medium text-muted-foreground'

// ── The reminders of one object ──────────────────────────

export function RappelsDialog({ open, onClose, type: typeObjet, id: idObjet, titre: titreObjet, lot }: {
  open: boolean
  onClose: () => void
  type: TypeObjet
  id: number
  /** How the object reads, under the title (« Lot MA109539 »). */
  titre?: string
  /** Opened from a piece of a lot: the person chooses what the reminder is about, the piece or its
   *  lot (an agreement with a client is usually about the lot, Vincent 2026-11-18). */
  lot?: { id: number; titre: string } | null
}) {
  const { user } = useUser()
  const { isEffectiveAdmin } = usePermissions()
  const [surLot, setSurLot] = useState(false)
  const cibleLot = !!lot && surLot
  const type: TypeObjet = cibleLot ? 'lot_fini' : typeObjet
  const id = cibleLot ? lot!.id : idObjet
  const titre = cibleLot ? lot!.titre : titreObjet
  const { data, isLoading } = useRappelsObjet(type, id, open)
  // Both counts, for the two choices: the reminders already on the piece, those already on its lot.
  const dePiece = useRappelsObjet(typeObjet, idObjet, open && !!lot)
  const deLot = useRappelsObjet('lot_fini', lot?.id, open && !!lot)
  const nbOuverts = (rs: Rappel[] | undefined) => (rs ?? []).filter((r) => r.fait_le === null).length
  const destinataires = useDestinataires(open)
  const { creer, supprimer } = useGestesRappel()

  const rappels = data?.rappels ?? []
  const ouverts = rappels.filter((r) => r.fait_le === null)
  const faits = rappels.filter((r) => r.fait_le !== null)

  const [formulaire, setFormulaire] = useState(false)
  const [echeance, setEcheance] = useState('')
  const [observation, setObservation] = useState('')
  const [pourId, setPourId] = useState(0)
  const [erreur, setErreur] = useState('')
  const [aFaire, setAFaire] = useState<Rappel | null>(null)
  const [aRepousser, setARepousser] = useState<Rappel | null>(null)
  const [aSupprimer, setASupprimer] = useState<Rappel | null>(null)

  // A fresh form each time the dialog opens; « pour » defaults to the person who puts the reminder.
  useEffect(() => {
    if (!open) return
    setFormulaire(false)
    setEcheance('')
    setObservation('')
    setPourId(0)
    setErreur('')
  }, [open, type, id])
  // Each opening starts on the object the person clicked.
  useEffect(() => { if (open) setSurLot(false) }, [open, typeObjet, idObjet])

  const moi = destinataires.data?.moi ?? user?.IDutilisateur ?? 0
  const pour = pourId || moi
  // Nothing on the object yet: the form is what the person came for.
  const formulaireOuvert = formulaire || (!isLoading && ouverts.length === 0)
  const pret = echeance !== '' && observation.trim() !== ''

  function ajouter() {
    setErreur('')
    creer.mutate(
      { objet_type: type, objet_id: id, echeance, observation: observation.trim(), ...(pour && pour !== moi ? { pour_id: pour } : {}) },
      {
        onSuccess: () => { setFormulaire(false); setEcheance(''); setObservation(''); setPourId(0) },
        onError: (e) => setErreur(messageErreur(e, 'Le rappel n’a pas pu être enregistré.')),
      },
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
        <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto" onClose={onClose}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlarmClock className="h-5 w-5 text-accent" />
              Rappels
            </DialogTitle>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            {lot && (
              // What the reminder is about (mps_designer §5 segmented filter): this piece, or its lot.
              <div className="flex gap-1 rounded-md bg-zinc-200/50 p-1">
                {([[false, titreObjet ?? 'Cette pièce', nbOuverts(dePiece.data?.rappels)], [true, lot.titre, nbOuverts(deLot.data?.rappels)]] as const).map(([cible, libelle, n]) => (
                  <button
                    key={String(cible)}
                    type="button"
                    onClick={() => setSurLot(cible)}
                    className={cn(
                      'flex-1 truncate rounded-md px-2 py-1 text-xs transition-colors',
                      surLot === cible ? 'bg-accent font-medium text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
                    )}
                  >
                    {libelle}{n > 0 ? ` (${n})` : ''}
                  </button>
                ))}
              </div>
            )}
            {titre && !lot && <p className="text-sm font-medium">{titre}</p>}
            <p className="text-xs text-muted-foreground">
              À sa date, un rappel arrive dans le centre de notifications de la personne choisie et y reste jusqu’à « Fait ».
              Tout le monde le voit ici en attendant.
            </p>

            {isLoading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-6 w-6 animate-spin text-accent" />
              </div>
            )}

            {ouverts.map((r) => (
              <div key={r.id} className="group rounded-lg border border-border/60 border-l-4 border-l-amber-400/60 bg-zinc-100/80 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      <CalendarClock className="h-3.5 w-3.5 flex-shrink-0 text-amber-600" />
                      {dateFr(r.echeance)}
                    </p>
                    <p className="mt-1 whitespace-pre-line text-sm">{r.observation}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Pour {r.pour || '?'} · posé par {r.par || '?'} le {dateFr(r.cree_le)}
                    </p>
                  </div>
                  {(r.par_id === user?.IDutilisateur || isEffectiveAdmin) && (
                    <Button
                      variant="ghost" size="icon" title="Supprimer ce rappel (posé par erreur)"
                      className="h-6 w-6 flex-shrink-0 text-destructive opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      onClick={() => setASupprimer(r)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setARepousser(r)}>
                    <CalendarClock className="mr-1.5 h-3.5 w-3.5" />Repousser
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setAFaire(r)}>
                    <CheckCheck className="mr-1.5 h-3.5 w-3.5" />Fait
                  </Button>
                </div>
              </div>
            ))}

            {faits.map((r) => (
              <div key={r.id} className="rounded-lg border border-border/60 border-l-4 border-l-border bg-zinc-100/80 p-3 opacity-80">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Check className="h-3.5 w-3.5 flex-shrink-0 text-success" />
                  Fait le {dateFr(r.fait_le)}{r.fait_par ? ` par ${r.fait_par}` : ''} · prévu le {dateFr(r.echeance)}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{r.observation}</p>
                {r.fait_comment && <p className="mt-1 text-xs italic text-muted-foreground">{r.fait_comment}</p>}
              </div>
            ))}

            {formulaireOuvert ? (
              <div className="space-y-3 rounded-lg border border-accent/25 bg-accent/[0.03] p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-accent">Nouveau rappel</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className={etiquette} htmlFor="rappel-echeance">Date du rappel</label>
                    <input
                      id="rappel-echeance" type="date" value={echeance} min={aujourdhuiIso()}
                      onChange={(e) => setEcheance(e.target.value)} className={champ}
                    />
                  </div>
                  <div className="space-y-1">
                    <span className={etiquette}>Pour</span>
                    <PopoverSelect
                      options={(destinataires.data?.destinataires ?? []).map((d) => ({ id: d.id, primary: d.id === moi ? `${d.nom} (moi)` : d.nom }))}
                      value={pour}
                      onChange={setPourId}
                      hideEmpty
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className={etiquette} htmlFor="rappel-observation">Observation : ce qu’il faudra faire ce jour-là</label>
                  <textarea
                    id="rappel-observation" rows={3} value={observation} maxLength={1000}
                    onChange={(e) => setObservation(e.target.value)} className={zoneTexte}
                  />
                </div>
                {erreur && <p className="text-sm text-destructive">{erreur}</p>}
                <div className="flex justify-end gap-2 pt-1">
                  {ouverts.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => { setFormulaire(false); setErreur('') }} disabled={creer.isPending}>
                      Annuler
                    </Button>
                  )}
                  <Button
                    size="sm" onClick={ajouter} disabled={!pret || creer.isPending}
                    title={pret ? undefined : 'La date et l’observation sont obligatoires'}
                  >
                    {creer.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <AlarmClockPlus className="mr-1.5 h-3.5 w-3.5" />}
                    Ajouter le rappel
                  </Button>
                </div>
              </div>
            ) : !isLoading && (
              <Button
                variant="ghost" size="sm" onClick={() => setFormulaire(true)}
                className="w-full border border-dashed border-border/60 text-muted-foreground hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />Ajouter un rappel
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <RappelFaitDialog rappel={aFaire} onClose={() => setAFaire(null)} />
      <RappelRepousserDialog rappel={aRepousser} onClose={() => setARepousser(null)} />
      <ConfirmDialog
        open={aSupprimer !== null}
        title="Supprimer le rappel"
        description={aSupprimer ? `Le rappel du ${dateFr(aSupprimer.echeance)} sera supprimé, comme s’il n’avait jamais été posé. S’il a été traité, utilisez plutôt « Fait ».` : undefined}
        isPending={supprimer.isPending}
        error={supprimer.isError ? messageErreur(supprimer.error, 'La suppression a échoué.') : null}
        onCancel={() => { supprimer.reset(); setASupprimer(null) }}
        onConfirm={() => { if (aSupprimer) supprimer.mutate(aSupprimer.id, { onSuccess: () => setASupprimer(null) }) }}
      />
    </>
  )
}

// ── « Fait » ─────────────────────────────────────────────

export function RappelFaitDialog({ rappel, onClose }: { rappel: Rappel | { id: number; titre: string; observation: string } | null; onClose: () => void }) {
  const { fait } = useGestesRappel()
  const [commentaire, setCommentaire] = useState('')
  const [erreur, setErreur] = useState('')

  function fermer() {
    setCommentaire('')
    setErreur('')
    onClose()
  }

  const titre = rappel ? ('objet_libelle' in rappel ? rappel.objet_libelle : rappel.titre) : ''

  return (
    <Dialog open={rappel !== null} onOpenChange={(v) => { if (!v) fermer() }}>
      <DialogContent className="max-w-md" onClose={fermer}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCheck className="h-5 w-5 text-accent" />
            Rappel fait
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-border/60 bg-zinc-100/80 p-3">
            <p className="text-sm font-medium">{titre}</p>
            <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{rappel?.observation}</p>
          </div>
          <div className="space-y-1">
            <label className={etiquette} htmlFor="rappel-fait-commentaire">Comment cela s’est terminé (facultatif)</label>
            <textarea
              id="rappel-fait-commentaire" rows={3} value={commentaire} maxLength={1000}
              onChange={(e) => setCommentaire(e.target.value)} className={zoneTexte}
            />
          </div>
          {erreur && <p className="text-sm text-destructive">{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={fermer} disabled={fait.isPending}>Annuler</Button>
          <Button
            disabled={fait.isPending}
            onClick={() => rappel && fait.mutate({ id: rappel.id, commentaire: commentaire.trim() }, {
              onSuccess: fermer,
              onError: (e) => setErreur(messageErreur(e, 'Le rappel n’a pas pu être clos.')),
            })}
          >
            {fait.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCheck className="mr-1.5 h-4 w-4" />}
            Fait
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── « Repousser » ────────────────────────────────────────

export function RappelRepousserDialog({ rappel, onClose }: { rappel: { id: number; echeance: string } | null; onClose: () => void }) {
  const { modifier } = useGestesRappel()
  const [echeance, setEcheance] = useState('')
  const [erreur, setErreur] = useState('')

  useEffect(() => {
    setEcheance('')
    setErreur('')
  }, [rappel?.id])

  const aujourdhui = aujourdhuiIso()
  // A new date, later than today: pushing a reminder to today leaves it where it is.
  const valide = echeance !== '' && echeance > aujourdhui

  return (
    <Dialog open={rappel !== null} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-accent" />
            Repousser le rappel
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">Prévu le {dateFr(rappel?.echeance)}. Il reviendra à la nouvelle date.</p>
          <div className="space-y-1">
            <label className={etiquette} htmlFor="rappel-nouvelle-date">Nouvelle date</label>
            <input
              id="rappel-nouvelle-date" type="date" value={echeance} min={aujourdhui}
              onChange={(e) => setEcheance(e.target.value)} className={cn(champ)}
            />
          </div>
          {erreur && <p className="text-sm text-destructive">{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={modifier.isPending}>Annuler</Button>
          <Button
            disabled={!valide || modifier.isPending}
            title={valide ? undefined : 'Choisissez une date après aujourd’hui'}
            onClick={() => rappel && modifier.mutate({ id: rappel.id, echeance }, {
              onSuccess: onClose,
              onError: (e) => setErreur(messageErreur(e, 'La date n’a pas pu être changée.')),
            })}
          >
            {modifier.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CalendarClock className="mr-1.5 h-4 w-4" />}
            Repousser
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
