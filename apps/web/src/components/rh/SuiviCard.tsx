// RH › Employés › Suivi — the dated, append-only record of what happened with
// an employee (meetings, announcements, warnings, letters). An entry is never
// edited or deleted — the database refuses it; a mistake is corrected by a
// « rectificatif » entry pointing at the original. Rules and hash chain:
// apps/api/src/lib/rh-suivi.ts.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  CalendarDays,
  FileDown,
  FilePen,
  GraduationCap,
  Info,
  Loader2,
  Lock,
  Mail,
  MessagesSquare,
  NotebookPen,
  Paperclip,
  Plus,
  Save,
  Stethoscope,
  StickyNote,
  Upload,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { apiFetch, API_URL } from '@/lib/api'
import { formatFileSize } from '@/lib/email'
import { cn } from '@/lib/utils'
import {
  TYPES_EVENEMENT,
  formatDateFr,
  libelleType,
  pieceUrl,
  todayIso,
  type Evenement,
  type TypeEvenement,
} from '@/lib/rh'

const inputClass = 'w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
const MAX_PIECE_BYTES = 15 * 1024 * 1024
const MAX_PIECES = 10

const ICONES: Record<string, LucideIcon> = {
  entretien: MessagesSquare,
  information: Info,
  avertissement: AlertTriangle,
  formation: GraduationCap,
  medical: Stethoscope,
  courrier: Mail,
  note: StickyNote,
  rectificatif: FilePen,
}

/** §7 card colours: a warning is the only red, a rectificatif is muted. */
function tonDe(type: string): { bord: string; fond: string; icone: string } {
  if (type === 'avertissement') return { bord: 'border-l-destructive/60', fond: 'bg-destructive/10', icone: 'text-destructive/70' }
  if (type === 'rectificatif') return { bord: 'border-l-border', fond: 'bg-muted', icone: 'text-muted-foreground' }
  return { bord: 'border-l-amber-400/60', fond: 'bg-amber-400/10', icone: 'text-amber-600' }
}

const frDateHeure = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })

export function SuiviCard({ employeId }: { employeId: number }) {
  const [creation, setCreation] = useState<{ rectifie: Evenement | null } | null>(null)

  const { data: evenements, isLoading, isError } = useQuery<Evenement[]>({
    queryKey: ['rh', 'evenements', employeId],
    queryFn: () => apiFetch(`/rh/employes/${employeId}/evenements`),
    retry: false,
  })

  const parId = useMemo(() => new Map((evenements ?? []).map((e) => [e.id, e])), [evenements])

  return (
    <>
      <Card className="card-premium">
        <CardHeader className="flex flex-row items-center gap-2 pb-2 space-y-0">
          <NotebookPen className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Suivi</CardTitle>
          {!!evenements?.length && <Badge variant="secondary" className="text-xs">{evenements.length}</Badge>}
          <div className="ml-auto flex items-center gap-1">
            {!!evenements?.length && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                title="Exporter le dossier de suivi en PDF (avec vérification d’intégrité)"
                onClick={() => window.open(`${API_URL}/rh/employes/${employeId}/evenements/export.pdf`, '_blank')}
              >
                <FileDown className="h-3.5 w-3.5 sm:mr-1.5" />
                <span className="hidden sm:inline">Exporter</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-accent hover:text-accent hover:bg-accent/10"
              title="Nouvel événement"
              onClick={() => setCreation({ rectifie: null })}
            >
              <Plus className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">Nouvel événement</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <div className="h-16 bg-muted animate-pulse rounded" />
          ) : isError ? (
            <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />Le suivi n’a pas pu être chargé.</p>
          ) : !evenements?.length ? (
            <p className="text-sm text-muted-foreground italic">
              Aucun événement. Entretiens, annonces, avertissements, courriers : chaque événement est daté et ne peut plus être modifié une fois enregistré.
            </p>
          ) : (
            evenements.map((e) => (
              <EvenementCard
                key={e.id}
                employeId={employeId}
                evenement={e}
                rectifie={e.rectifie !== null ? parId.get(e.rectifie) ?? null : null}
                onRectifier={() => setCreation({ rectifie: e })}
              />
            ))
          )}
        </CardContent>
      </Card>

      <EvenementDialog
        open={creation !== null}
        employeId={employeId}
        rectifie={creation?.rectifie ?? null}
        onClose={() => setCreation(null)}
      />
    </>
  )
}

