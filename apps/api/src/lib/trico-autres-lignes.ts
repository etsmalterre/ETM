// One knitting order may knit for SEVERAL client lines (LIVA #1398, Vincent 2026-11-26).
//
// Why: order 3957, two lines of 186A in two dyed coloris, both knitted in the same écru 186. The
// launch from a line took only the yarn reserved to THAT line (+ free yarn for the stock), so
// Isabelle made one knitting order per line: 105,4 kg at 2,36 €/kg and 22,2 kg at 4,83 €/kg, two
// orders and two OFs at TRM for one knit. The dyer's launch already carried the écru reserved to
// other lines of the same article (lib/enno-autres-lignes.ts, 2026-11-02): this is its twin.
//
// The rule of 2026-10-28 stays: an order from a line knits only RESERVED yarn (+ free yarn for the
// stock), reserved to this line OR to another client line that knits the same thing. « The same
// thing » is the ÉCRU and its coloris, not the fini article: two dyed coloris of one reference, or
// two finis built on one écru, are one knit. Each line keeps its own yarn in the order, so its
// share is read as ever from the yarn it holds there (lib/parts-tricotage.ts).
//
// Another line's yarn goes only when that line could have launched itself: its order validated
// (not « En préparation ») and not soldée, and EVERY yarn of the recipe reserved to it in stock at
// this knitter (an order goes out with all its yarn, lib/lancement-tricotage.ts).

export interface AutreLigneTricot {
  ligneId: number
  commandeId: number
  /** commande_client.numero, as a string (PG returns a number, #1264) */
  numero: string
  client_nom: string
  /** the client line's « REF - coloris » */
  article: string
  /** YYYYMMDD or '' */
  delai: string
  /** écru kg its reserved yarn makes at this knitter (the scarcest yarn decides, after the freinte) */
  ecru_kg: number
  /** its yarn in stock at this knitter, lot by lot */
  lots: { id: number; kg: number }[]
  /** a line of the order the launch is made from */
  meme_commande: boolean
  /** why its yarn cannot go on the order; null = it can */
  raison: string | null
}

/** The pure decision, unit-tested. `manquants` = the yarns of the recipe the line holds none of at
 *  this knitter. */
export function raisonRefusTricot(l: { memeEcru: boolean; enPreparation: boolean; soldee: boolean; manquants: readonly string[] }): string | null {
  if (!l.memeEcru) return 'réservé pour un autre tricot'
  if (l.soldee) return 'commande soldée'
  if (l.enPreparation) return 'commande en préparation'
  if (l.manquants.length > 0) return `fil incomplet chez ce tricoteur : manque ${l.manquants.join(', ')}`
  return null
}

/** Same knit = the same écru reference and the same écru coloris, both set. */
export function memeTricot(a: { ecru: number; coloris: number }, b: { ecru: number; coloris: number }): boolean {
  return a.ecru > 0 && a.ecru === b.ecru && a.coloris > 0 && a.coloris === b.coloris
}

/** Order of the list: the lines of the same client order first, then the earliest délai. */
export function ordreAutresLignes(a: AutreLigneTricot, b: AutreLigneTricot): number {
  return Number(b.meme_commande) - Number(a.meme_commande)
    || (a.delai || '99999999').localeCompare(b.delai || '99999999')
    || a.ligneId - b.ligneId
}
