import { toast } from '../ui-kit/next/index.js'

export type NotificationTone = 'info' | 'success' | 'warning' | 'error'

/**
 * Result feedback for the settings components that predate the redesigned kit. It shows through the app's single
 * toast stack; warnings and errors stay visible longer.
 */
export function notify(message: string, tone: NotificationTone = 'info', group?: string): void {
  toast(message, { tone: tone === 'error' || tone === 'warning' ? 'bad' : 'ok', ...(group ? { group } : {}) })
}
