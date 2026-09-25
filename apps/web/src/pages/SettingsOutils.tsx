// Paramètres › Outils — for now one tool: the weekly import of the Sage
// balance (legacy WinDev `FEN_upload_compta`), which feeds Rapports › Finance
// and the finance widgets. Rules and legacy recovery: apps/api/src/lib/import-sage.ts.
//
// Shared with TRM: TRM imports THIS file through its `@etm` alias and passes
// `basePath="/outils-trm/import-sage"` + its own company name — the API is one
// router factory mounted twice (routes/import-sage.ts), same shape as
// Rapports › Finance.
//
// Layout: Tableau (§27) for the history, and the preview is a banded « bilan »
// dialog (§18.D): the user READS what the file contains, then confirms.

import { useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Download,
  FilePlus2,
  FileSpreadsheet,
  FileUp,
  Info,
  Loader2,
  Lock,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { usePermissions } from '@/contexts/PermissionsContext'
import { useScreenAccess } from '@/hooks/useSubmenuFilter'
import { apiFetch, API_URL } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

// ── API shapes (routes/import-sage.ts) ──────────────────────────────────

interface ImportHistorique {
  IDupload_compta: number
  date: string
  charges: number
  produits: number
  frais_fixe: number
  frais_variable: number
}

interface ImportAnalyse {
  date: string
  nbLignesFichier: number
  nbComptes: number
  totaux: { charges: number; produits: number; frais_fixe: number; frais_variable: number; provisions: number }
  nouveauxComptes: Array<{ numero: number; libelle: string }>
  ignorees: Array<{ ligne: number; texte: string; raison: string }>
  societe: { ressemblanceCible: number; ressemblanceAutre: number; ok: boolean; nom: string; nomAutre: string }
  blocages: Array<{ code: string; message: string }>
}

interface FichierChoisi {
  nom: string
  contenu_base64: string
}

/** Binary-safe base64 of a picked file (chunked: `btoa` on one huge string
 *  overflows the call stack). */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

function serverMessage(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string } })?.body
  return body?.message ?? fallback
}

const eur = (v: number) => `${fmtNum(v, 2)} €`
const pct = (v: number) => `${Math.round(v * 100)} %`

// ── Screen ──────────────────────────────────────────────────────────────

interface SettingsOutilsProps {
  /** API mount of the import — ETM `/outils/import-sage`, TRM `/outils-trm/import-sage`. */
  basePath?: string
  /** The company whose books the screen feeds, as shown to the user. */
  societeNom?: string
}

