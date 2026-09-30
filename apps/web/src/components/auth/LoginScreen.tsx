// Login screen — identifiant (or email) + password. Two secondary paths below
// the form: enrolling this PC as a station (« Poste », a one-time code from
// Paramètres › Utilisateurs) and, only while the server's AUTH_PICKER
// transition flag is on, the old name picker. On a developer's machine only,
// « dev · Se connecter comme Vincent » (dev build + API lib/dev-login.ts).
//
// No « mot de passe oublié » on purpose (2026-09-30): an administrator resets
// passwords from Paramètres › Utilisateurs.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Code2, KeyRound, Loader2, LogIn, MonitorSmartphone, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { messageErreur, useAppCode, useUser } from '@/contexts/UserContext'
import { AuthCard, AuthLayout, authInputClass } from './AuthLayout'
import { UserPicker } from './UserPicker'

type Mode = 'login' | 'poste' | 'picker'

export function LoginScreen() {
  const [mode, setMode] = useState<Mode>('login')
  const { loginDev } = useUser()
  const [devErreur, setDevErreur] = useState<string | null>(null)
  const { data: config } = useQuery<{ picker: boolean; devLogin?: boolean }>({
    queryKey: ['auth', 'config'],
    queryFn: () => apiFetch('/auth/config'),
    staleTime: 60_000,
    retry: 1,
  })

  if (mode === 'picker' && config?.picker) return <UserPicker onBack={() => setMode('login')} />

  return (
    <AuthLayout>
      {mode === 'poste' ? <PosteForm /> : <LoginForm />}
      <div className="mt-5 flex flex-col items-center gap-2">
        {mode === 'login' ? (
          <button
            type="button"
            onClick={() => setMode('poste')}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-accent transition-colors"
          >
            <MonitorSmartphone className="h-3.5 w-3.5" />
            Poste d’atelier : enrôler ce PC avec un code
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setMode('login')}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-accent transition-colors"
          >
            <LogIn className="h-3.5 w-3.5" />
            Se connecter avec un identifiant
          </button>
        )}
        {config?.picker && (
          <button
            type="button"
            onClick={() => setMode('picker')}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-accent transition-colors"
          >
            <Users className="h-3.5 w-3.5" />
            Choisir mon nom (transition)
          </button>
        )}
        {/* import.meta.env.DEV: compiled out of production bundles. */}
        {import.meta.env.DEV && config?.devLogin && (
          <button
            type="button"
            onClick={() => { setDevErreur(null); loginDev().catch((e) => setDevErreur(messageErreur(e, 'Connexion dev refusée.'))) }}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-accent transition-colors"
          >
            <Code2 className="h-3.5 w-3.5" />
            dev · Se connecter comme Vincent
          </button>
        )}
        {devErreur && <p className="text-xs text-destructive">{devErreur}</p>}
      </div>
    </AuthLayout>
  )
}

function LoginForm() {
  const { login } = useUser()
  const [identifiant, setIdentifiant] = useState('')
  const [motDePasse, setMotDePasse] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!identifiant.trim() || !motDePasse) return
    setErreur(null)
    setPending(true)
    try {
      await login(identifiant.trim(), motDePasse)
    } catch (err) {
      setMotDePasse('')
      setErreur(messageErreur(err, 'La connexion a échoué. Vérifiez que l’application est joignable.'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthCard icon={<KeyRound className="h-5 w-5" />} title="Connexion" subtitle="ETM · TRM — identifiez-vous pour continuer">
      {/* method / action / name are what password managers (Dashlane…) key on
          to offer « save these credentials » — the submit never leaves the page.
          data-autofill="allow" exempts it from lib/disable-autofill.ts. */}
      <form className="space-y-3" method="post" action="/login" data-autofill="allow" onSubmit={submit}>
        <div className="space-y-1">
          <label htmlFor="login-identifiant" className="text-xs font-medium text-muted-foreground">Identifiant ou adresse e-mail</label>
          <input
            id="login-identifiant"
            name="username"
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={identifiant}
            onChange={(e) => setIdentifiant(e.target.value)}
            className={authInputClass}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="login-mdp" className="text-xs font-medium text-muted-foreground">Mot de passe</label>
          <input
            id="login-mdp"
            name="password"
            type="password"
            autoComplete="current-password"
            value={motDePasse}
            onChange={(e) => setMotDePasse(e.target.value)}
            className={authInputClass}
          />
        </div>
        {erreur && (
          <p className="text-xs text-destructive flex items-start gap-1">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
            {erreur}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={pending || !identifiant.trim() || !motDePasse}>
          {pending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5 mr-1.5" />}
          Se connecter
        </Button>
        <p className="text-[11px] text-muted-foreground text-center">
          Mot de passe oublié ? Demandez à un administrateur de le réinitialiser.
        </p>
      </form>
    </AuthCard>
  )
}

function PosteForm() {
  const { enrolerPoste } = useUser()
  const app = useAppCode()
  const [code, setCode] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const c = code.replace(/\s/g, '')
    if (!/^\d{6}$/.test(c)) return
    setErreur(null)
    setPending(true)
    try {
      await enrolerPoste(c, app)
    } catch (err) {
      setCode('')
      setErreur(messageErreur(err, 'L’enrôlement a échoué.'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthCard icon={<MonitorSmartphone className="h-5 w-5" />} title="Enrôler ce poste" subtitle="Code à 6 chiffres donné par un administrateur">
      <form className="space-y-3" onSubmit={submit}>
        <p className="text-sm text-muted-foreground">
          Le code se génère dans Paramètres › Utilisateurs, sur le compte du poste. Il est valable 10 minutes et ne sert qu’une fois.
        </p>
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="off"
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="000000"
          aria-label="Code d’enrôlement"
          className={`${authInputClass} text-center text-lg tracking-[0.3em] placeholder:tracking-[0.3em]`}
        />
        {erreur && (
          <p className="text-xs text-destructive flex items-start gap-1">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
            {erreur}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={pending || !/^\d{6}$/.test(code.replace(/\s/g, ''))}>
          {pending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <MonitorSmartphone className="h-3.5 w-3.5 mr-1.5" />}
          Enrôler ce poste
        </Button>
      </form>
    </AuthCard>
  )
}
