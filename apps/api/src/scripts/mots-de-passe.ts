// Sets account passwords from the server — the bootstrap of the first admin
// password, and the batch Vincent carries to each person's Dashlane on a USB
// stick (decision 2026-09-30: passwords set by the admin, no forced change).
// Dry run by default.
//
//   npx tsx src/scripts/mots-de-passe.ts --identifiant vincent            # prompts nothing: generates one
//   npx tsx src/scripts/mots-de-passe.ts --identifiant mickael --mot-de-passe "quatre mots au hasard"
//   npx tsx src/scripts/mots-de-passe.ts --tous --fichier /media/usb/etm.txt
//        (every active PERSON account without a password)
//   … --write to apply.
//
// The generated passwords are printed (or written to --fichier) ONCE and never
// stored in clear anywhere else. Delete the file once they are in Dashlane.
// Existing sessions of an account are ended when its password is set.

import '../load-env.js'
import * as fs from 'node:fs/promises'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'
import { genererMotDePasse, hacherMotDePasse, motDePasseRefuse } from '../lib/passwords.js'
import { revoquerSessionsDe } from '../lib/sessions.js'

const args = process.argv.slice(2)
const val = (flag: string) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const write = args.includes('--write')
const tous = args.includes('--tous')
const identifiant = val('--identifiant')
const impose = val('--mot-de-passe')
const fichier = val('--fichier')

async function main(): Promise<void> {
  if (!tous && !identifiant) throw new Error('--identifiant <x> or --tous required')
  if (tous && impose) throw new Error('--mot-de-passe goes with a single --identifiant')
  if (impose) {
    const refus = motDePasseRefuse(impose)
    if (refus) throw new Error(refus)
  }
  const sql = mpsPg()
  const cibles = await sql<{ idutilisateur: number; identifiant: string; prenom: string | null; nom: string | null; email: string | null; a_mdp: boolean }[]>`
    SELECT idutilisateur, identifiant, prenom, nom, email, password_hash IS NOT NULL AS a_mdp
    FROM utilisateur
    WHERE actif AND type_compte = 'personne' AND identifiant IS NOT NULL
      AND ${tous ? sql`password_hash IS NULL` : sql`(identifiant = ${identifiant!} OR email = ${identifiant!})`}
    ORDER BY nom, prenom`
  if (!cibles.length) {
    console.log(tous ? 'Every active person account already has a password.' : `No active person account "${identifiant}".`)
    return
  }
  const lignes: string[] = []
  for (const c of cibles) {
    const mdp = impose ?? genererMotDePasse()
    const nom = [c.prenom, c.nom].filter(Boolean).join(' ')
    lignes.push(`${nom}\n  identifiant : ${c.identifiant}${c.email ? `  (ou ${c.email})` : ''}\n  mot de passe : ${write ? mdp : '(généré avec --write)'}\n`)
    if (c.a_mdp) lignes.push('  ⚠️ remplace le mot de passe actuel\n')
    if (write) {
      await sql`UPDATE utilisateur SET password_hash = ${await hacherMotDePasse(mdp)},
        doit_changer_mdp = false, mdp_modifie_le = now() WHERE idutilisateur = ${c.idutilisateur}`
      await revoquerSessionsDe(c.idutilisateur)
    }
  }
  const texte = `ETM / TRM — https://etm.intra.etsmalterre.com\n\n${lignes.join('\n')}`
  if (write && fichier) {
    await fs.writeFile(fichier, texte, { encoding: 'utf8', mode: 0o600 })
    console.log(`${cibles.length} password(s) set, written to ${fichier} — delete it once in Dashlane.`)
  } else {
    console.log(texte)
    console.log(write ? `${cibles.length} password(s) set.` : 'Dry run — re-run with --write.')
  }
}

main()
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1 })
  .finally(() => closeMpsPg())
