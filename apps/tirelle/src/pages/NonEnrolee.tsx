// A tablet the server does not know: the brand and — only while an admin has a
// tirelle code pending — the way in. The enrolment link FAILS OPEN (atelier
// PWA rule): an error asking whether a code is pending shows the link, because
// hiding it on a failure would lock the tablet out with no way in.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FlaskConical } from 'lucide-react'
import { fetchEnrolementEnAttente } from '@/lib/tirelle-api'
import { EnrolementSheet } from '@/components/EnrolementSheet'

export function NonEnrolee() {
  const [ouvert, setOuvert] = useState(false)
  const attente = useQuery({
    queryKey: ['tirelle', 'enrolement-en-attente'],
    queryFn: fetchEnrolementEnAttente,
  })
  const offrir = attente.isError || attente.data?.enAttente === true

  return (
    <div className="h-full bg-gradient-brand text-white flex flex-col items-center justify-center gap-10 px-8 text-center">
      <img src="/logo-full.png" alt="Malterre" className="h-14 w-auto" />
      <div className="space-y-2">
        <p className="text-xl font-semibold flex items-center justify-center gap-2">
          <FlaskConical className="h-5 w-5 text-gold" />
          Cette tablette n’est pas enrôlée
        </p>
        <p className="text-base text-white/60">Demandez son enrôlement au bureau.</p>
      </div>
      {offrir && (
        <button type="button" onClick={() => setOuvert(true)} className="text-base text-white/60 underline underline-offset-4">
          Enrôler cette tablette
        </button>
      )}
      <p className="text-xs text-white/35 tabular-nums">Version {__APP_VERSION__}</p>
      {ouvert && <EnrolementSheet onClose={() => setOuvert(false)} />}
    </div>
  )
}
