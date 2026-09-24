// Clients › Gestion — « Étiquettes » master tab (LIVA #1200): the Simone
// Pérèle coloris codes (`code_sp`, shared live with WinDev) that feed the
// roll labels, plus the switch that turns the labels on for a client.
//
// `code_sp` has no client column — it is Simone Pérèle's list by
// construction (the legacy window was « Codes SP »). The tab only shows on
// clients whose labels are switched on.

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Barcode, Loader2, Pencil, Plus, Trash2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

export interface CodeSp {
  IDcode_sp: number
  coloris: string
  code_ean_13: string
  article_client: string
  article_fournisseur: string
  libelle_article: string
  num_bain: string
  ean13: string | null
}

type CodeForm = Omit<CodeSp, 'IDcode_sp' | 'ean13'>
const EMPTY: CodeForm = {
  coloris: '', code_ean_13: '', article_client: 'LF 043 - ',
  article_fournisseur: '191 COTON / POLY. EDF 85/55 MALTERRE', libelle_article: 'EDF 85/55 PES/COT/COTON', num_bain: '',
}

/** 26 of the 54 codes (2026-09-24) lost the second 0 of « 3700442210… »
 *  when typed. A guess to verify with Simone Pérèle, never applied silently —
 *  and withheld when it would duplicate another coloris' code (810 GRIS
 *  GRAPHITE would land on 435 ROUGE TANGO's). */
export function suggestedEan(stored: string, taken: Set<string> = new Set()): string | null {
  const d = stored.replace(/\D/g, '')
  const guess = d.length === 11 && d.startsWith('370') ? `3700${d.slice(3)}` : null
  return guess && !taken.has(guess) ? guess : null
}

/** The 12 data digits of a stored code, to spot duplicates. */
function eanKey(stored: string): string {
  return stored.replace(/\D/g, '').slice(0, 12)
}

export function useEtiquetteClients() {
  return useQuery<{ clients: number[] }>({
    queryKey: ['etiquettes-sp-clients'],
    queryFn: () => apiFetch('/etiquettes-sp/clients'),
    staleTime: 5 * 60_000,
  })
}

/** The on/off switch, in the Info tab's « Général » card. Applied at once
 *  (it lives outside the client row, so it is not part of Enregistrer). */
export function EtiquettesSwitch({ clientId, editable }: { clientId: number; editable: boolean }) {
  const queryClient = useQueryClient()
  const { data } = useEtiquetteClients()
  const enabled = data?.clients.includes(clientId) ?? false
  const mut = useMutation({
    mutationFn: (v: boolean) => apiFetch(`/etiquettes-sp/clients/${clientId}`, { method: 'PUT', body: JSON.stringify({ enabled: v }) }),
    onSuccess: (payload: { clients: number[] }) => queryClient.setQueryData(['etiquettes-sp-clients'], payload),
  })
  const disabled = !editable || mut.isPending
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border/60 bg-white shadow-sm">
      <span className={cn('text-xs font-medium', !editable && 'text-muted-foreground')}>Étiquettes code-barres par rouleau</span>
      {mut.isPending && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
      <button type="button" role="switch" aria-checked={enabled} disabled={disabled} onClick={() => mut.mutate(!enabled)}
        className={cn('relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          enabled ? 'bg-accent shadow-inner' : 'bg-zinc-300',
          !disabled && !enabled && 'hover:bg-zinc-400/80')}>
        <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
          enabled ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
    </div>
  )
}

