import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { onChunkLoadError } from '@/lib/chunk-error'
import { updateServiceWorkerAndWait } from '@/lib/sw-refresh'

/**
 * Mounted once at the app root. Watches for a lazily-imported chunk failing to
 * load - which, in practice, means this tab was open across a deploy and is now
 * running a build whose chunks are gone from the server (see lib/chunk-error.ts)
 * - and offers a reload instead of letting the click die silently.
 *
 * Deliberately a prompt rather than an automatic reload: this is an ERP whose
 * screens have edit modes, and the failure surfaces mid-session (the user just
 * clicked Exporter Excel). Reloading out from under half-filled form would trade
 * a broken button for lost work. "Plus tard" leaves them in place - the feature
 * stays unavailable until they reload, which is what was already happening,
 * only now they know why.
 */
export function StaleBundleReload() {
  const [open, setOpen] = useState(false)
  const [reloading, setReloading] = useState(false)

  useEffect(() => onChunkLoadError(() => setOpen(true)), [])

  const reload = useCallback(async () => {
    setReloading(true)
    try {
      // Usually a no-op here: the new worker has already activated (that is what
      // took the old chunks away). It matters in the other order - deploy landed,
      // SW hasn't picked it up yet, the chunk 404'd straight from nginx - where
      // reloading without waiting would just serve the old build again.
      await updateServiceWorkerAndWait()
    } catch {
      // Never block the reload on the SW.
    }
    window.location.reload()
  }, [])

  return (
    <ConfirmDialog
      open={open}
      variant="default"
      title="Nouvelle version disponible"
      description="L'application a été mise à jour depuis l'ouverture de cet onglet. Rechargez la page pour accéder à cette fonctionnalité."
      confirmLabel="Recharger"
      cancelLabel="Plus tard"
      isPending={reloading}
      onConfirm={() => void reload()}
      onCancel={() => setOpen(false)}
    />
  )
}
