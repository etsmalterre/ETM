// Background service worker: keeps each Gmail tab's open conversation in
// storage.session (read by the side panel), feeds the subject chip in the
// content script, and opens the side panel on demand.

import { ApiError, fetchConversation } from './api'
import { contextKey, getSession } from './config'
import { badgeSummary, type BadgeSummary } from './format'
import type { GmailContext } from './types'

export type BadgeMessage =
  | { type: 'badge'; state: 'ok'; summary: BadgeSummary | null }
  | { type: 'badge'; state: 'login' | 'error' | 'hidden' }

/** Panel → content script: report the open conversation again. */
export type RescanMessage = { type: 'rescan' }

export type WorkerMessage =
  | { type: 'context'; context: GmailContext | null }
  | { type: 'open-panel' }
  | { type: 'refresh'; tabId: number }

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
})

chrome.runtime.onMessage.addListener((msg: WorkerMessage, sender) => {
  const tabId = msg.type === 'refresh' ? msg.tabId : sender.tab?.id
  if (tabId === undefined) return

  if (msg.type === 'open-panel') {
    // Must run synchronously in the click's user-gesture window.
    void chrome.sidePanel.open({ tabId })
    return
  }
  if (msg.type === 'context') {
    void chrome.storage.session
      .set({ [contextKey(tabId)]: msg.context })
      .then(() => refreshBadge(tabId, msg.context))
    return
  }
  if (msg.type === 'refresh') {
    void chrome.storage.session.get(contextKey(tabId)).then(stored => {
      void refreshBadge(tabId, (stored[contextKey(tabId)] as GmailContext | null | undefined) ?? null)
    })
  }
})

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(contextKey(tabId))
})

async function refreshBadge(tabId: number, context: GmailContext | null): Promise<void> {
  let message: BadgeMessage
  if (!context) {
    message = { type: 'badge', state: 'hidden' }
  } else if (!(await getSession())) {
    message = { type: 'badge', state: 'login' }
  } else {
    try {
      message = { type: 'badge', state: 'ok', summary: badgeSummary(await fetchConversation(context)) }
    } catch (e) {
      message = { type: 'badge', state: e instanceof ApiError && e.status === 401 ? 'login' : 'error' }
    }
  }
  // The tab may have navigated away or closed meanwhile.
  chrome.tabs.sendMessage(tabId, message).catch(() => {})
}