export function SettingsOutils({
  basePath = '/outils/import-sage',
  societeNom = 'ETS Malterre',
}: SettingsOutilsProps = {}) {
  // Every hook before the permission early-returns (§28.6).
  const { isLoading: permsLoading } = usePermissions()
  // Seeing the screen is the right (Écrans › Paramètres › Outils) — the API
  // checks the same grant. No action key.
  const canImport = useScreenAccess().canOpen('/settings/outils')
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [fichier, setFichier] = useState<FichierChoisi | null>(null)
  const [analyse, setAnalyse] = useState<ImportAnalyse | null>(null)
  const [analyseError, setAnalyseError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ImportHistorique | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const historiqueKey = ['import-sage', basePath] as const
  const { data: historique, isLoading, isError } = useQuery<ImportHistorique[]>({
    queryKey: historiqueKey,
    queryFn: () => apiFetch<ImportHistorique[]>(basePath),
    enabled: canImport,
  })

  const analyseMut = useMutation({
    mutationFn: (f: FichierChoisi) =>
      apiFetch<ImportAnalyse>(`${basePath}/analyse`, { method: 'POST', body: JSON.stringify(f) }),
    onSuccess: (data) => setAnalyse(data),
    onError: (err) => setAnalyseError(serverMessage(err, 'Le fichier n’a pas pu être analysé.')),
  })

  const importMut = useMutation({
    mutationFn: (f: FichierChoisi) =>
      apiFetch<{ IDupload_compta: number }>(basePath, { method: 'POST', body: JSON.stringify(f) }),
    onSuccess: () => {
      setDialogOpen(false)
      // The import moves every finance figure of the société (Rapports ›
      // Finance, Charges / Analyse financière / CA widgets): refresh them all.
      queryClient.invalidateQueries()
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`${basePath}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteTarget(null)
      queryClient.invalidateQueries()
    },
    onError: (err) => setDeleteError(serverMessage(err, 'La suppression a échoué.')),
  })

  async function onFilePicked(file: File) {
    setAnalyse(null)
    setAnalyseError(null)
    importMut.reset()
    setDialogOpen(true)
    try {
      const f = { nom: file.name, contenu_base64: await fileToBase64(file) }
      setFichier(f)
      analyseMut.mutate(f)
    } catch {
      setAnalyseError('Le fichier n’a pas pu être lu.')
    }
  }

  if (permsLoading) return null
  if (!canImport) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <Lock className="h-12 w-12 opacity-30" />
        <p className="text-sm font-medium">Accès restreint</p>
        <p className="text-xs max-w-sm text-center">
          L’import de la balance Sage donne accès à la balance comptable complète. Demandez l’écran
          « Paramètres › Outils » à un administrateur.
        </p>
      </div>
    )
  }

  const dernier = historique?.[0]

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center gap-3">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="h-9 w-9 flex-shrink-0 rounded-lg icon-box-gold flex items-center justify-center">
            <FileSpreadsheet className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">Import de la balance Sage — {societeNom}</p>
            <p className="text-xs text-muted-foreground truncate">
              {dernier
                ? `Dernier import le ${formatHfsqlDate(dernier.date)}. Alimente Rapports › Finance et les widgets financiers.`
                : 'Alimente Rapports › Finance et les widgets financiers.'}
            </p>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.csv,.tsv,text/plain"
          className="hidden"
          onClick={(e) => { (e.target as HTMLInputElement).value = '' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onFilePicked(f)
          }}
        />
        <Button size="sm" className="flex-shrink-0" title="Importer une balance" onClick={() => fileInputRef.current?.click()}>
          <FileUp className="h-3.5 w-3.5 sm:mr-1.5" />
          <span className="hidden sm:inline">Importer une balance</span>
        </Button>
      </div>

      {/* History */}
      <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/60 bg-white shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        ) : isError ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-destructive">
            <AlertCircle className="h-6 w-6" />
            <p className="text-sm">Impossible de charger l’historique des imports.</p>
          </div>
        ) : !historique || historique.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <FileSpreadsheet className="h-12 w-12 mb-3 opacity-40" />
            <p className="text-sm">Aucune balance importée</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-zinc-200 border-b border-border/60">
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2.5 text-left font-semibold">Date</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Charges</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Produits</th>
                  <th className="hidden md:table-cell px-3 py-2.5 text-right font-semibold">Charges fixes</th>
                  <th className="hidden md:table-cell px-3 py-2.5 text-right font-semibold">Charges variables</th>
                  <th className="px-3 py-2.5 w-20" />
                </tr>
              </thead>
              <tbody>
                {historique.map((h, i) => (
                  <tr key={h.IDupload_compta} className="border-b border-border/40 hover:bg-accent/5">
                    <td className="px-3 py-2 whitespace-nowrap">{formatHfsqlDate(h.date)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{eur(h.charges)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{eur(h.produits)}</td>
                    <td className="hidden md:table-cell px-3 py-2 text-right tabular-nums text-muted-foreground">{eur(h.frais_fixe)}</td>
                    <td className="hidden md:table-cell px-3 py-2 text-right tabular-nums text-muted-foreground">{eur(h.frais_variable)}</td>
                    <td className="px-2 py-1">
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Télécharger le fichier importé"
                          onClick={() => window.open(`${API_URL}${basePath}/${h.IDupload_compta}/fichier`, '_blank')}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                        {i === 0 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            title="Supprimer cet import"
                            onClick={() => { setDeleteError(null); setDeleteTarget(h) }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {historique && historique.length > 0 && (
          <div className="flex-shrink-0 px-3 py-2 border-t text-xs text-muted-foreground bg-zinc-200/50">
            {historique.length} import{historique.length > 1 ? 's' : ''}
          </div>
        )}
      </div>

      <ImportDialog
        open={dialogOpen}
        onOpenChange={(o) => { if (!importMut.isPending) setDialogOpen(o) }}
        fichierNom={fichier?.nom ?? ''}
        societeNom={societeNom}
        analyse={analyse}
        analysing={analyseMut.isPending}
        analyseError={analyseError}
        importing={importMut.isPending}
        importError={importMut.isError ? serverMessage(importMut.error, 'L’import a échoué.') : null}
        onConfirm={() => { if (fichier) importMut.mutate(fichier) }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer l’import"
        // The server's refusal replaces the description rather than going
        // through `error`: TRM renders this screen with its own ConfirmDialog,
        // which has no such prop.
        description={
          deleteError ??
          (deleteTarget
            ? `La balance importée le ${formatHfsqlDate(deleteTarget.date)} sera retirée : Rapports › Finance et les widgets financiers reviendront à l’import précédent. Le fichier pourra être importé à nouveau.`
            : undefined)
        }
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) deleteMut.mutate(deleteTarget.IDupload_compta) }}
      />
    </div>
  )
}

// ── Preview dialog — §18.D banded « bilan » ─────────────────────────────

function ImportDialog({
  open,
  onOpenChange,
  fichierNom,
  societeNom,
  analyse,
  analysing,
  analyseError,
  importing,
  importError,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fichierNom: string
  societeNom: string
  analyse: ImportAnalyse | null
  analysing: boolean
  analyseError: string | null
  importing: boolean
  importError: string | null
  onConfirm: () => void
}) {
  const bloque = !analyse || analyse.blocages.length > 0
  const error = analyseError ?? importError

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 border-0 bg-primary overflow-hidden max-h-[90dvh] flex flex-col">
        {/* Band — §43 */}
        <div className="flex-shrink-0 flex items-center gap-2.5 rounded-t-lg border-b-2 border-gold bg-primary px-4 py-2.5">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <FileUp className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
              Import de la balance Sage
            </h2>
            <p className="text-xs text-white/70 truncate">{fichierNom} • {societeNom}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 flex-shrink-0 text-white/80 hover:bg-white/15 hover:text-white"
            title="Fermer"
            disabled={importing}
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-100 p-4 space-y-3 scrollbar-transparent">
          {analysing || (!analyse && !analyseError) ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
              <p className="text-sm">Analyse du fichier…</p>
            </div>
          ) : analyse ? (
            <>
              {analyse.blocages.map((b) => (
                <StatusCard key={b.code} tone="danger" icon={<AlertTriangle className="h-4 w-4" />} title="Import impossible">
                  {b.message}
                </StatusCard>
              ))}

              {analyse.nbComptes > 0 && (
                <SocieteVerdict societe={analyse.societe} />
              )}

              {analyse.nbComptes > 0 && (
                <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm">
                  <div className="flex items-center gap-2 mb-2">
                    <FileSpreadsheet className="h-4 w-4 text-accent" />
                    <h3 className="text-sm font-semibold">Ce que le fichier contient</h3>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                    <KV label="Charges (classe 6)" value={eur(analyse.totaux.charges)} strong />
                    <KV label="Produits (classe 7)" value={eur(analyse.totaux.produits)} strong />
                    <KV label="dont charges fixes" value={eur(analyse.totaux.frais_fixe)} />
                    <KV label="dont charges variables" value={eur(analyse.totaux.frais_variable)} />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-2">
                    {analyse.nbComptes} comptes de charges et de produits retenus sur {analyse.nbLignesFichier} lignes.
                    Enregistrée à la date du {formatHfsqlDate(analyse.date)}.
                  </p>
                </div>
              )}

              {analyse.nouveauxComptes.length > 0 && analyse.blocages.length === 0 && (
                <StatusCard
                  tone="warning"
                  icon={<FilePlus2 className="h-4 w-4" />}
                  title={`${analyse.nouveauxComptes.length} nouveau${analyse.nouveauxComptes.length > 1 ? 'x' : ''} compte${analyse.nouveauxComptes.length > 1 ? 's' : ''}`}
                >
                  <p>
                    Ils seront créés comme <strong>charges fixes</strong>. Pour classer une charge en variable :
                    Rapports › Finance, tiroir du compte.
                  </p>
                  <ul className="mt-2 space-y-0.5 max-h-40 overflow-y-auto scrollbar-transparent">
                    {analyse.nouveauxComptes.map((c) => (
                      <li key={c.numero} className="flex gap-2 text-xs">
                        <span className="tabular-nums font-medium">{c.numero}</span>
                        <span className="truncate">{c.libelle}</span>
                      </li>
                    ))}
                  </ul>
                </StatusCard>
              )}

              {analyse.ignorees.length > 0 && (
                <StatusCard tone="neutral" icon={<Info className="h-4 w-4" />} title={`${analyse.ignorees.length} ligne${analyse.ignorees.length > 1 ? 's' : ''} ignorée${analyse.ignorees.length > 1 ? 's' : ''}`}>
                  <ul className="space-y-1">
                    {analyse.ignorees.map((l) => (
                      <li key={l.ligne} className="text-xs">
                        <span className="font-mono">{l.texte.replace(/\t/g, '  ')}</span>
                        <span className="text-muted-foreground"> — ligne {l.ligne}, {l.raison}</span>
                      </li>
                    ))}
                  </ul>
                </StatusCard>
              )}
            </>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 flex items-center gap-3 rounded-b-lg border-t border-border/60 bg-zinc-200 px-4 py-3">
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive min-w-0">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span className="truncate" title={error}>{error}</span>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" disabled={importing} onClick={() => onOpenChange(false)}>Annuler</Button>
            <Button disabled={bloque || analysing || importing} onClick={onConfirm}>
              {importing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5 mr-1.5" />}
              Importer
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SocieteVerdict({ societe }: { societe: ImportAnalyse['societe'] }) {
  const comparable = societe.ressemblanceCible > 0 || societe.ressemblanceAutre > 0
  if (!comparable) {
    return (
      <StatusCard tone="neutral" icon={<Building2 className="h-4 w-4" />} title={societe.nom}>
        Aucun import précédent à comparer : la société du fichier n’a pas pu être vérifiée.
      </StatusCard>
    )
  }
  return (
    <StatusCard
      tone={societe.ok ? 'success' : 'danger'}
      icon={societe.ok ? <CheckCircle2 className="h-4 w-4" /> : <Building2 className="h-4 w-4" />}
      title={societe.ok ? `Balance de ${societe.nom}` : `Balance de ${societe.nomAutre} ?`}
    >
      Comptes et libellés en commun avec les dernières balances : {pct(societe.ressemblanceCible)} pour {societe.nom},{' '}
      {pct(societe.ressemblanceAutre)} pour {societe.nomAutre}.
    </StatusCard>
  )
}

const TONES = {
  success: { edge: 'border-l-green-500/60', box: 'bg-green-500/10 text-green-600', title: 'text-green-700' },
  warning: { edge: 'border-l-amber-400/60', box: 'bg-amber-400/10 text-amber-600', title: 'text-amber-700' },
  danger: { edge: 'border-l-destructive/60', box: 'bg-destructive/10 text-destructive', title: 'text-destructive' },
  neutral: { edge: 'border-l-border', box: 'bg-muted text-muted-foreground', title: 'text-foreground' },
} as const

/** §7 status card on a white surface, as §18.D asks for verdicts. */
function StatusCard({
  tone,
  icon,
  title,
  children,
}: {
  tone: keyof typeof TONES
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  const t = TONES[tone]
  return (
    <div className={cn('rounded-lg border-l-4 border border-border/60 bg-card p-3 shadow-sm', t.edge)}>
      <div className="flex items-start gap-2.5">
        <div className={cn('h-8 w-8 flex-shrink-0 rounded-md flex items-center justify-center', t.box)}>{icon}</div>
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm font-semibold', t.title)}>{title}</p>
          <div className="text-sm text-muted-foreground mt-0.5">{children}</div>
        </div>
      </div>
    </div>
  )
}

function KV({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm text-right tabular-nums', strong && 'font-semibold')}>{value}</span>
    </div>
  )
}