function EvenementCard({ employeId, evenement: e, rectifie, onRectifier }: {
  employeId: number
  evenement: Evenement
  rectifie: Evenement | null
  onRectifier: () => void
}) {
  const Icone = ICONES[e.type] ?? StickyNote
  const ton = tonDe(e.type)
  return (
    <div className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', ton.bord)}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <div className={cn('h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0', ton.fond)}>
            <Icone className={cn('h-3.5 w-3.5', ton.icone)} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">{e.titre}</p>
            <p className="text-[11px] text-muted-foreground">
              {formatDateFr(e.dateEvenement)} · {libelleType(e.type)} · N° {e.id}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {e.rectifiePar.length > 0 && (
            <Badge variant="outline" className="text-[10px] py-0 bg-amber-50 text-amber-800 border-amber-300">
              Rectifié par N° {e.rectifiePar.join(', ')}
            </Badge>
          )}
          {e.type !== 'rectificatif' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
              title="Corriger cet événement par un rectificatif (l’original reste inchangé)"
              onClick={onRectifier}
            >
              <FilePen className="h-3 w-3 mr-1" />Rectifier
            </Button>
          )}
        </div>
      </div>

      <div className="ml-9 mt-2 space-y-1.5">
        {rectifie && (
          <p className="text-[11px] text-muted-foreground">
            Rectifie l’événement N° {rectifie.id} du {formatDateFr(rectifie.dateEvenement)} — « {rectifie.titre} »
          </p>
        )}
        {e.presents.trim() && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <Users className="h-3 w-3 flex-shrink-0" />{e.presents}
          </p>
        )}
        <p className="text-sm whitespace-pre-line">{e.contenu}</p>
        {e.pieces.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {e.pieces.map((p) => (
              <a
                key={p.id}
                href={pieceUrl(employeId, e, p)}
                target="_blank"
                rel="noreferrer"
                title={`SHA-256 ${p.sha256}`}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-white px-2 py-0.5 text-[11px] hover:border-accent/50 hover:text-accent transition-colors max-w-full"
              >
                <Paperclip className="h-3 w-3 flex-shrink-0" />
                <span className="truncate">{p.nom}</span>
                <span className="text-muted-foreground flex-shrink-0">{formatFileSize(p.taille)}</span>
              </a>
            ))}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground/80 flex items-center gap-1" title={`Empreinte ${e.hash}`}>
          <Lock className="h-2.5 w-2.5" />Enregistré le {frDateHeure(e.creeLe)} par {e.creePar}
        </p>
      </div>
    </div>
  )
}

interface Draft {
  dateEvenement: string
  type: TypeEvenement
  titre: string
  presents: string
  contenu: string
}

const TYPE_OPTIONS = TYPES_EVENEMENT.map((t, i) => ({ id: i + 1, primary: t.label }))

function draftVide(rectifie: Evenement | null): Draft {
  return {
    dateEvenement: todayIso(),
    type: rectifie ? 'rectificatif' : 'entretien',
    titre: rectifie ? `Rectificatif — ${rectifie.titre}` : '',
    presents: '',
    contenu: '',
  }
}

