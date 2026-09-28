// Set the code RH of one of the two people allowed into the RH menu
// (lib/rh-acces.ts). Run ON THE SERVER, never exposed through the app:
// whoever picks a name in the ETM user picker becomes that person, so a
// code settable from the app would protect nothing.
//
//   cd ~/mps_api && NODE_ENV=production npx tsx src/scripts/rh-code.ts --personne isabelle
//       → asks for the code twice, nothing echoed
//   ... --personne vincent --generer
//       → draws a random 8-digit code and prints it once
//
// Dev: without NODE_ENV the script reads .env.development (rh_dev).

import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

import crypto from 'node:crypto'
import readline from 'node:readline'
import { PERSONNES_RH, hacherCode, CODE_MIN_LENGTH } from '../lib/rh-acces.js'
import { ecrireCode, journaliser, fermerRh } from '../lib/rh-store.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Read a line from the terminal without echoing it. */
function lireMasque(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream }
    let prompted = false
    out._writeToOutput = (s: string) => {
      if (!prompted) { process.stdout.write(s); prompted = true }
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function main() {
  const cle = arg('personne')
  const personne = PERSONNES_RH.find((p) => p.cle === cle)
  if (!personne) {
    console.error(`--personne ${PERSONNES_RH.map((p) => p.cle).join('|')} requis`)
    process.exit(1)
  }

  let code: string
  if (process.argv.includes('--generer')) {
    code = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0')
  } else {
    code = await lireMasque(`Code RH pour ${personne.label} : `)
    const encore = await lireMasque('Encore une fois : ')
    if (code !== encore) {
      console.error('Les deux saisies diffèrent — rien n’a été changé.')
      process.exit(1)
    }
  }
  if (code.length < CODE_MIN_LENGTH) {
    console.error(`Au moins ${CODE_MIN_LENGTH} caractères — rien n’a été changé.`)
    process.exit(1)
  }

  const { hash, sel } = hacherCode(code)
  await ecrireCode(personne.cle, hash, sel)
  await journaliser(personne.cle, 'code_defini', 'scripts/rh-code.ts')
  console.log(`Code RH de ${personne.label} enregistré.`)
  if (process.argv.includes('--generer')) console.log(`Code : ${code}   (affiché une seule fois)`)
  await fermerRh()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
