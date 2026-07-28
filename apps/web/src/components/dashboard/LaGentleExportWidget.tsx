// ── Stock La Gentle export widget ─────────────────────────────
// Pick a cutoff date → download an Excel of La Gentle Factory (client 8) yarn
// lots (terminé = 0) whose last movement is on or before that date. Backed by
// GET /api/stock/fil/la-gentle-stale; the .xlsx is built client-side (SheetJS
// lazy-loaded on click so it never bloats the main bundle).

import { useState } from 'react'
import { FileSpreadsheet, Download, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { formatHfsqlDate, inputDateToHfsql } from '@/lib/dates'
import { WidgetFrame } from './WidgetFrame'

interface LaGentleRow {
  client: string
  lot: string
  reference: string
  coloris: string
  stock: number
  emplacement: string
  commentaire: string
  dernier_mouvement: string // YYYYMMDD
}
interface LaGentleResponse {
  client_nom: string
  cutoff: string
  count: number
  rows: LaGentleRow[]
}

// The widget asks for the REPORT date (default today). The movement cutoff is
// derived as report_date − 6 months, mirroring the legacy DATEADD(month,-6,SYSDATE):
// the report lists La Gentle lots with no movement in the 6 months before the
// chosen date.
function todayInput(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// "2026-06-01" → "20251201" (report date minus 6 months, HFSQL YYYYMMDD).
function movementCutoffHfsql(reportInputDate: string): string {
  const [y, m, day] = reportInputDate.split('-').map(Number)
  const d = new Date(y, (m - 1), day)
  d.setMonth(d.getMonth() - 6)
  const yy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

export function LaGentleExportWidget() {
  const [date, setDate] = useState(todayInput)
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'empty' | 'error'>('idle')
  const [lastCount, setLastCount] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')

  async function handleDownload() {
    const reportDate = inputDateToHfsql(date)
    if (!/^\d{8}$/.test(reportDate)) {
      setStatus('error'); setErrorMsg('Date invalide.'); return
    }
    // Legacy semantics: filter on movements ≥ 6 months old at the report date.
    const cutoff = movementCutoffHfsql(date)
    setStatus('loading'); setErrorMsg('')
    try {
      const data = await apiFetch<LaGentleResponse>(`/stock/fil/la-gentle-stale?cutoff=${cutoff}`)
      setLastCount(data.count)
      if (data.count === 0) { setStatus('empty'); return }

      const XLSX = await import('xlsx')
      const headers = ['Client', 'Lot', 'Référence', 'Coloris', 'Stock (kg)', 'Emplacement', 'Commentaire', 'Dernier mouvement']
      const aoa: (string | number)[][] = [
        headers,
        ...data.rows.map((r) => [
          r.client,
          r.lot,
          r.reference,
          r.coloris,
          r.stock,
          r.emplacement,
          r.commentaire,
          r.dernier_mouvement ? formatHfsqlDate(r.dernier_mouvement) : '',
        ]),
      ]
      const ws = XLSX.utils.aoa_to_sheet(aoa)
      ws['!cols'] = [
        { wch: 18 }, { wch: 10 }, { wch: 24 }, { wch: 14 },
        { wch: 10 }, { wch: 14 }, { wch: 32 }, { wch: 16 },
      ]
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Stock La Gentle')
      XLSX.writeFile(wb, `Stock_La_Gentle_${reportDate}.xlsx`)
      setStatus('done')
    } catch (err) {
      console.error('La Gentle export failed:', err)
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'Échec de la génération.')
    }
  }

  return (
    <WidgetFrame
      icon={FileSpreadsheet}
      title="Stock La Gentle"
    >
      <CardContent className="space-y-5 p-5">
        <p className="text-sm text-muted-foreground">
          Génère un fichier Excel des lots de fil de <span className="font-semibold text-foreground">La Gentle Factory</span> en
          stock dont le dernier mouvement remonte à plus de 6 mois avant la date du rapport.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Date du rapport</label>
            <input
              type="date"
              value={date}
              onChange={(e) => { setDate(e.target.value); setStatus('idle') }}
              className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex items-end">
            <Button
              onClick={handleDownload}
              disabled={status === 'loading'}
              className="w-full"
            >
              {status === 'loading'
                ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                : <Download className="h-4 w-4 mr-1.5" />}
              Télécharger l'export Excel
            </Button>
          </div>
        </div>

        {/* Status line */}
        <div className="min-h-[20px] text-sm">
          {status === 'done' && (
            <p className="flex items-center gap-1.5 text-success">
              <CheckCircle2 className="h-4 w-4" />
              {lastCount} rouleau{lastCount > 1 ? 'x' : ''} exporté{lastCount > 1 ? 's' : ''}.
            </p>
          )}
          {status === 'empty' && (
            <p className="text-muted-foreground italic">Aucun rouleau ne correspond à cette date.</p>
          )}
          {status === 'error' && (
            <p className="flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              {errorMsg || 'Une erreur est survenue.'}
            </p>
          )}
        </div>
      </CardContent>
    </WidgetFrame>
  )
}