function EvenementDialog({ open, employeId, rectifie, onClose }: {
  open: boolean
  employeId: number
  rectifie: Evenement | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft>(() => draftVide(rectifie))
  const [pieces, setPieces] = useState<File[]>([])
  const [erreur, setErreur] = useState<string | null>(null)
  const [confirmAbandon, setConfirmAbandon] = useState(false)
  const initialRef = useRef<Draft>(draft)

  // Fresh form on every open.
  useEffect(() => {
    if (!open) return
    const d = draftVide(rectifie)
    initialRef.current = d
    setDraft(d)
    setPieces([])
    setErreur(null)
  }, [open, rectifie])

  const dirty = pieces.length > 0 || JSON.stringify(draft) !== JSON.stringify(initialRef.current)
  const estRectificatif = rectifie !== null

  const save = useMutation({
    mutationFn: async () => {
      const fd = new FormData()
      fd.append('donnees', JSON.stringify({
        ...draft,
        titre: draft.titre.trim(),
        presents: draft.presents.trim(),
        contenu: draft.contenu.trim(),
        rectifie: rectifie?.id ?? null,
      }))
      for (const f of pieces) fd.append('pieces', f)
      const res = await fetch(`${API_URL}/rh/employes/${employeId}/evenements`, { method: 'POST', body: fd, credentials: 'include' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.message ?? `Erreur HTTP ${res.status}`)
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rh', 'evenements', employeId] })
      onClose()
    },
    onError: (err) => setErreur(err instanceof Error ? err.message : 'L’enregistrement a échoué.'),
  })

  const fermer = () => {
    if (save.isPending) return
    if (dirty) setConfirmAbandon(true)
    else onClose()
  }

  const ajouterPieces = (files: FileList | null) => {
    if (!files) return
    setErreur(null)
    const next = [...pieces]
    for (const f of Array.from(files)) {
      if (f.size > MAX_PIECE_BYTES) { setErreur(`« ${f.name} » dépasse 15 Mo.`); continue }
      if (next.length >= MAX_PIECES) { setErreur(`${MAX_PIECES} pièces jointes au maximum.`); break }
      next.push(f)
    }
    setPieces(next)
  }

  const valide = draft.titre.trim() !== '' && draft.contenu.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(draft.dateEvenement)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const typeId = TYPES_EVENEMENT.findIndex((t) => t.cle === draft.type) + 1

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) fermer() }}>
        <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" onClose={fermer}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {estRectificatif ? <FilePen className="h-5 w-5 text-accent" /> : <NotebookPen className="h-5 w-5 text-accent" />}
              {estRectificatif ? 'Rectificatif' : 'Nouvel événement'}
            </DialogTitle>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            {rectifie && (
              <div className="rounded-md border border-border/60 bg-zinc-100/80 px-3 py-2 text-xs text-muted-foreground">
                Corrige l’événement N° {rectifie.id} du {formatDateFr(rectifie.dateEvenement)} — « {rectifie.titre} ». L’original reste tel quel ; les deux seront liés.
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Date de l’événement" icon={CalendarDays}>
                <input
                  type="date"
                  className={inputClass}
                  value={draft.dateEvenement}
                  max={todayIso()}
                  onChange={(e) => set('dateEvenement', e.target.value)}
                />
              </Field>
              <Field label="Type" icon={BookOpen}>
                {estRectificatif ? (
                  <div className={cn(inputClass, 'flex items-center text-muted-foreground')}>Rectificatif</div>
                ) : (
                  <PopoverSelect
                    hideEmpty
                    value={typeId}
                    onChange={(id) => set('type', TYPES_EVENEMENT[id - 1].cle)}
                    options={TYPE_OPTIONS.filter((o) => o.primary !== 'Rectificatif')}
                  />
                )}
              </Field>
              <div className="col-span-full">
                <Field label="Titre">
                  <input className={inputClass} value={draft.titre} maxLength={200} onChange={(e) => set('titre', e.target.value)} placeholder="Ex. Entretien — évolution du poste" />
                </Field>
              </div>
              <div className="col-span-full">
                <Field label="Personnes présentes" icon={Users}>
                  <input className={inputClass} value={draft.presents} maxLength={500} onChange={(e) => set('presents', e.target.value)} placeholder="Ex. Vincent Malterre, le salarié" />
                </Field>
              </div>
              <div className="col-span-full">
                <Field label="Compte rendu">
                  <textarea
                    rows={9}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                    value={draft.contenu}
                    maxLength={20000}
                    onChange={(e) => set('contenu', e.target.value)}
                    placeholder="Les faits : ce qui a été dit, par qui, ce qui a été proposé, les réactions. Pas d’opinion."
                  />
                </Field>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Paperclip className="h-3 w-3" />Pièces jointes <span className="font-normal">(compte rendu signé, email envoyé, courrier…)</span>
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                {pieces.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-zinc-100/80 px-2 py-0.5 text-xs max-w-full">
                    <span className="truncate">{f.name}</span>
                    <span className="text-muted-foreground flex-shrink-0">{formatFileSize(f.size)}</span>
                    <button type="button" className="rounded hover:bg-destructive/15 hover:text-destructive p-0.5" title="Retirer" onClick={() => setPieces((ps) => ps.filter((_, j) => j !== i))}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <label className="cursor-pointer">
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onClick={(e) => { (e.target as HTMLInputElement).value = '' }}
                    onChange={(e) => ajouterPieces(e.target.files)}
                  />
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-accent/50 hover:text-accent transition-colors">
                    <Upload className="h-3.5 w-3.5" />Ajouter un fichier
                  </span>
                </label>
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <Lock className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>
                Une fois enregistré, cet événement ne pourra plus être modifié ni supprimé, pièces jointes comprises. Une erreur se corrige par un rectificatif.
              </span>
            </div>

            {erreur && (
              <p className="flex items-center gap-1.5 text-sm text-destructive"><AlertCircle className="h-4 w-4 flex-shrink-0" />{erreur}</p>
            )}
          </div>

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={fermer} disabled={save.isPending}>Annuler</Button>
            <Button onClick={() => { setErreur(null); save.mutate() }} disabled={!valide || save.isPending}>
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
              Enregistrer définitivement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmAbandon}
        title="Abandonner la saisie"
        description="Le texte et les pièces jointes saisis seront perdus."
        confirmLabel="Abandonner"
        onCancel={() => setConfirmAbandon(false)}
        onConfirm={() => { setConfirmAbandon(false); onClose() }}
      />
    </>
  )
}

function Field({ label, icon: Icon, children }: { label: string; icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        {Icon && <Icon className="h-3 w-3" />}{label}
      </label>
      {children}
    </div>
  )
}
