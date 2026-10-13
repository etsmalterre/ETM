// Content script (mail.google.com): detects the open conversation, reports
// its ids and the Gmail account to the background worker, and shows a
// Tricobot chip next to the subject. Clicking the chip opens the side panel.
// The panel itself is a Chrome side panel, not injected markup, so a Gmail
// redesign can only break this chip and the id detection — never the panel.

import { readConversation, readMailbox } from './gmail-ids'
import type { BadgeMessage, RescanMessage, WorkerMessage } from './background'
import type { GmailContext } from './types'

const CHIP_CLASS = 'tricobot-chip'

let lastKey = ''
let lastBadge: BadgeMessage | null = null
let timer: number | undefined

/** False once the extension was reloaded or updated while Gmail stayed open:
 *  this script is orphaned, and every chrome.runtime call THROWS
 *  synchronously (« Extension context invalidated ») — a .catch() misses it.
 *  The new version's script only arrives with a page reload. */
function connected(): boolean {
  try {
    return !!chrome.runtime?.id
  } catch {
    return false
  }
}

function send(msg: WorkerMessage): void {
  if (!connected()) return stop()
  try {
    chrome.runtime.sendMessage(msg).catch(() => {})
  } catch {
    stop()
  }
}

/** Orphaned: stop watching Gmail and take the chip away (it would open nothing). */
function stop(): void {
  observer.disconnect()
  window.clearTimeout(timer)
  window.removeEventListener('hashchange', onHashChange)
  removeChip()
}

function scan(): void {
  const conv = readConversation(document)
  const context: GmailContext | null = conv ? { ...conv, mailbox: readMailbox(document) } : null
  const key = JSON.stringify(context)
  if (key !== lastKey) {
    lastKey = key
    lastBadge = null
    removeChip()
    send({ type: 'context', context })
  } else if (lastBadge && !document.querySelector(`.${CHIP_CLASS}`)) {
    // Gmail re-rendered the header: put the chip back. (Only when missing —
    // re-rendering mutates the DOM and would re-trigger the observer forever.)
    renderChip(lastBadge)
  }
}

function subjectHeading(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[role="main"] h2[data-legacy-thread-id], [role="main"] h2[data-thread-perm-id]',
  )
}

function removeChip(): void {
  document.querySelectorAll(`.${CHIP_CLASS}`).forEach(el => el.remove())
}

function renderChip(badge: BadgeMessage): void {
  const heading = subjectHeading()
  if (!heading) return
  let text: string
  let modifier = ''
  if (badge.state === 'ok') {
    if (!badge.summary) {
      removeChip()
      return
    }
    text = badge.summary.text + (badge.summary.attention ? ' · à vérifier' : '')
    if (badge.summary.attention) modifier = 'attention'
  } else if (badge.state === 'login') {
    text = 'connexion requise'
    modifier = 'muted'
  } else if (badge.state === 'error') {
    text = 'ETM injoignable'
    modifier = 'muted'
  } else {
    removeChip()
    return
  }

  let chip = heading.parentElement?.querySelector<HTMLButtonElement>(`.${CHIP_CLASS}`) ?? null
  if (!chip) {
    removeChip()
    chip = document.createElement('button')
    chip.type = 'button'
    chip.title = 'Ouvrir le panneau Tricobot'
    chip.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      send({ type: 'open-panel' })
    })
    heading.insertAdjacentElement('afterend', chip)
  }
  chip.className = `${CHIP_CLASS}${modifier ? ` ${CHIP_CLASS}--${modifier}` : ''}`
  chip.replaceChildren()
  const img = document.createElement('img')
  img.src = chrome.runtime.getURL('icons/tricobot-32.png')
  img.alt = ''
  const label = document.createElement('span')
  label.textContent = `Tricobot · ${text}`
  chip.append(img, label)
}

chrome.runtime.onMessage.addListener((msg: BadgeMessage | RescanMessage, _sender, reply) => {
  if (msg?.type === 'rescan') {
    // The panel found no context for this tab (worker restarted, session
    // storage cleared): send it again even if nothing changed here.
    lastKey = ''
    scan()
    reply(true)
    return
  }
  if (msg?.type !== 'badge') return
  lastBadge = msg
  renderChip(msg)
})

const observer = new MutationObserver(() => {
  window.clearTimeout(timer)
  timer = window.setTimeout(scan, 300)
})
observer.observe(document.body, { childList: true, subtree: true })

function onHashChange(): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(scan, 300)
}
window.addEventListener('hashchange', onHashChange)
scan()