export function CodesSpTab({ editable }: { editable: boolean }) {
  const queryClient = useQueryClient()
  const { data: codes, isLoading, isError } = useQuery<CodeSp[]>({
    queryKey: ['etiquettes-sp-codes'],
    queryFn: () => apiFetch('/etiquettes-sp/codes'),
  })
  const [editing, setEditing] = useState<CodeSp | 'new' | null>(null)
  const [deleting, setDeleting] = useState<CodeSp | null>(null)
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['etiquettes-sp-codes'] })
    queryClient.invalidateQueries({ queryKey: ['etiquettes-sp-ligne'] })
  }
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/etiquettes-sp/codes/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setDeleting(null); invalidate() },
  })

  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
  if (isError || !codes) return <div className="flex-1 flex items-center justify-center text-destructive text-sm"><AlertCircle className="h-4 w-4 mr-2" />Erreur de chargement</div>

  const invalid = codes.filter((c) => !c.ean13).length
  const keyCount = new Map<string, number>()
  for (const c of codes) keyCount.set(eanKey(c.code_ean_13), (keyCount.get(eanKey(c.code_ean_13)) ?? 0) + 1)
  const taken = new Set(keyCount.keys())
  const isDup = (c: CodeSp) => !!c.ean13 && (keyCount.get(eanKey(c.code_ean_13)) ?? 0) > 1
  const duplicates = codes.filter(isDup).length
  return (
    <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent px-1 space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Barcode className="h-3.5 w-3.5" />
        <span>{codes.length} coloris · un code EAN par coloris, repris sur les étiquettes des rouleaux (Clients › Commandes, onglet Étiquettes d'une ligne).</span>
      </div>
      {invalid > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>
            {invalid} code{invalid > 1 ? 's' : ''} EAN incomplet{invalid > 1 ? 's' : ''} : leurs étiquettes ne s'impriment pas tant qu'ils ne sont pas corrigés.
            La correction proposée (un 0 manquant) est à confirmer avec Simone Pérèle ; sans proposition, le code est à leur demander.
          </span>
        </div>
      )}
      {duplicates > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{duplicates} coloris partagent leur code EAN avec un autre coloris : à vérifier avec Simone Pérèle.</span>
        </div>
      )}
      <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-200/60 border-b border-border/60">
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 text-left font-semibold">Coloris</th>
              <th className="px-3 py-2 text-left font-semibold">Article client</th>
              <th className="px-3 py-2 text-left font-semibold">Code EAN 13</th>
              <th className="px-3 py-2 text-left font-semibold">Dernier bain</th>
              {editable && <th className="w-16" />}
            </tr>
          </thead>
          <tbody>
            {codes.map((c) => {
              const sugg = !c.ean13 ? suggestedEan(c.code_ean_13, taken) : null
              return (
                <tr key={c.IDcode_sp} className={cn('group border-b border-border/40 last:border-b-0', editable && 'cursor-pointer hover:bg-accent/5')}
                  onClick={editable ? () => setEditing(c) : undefined}>
                  <td className="px-3 py-1.5 font-medium">{c.coloris}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{c.article_client}</td>
                  <td className="px-3 py-1.5 tabular-nums">
                    {c.ean13 ? (
                      <span className={cn(isDup(c) && 'text-amber-700')} title={isDup(c) ? 'Code partagé avec un autre coloris' : undefined}>
                        {isDup(c) && <AlertCircle className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />}{c.ean13}
                      </span>
                    ) : (
                      <span className="text-destructive" title="Code incomplet">
                        <AlertCircle className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />{c.code_ean_13 || 'vide'}
                        {sugg && <span className="text-muted-foreground"> → {sugg} ?</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground tabular-nums">{c.num_bain || '—'}</td>
                  {editable && (
                    <td className="px-2 py-1 text-right whitespace-nowrap">
                      <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity" title="Modifier"
                        onClick={(e) => { e.stopPropagation(); setEditing(c) }}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" title="Supprimer"
                        onClick={(e) => { e.stopPropagation(); setDeleting(c) }}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {editable && (
        <Button variant="ghost" size="sm" onClick={() => setEditing('new')}
          className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40">
          <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un coloris
        </Button>
      )}

      <CodeDialog code={editing} taken={taken} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate() }} />
      <ConfirmDialog
        open={deleting !== null}
        title="Supprimer le coloris"
        description={deleting ? `Le code de « ${deleting.coloris} » sera supprimé : ses étiquettes ne pourront plus être imprimées.` : undefined}
        isPending={deleteMut.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => { if (deleting) deleteMut.mutate(deleting.IDcode_sp) }}
      />
    </div>
  )
}

function CodeDialog({ code, taken, onClose, onSaved }: { code: CodeSp | 'new' | null; taken: Set<string>; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<CodeForm>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (code === null) return
    setError(null)
    setForm(code === 'new' ? EMPTY : {
      coloris: code.coloris, code_ean_13: code.code_ean_13, article_client: code.article_client,
      article_fournisseur: code.article_fournisseur, libelle_article: code.libelle_article, num_bain: code.num_bain,
    })
  }, [code])
  const mut = useMutation({
    mutationFn: () => code === 'new'
      ? apiFetch('/etiquettes-sp/codes', { method: 'POST', body: JSON.stringify(form) })
      : apiFetch(`/etiquettes-sp/codes/${(code as CodeSp).IDcode_sp}`, { method: 'PUT', body: JSON.stringify(form) }),
    onSuccess: onSaved,
    onError: (e: Error & { body?: { message?: string } }) => setError(e.body?.message ?? "L'enregistrement a échoué."),
  })
  const sugg = suggestedEan(form.code_ean_13, taken)
  const set = (k: keyof CodeForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const input = 'w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
  const Field = ({ label, k, hint }: { label: string; k: keyof CodeForm; hint?: string }) => (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input value={form[k]} onChange={set(k)} className={input} />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
  return (
    <Dialog open={code !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {code === 'new' ? <Plus className="h-5 w-5 text-accent" /> : <Pencil className="h-5 w-5 text-accent" />}
            {code === 'new' ? 'Ajouter un coloris' : 'Modifier le coloris'}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Field({ label: 'Coloris', k: 'coloris' })}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Code EAN 13</label>
            <input value={form.code_ean_13} onChange={set('code_ean_13')} className={cn(input, 'tabular-nums')} />
            <p className="text-[11px] text-muted-foreground">12 chiffres : la clé de contrôle est ajoutée à l'impression.</p>
            {sugg && (
              <button type="button" onClick={() => setForm((f) => ({ ...f, code_ean_13: sugg }))}
                className="flex items-center gap-1 text-[11px] text-accent hover:underline">
                <Wand2 className="h-3 w-3" />Il manque un chiffre : utiliser {sugg} ?
              </button>
            )}
          </div>
          <div className="col-span-full">{Field({ label: 'Article client', k: 'article_client' })}</div>
          <div className="col-span-full">{Field({ label: 'Article fournisseur', k: 'article_fournisseur' })}</div>
          {Field({ label: 'Libellé article', k: 'libelle_article' })}
          {Field({ label: 'Dernier N° de bain', k: 'num_bain', hint: "Repris par défaut sur l'étiquette suivante." })}
        </div>
        {error && <div className="mt-3 flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4 flex-shrink-0" />{error}</div>}
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !form.coloris.trim()}>
            {mut.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
