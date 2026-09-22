// TRM's email-notification subscription store (data/notifications-trm.json),
// the twin of ETM's in lib/notifications.ts — same factory, TRM catalog.

import { createNotificationStore } from './notifications.js'
import { isKnownTrmNotificationKey, type TrmNotificationKey } from './notification-keys-trm.js'

export const trmNotifications = createNotificationStore<TrmNotificationKey>(
  'notifications-trm.json',
  isKnownTrmNotificationKey,
)
