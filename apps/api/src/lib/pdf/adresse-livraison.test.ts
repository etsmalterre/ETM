// Delivery-address completeness on the four documents that print one
// (LIVA #1163): order 3835's Livraison address held five lines on screen —
// « VEYRET Découpes », « Attn Monsieur TOMASO », « POUR OPTIMESS COUTURE
// /Valérie », « 41 bis avenue des Allobroges », « 26100 ROMANS sur ISERE » —
// and the confirmation de commande printed WITHOUT the street: the livraison
// builder pushed adresse1 and adresse2 only, while the billing builder next
// to it pushed all three. The devis had the same two-line block; the sst and
// fournisseur orders typed their delivery address with a single street line
// although every route hands over the three.
//
// The components are plain functions with no hooks: calling one yields the
// element tree, and collecting its strings asserts what the document SAYS
// without rendering (claude_doc/pdf_email.md § Asserting on PDF content).
import { describe, it, expect } from 'vitest'
import { CommandeClientPdf, type CommandeClientPdfData } from './CommandeClientPdf.js'
import { DevisEtmPdf, type DevisEtmPdfData } from './DevisEtmPdf.js'
import { CommandeSoustraitantPdf, type CommandeSoustraitantPdfData } from './CommandeSoustraitantPdf.js'
import { CommandeFournisseurPdf, type CommandeFournisseurPdfData } from './CommandeFournisseurPdf.js'

// Nested components (the shared `AddressCard` of the fournisseur order) are
// function-typed elements whose text sits behind `props.data`, not
// `props.children`: invoke them to descend. react-pdf primitives are
// string-typed and hold their content in `children`.
function pdfStrings(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) pdfStrings(c, out); return out }
  const el = node as { type?: unknown; props?: { children?: unknown } }
  if (typeof el.type === 'function') return pdfStrings((el.type as (p: unknown) => unknown)(el.props), out)
  if (el.props?.children !== undefined) pdfStrings(el.props.children, out)
  return out
}

// Order 3835's delivery address, as stored in `adresse` (three street lines).
const livraison3835 = {
  nom: 'VEYRET Découpes',
  adresse1: 'Attn Monsieur TOMASO',
  adresse2: 'POUR OPTIMESS COUTURE /Valérie',
  adresse3: '41 bis avenue des Allobroges',
  cp: '26100',
  ville: 'ROMANS sur ISERE',
  pays: 'France',
}

const facturation3835 = {
  nom: '16.9. Seize Point Neuf',
  adresse1: '205 La menardière',
  adresse2: null,
  adresse3: null,
  cp: '44330',
  ville: 'Vallet',
  pays: 'France',
}

const STREET_LINES = [livraison3835.adresse1, livraison3835.adresse2, livraison3835.adresse3]

function expectDeliveryStreetLines(strings: string[]) {
  for (const line of STREET_LINES) expect(strings).toContain(line)
  expect(strings).toContain('26100 ROMANS sur ISERE')
}

describe('delivery address prints all three street lines (LIVA #1163)', () => {
  it('confirmation de commande', () => {
    const data: CommandeClientPdfData = {
      numero: '3835',
      dateCommande: '20 juillet 2026',
      clientNom: 'Seize Point Neuf',
      refClient: 'Commande du 13/07/2026',
      adresseFacturation: facturation3835,
      adresseLivraison: livraison3835,
      modePaiement: 'VIREMENT',
      echeance: 'Avant livraison',
      commentaire: null,
      remise: 0,
      fraisPort: 0,
      tvaRate: 20,
      lignes: [{
        ref_label: '029A', colori_reference: '2306 rouge 63839/1',
        quantite: 213, unite_label: 'Ml', prix: 8.48, montant: 1806.24, date_livraison: '18/09/2026',
      }],
    }
    expectDeliveryStreetLines(pdfStrings(CommandeClientPdf({ data })))
  })

  it('devis', () => {
    const data: DevisEtmPdfData = {
      numero: '512',
      dateDevis: '20 juillet 2026',
      dateExpiration: '',
      clientNom: 'Seize Point Neuf',
      refClient: null,
      adresseFacturation: facturation3835,
      adresseLivraison: livraison3835,
      modePaiement: 'VIREMENT',
      echeance: 'Avant livraison',
      commentaire: null,
      remise: 0,
      fraisPort: 0,
      tvaRate: 20,
      lignes: [],
    }
    expectDeliveryStreetLines(pdfStrings(DevisEtmPdf({ data })))
  })

  it('bon de commande sous-traitant', () => {
    const data: CommandeSoustraitantPdfData = {
      numero: '7001',
      dateCommande: '20 juillet 2026',
      qty_unit: 'Ml',
      sousTraitantNom: 'MATEL',
      sousTraitantAdresse: facturation3835,
      adresseLivraison: livraison3835,
      delaiLivraison: null,
      commentaire: null,
      lignes: [],
    }
    expectDeliveryStreetLines(pdfStrings(CommandeSoustraitantPdf({ data })))
  })

  it('bon de commande fournisseur', () => {
    const data: CommandeFournisseurPdfData = {
      numero: '4101',
      dateCommande: '20 juillet 2026',
      fournisseurNom: 'FILATURE',
      fournisseurAdresse: facturation3835,
      adresseLivraison: livraison3835,
      modePaiement: null,
      echeance: null,
      delaiLivraison: null,
      commentaire: null,
      lignes: [],
    }
    expectDeliveryStreetLines(pdfStrings(CommandeFournisseurPdf({ data })))
  })
})
