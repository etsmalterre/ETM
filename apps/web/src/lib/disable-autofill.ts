/**
 * Globally disable browser + password-manager autocomplete on every input,
 * textarea and select in the app. ETM has no login/credential fields —
 * all forms collect business data (stock, certificates, addresses, etc.)
 * and Dashlane/LastPass/1Password popups just get in the way.
 *
 * Approach: a single MutationObserver that stamps the ignore attributes
 * on every form control at insert time. Handles both the initial render
 * and anything added later by dialogs/drawers.
 */

const ATTRS: Array<[string, string]> = [
  ['autocomplete', 'off'],
  ['autocorrect', 'off'],
  ['autocapitalize', 'off'],
  ['spellcheck', 'false'],
  // Dashlane
  ['data-form-type', 'other'],
  // LastPass
  ['data-lpignore', 'true'],
  // 1Password
  ['data-1p-ignore', 'true'],
  // Bitwarden
  ['data-bwignore', 'true'],
]

function stamp(el: Element): void {
  for (const [name, value] of ATTRS) {
    if (!el.hasAttribute(name)) el.setAttribute(name, value)
  }
}

function stampAllWithin(root: ParentNode): void {
  const nodes = root.querySelectorAll('input, textarea, select')
  for (const n of nodes) stamp(n)
}

export function installAutofillBlocker(): void {
  if (typeof document === 'undefined') return

  // Initial sweep (in case anything rendered before the observer attached)
  stampAllWithin(document)

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        const el = node as Element
        if (
          el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT'
        ) {
          stamp(el)
        }
        stampAllWithin(el)
      }
    }
  })

  observer.observe(document.body, { childList: true, subtree: true })
}
