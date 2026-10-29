/** The part of Electron's `Notification` this module uses. */
export interface DesktopNotice {
  on(event: 'click' | 'close', listener: () => void): unknown
  show(): void
  close(): void
}

export interface DesktopNotifierOptions {
  readonly isSupported: () => boolean
  readonly create: (input: { readonly title: string; readonly body: string }) => DesktopNotice
  /** True while the window is visible and focused; the user already sees the app then. */
  readonly isForeground: () => boolean
}

export type DesktopNoticeResult = 'shown' | 'foreground' | 'unsupported'

/**
 * Keeps at most one live system notification per key. Electron cannot replace a notification by tag on every
 * platform, so a newer notification closes the older one before it shows.
 */
export class DesktopNotifier {
  readonly #options: DesktopNotifierOptions
  readonly #live = new Map<string, DesktopNotice>()

  constructor(options: DesktopNotifierOptions) {
    this.#options = options
  }

  show(
    key: string,
    input: { readonly title: string; readonly body: string; readonly onClick: () => void },
  ): DesktopNoticeResult {
    if (this.#options.isForeground()) return 'foreground'
    if (!this.#options.isSupported()) return 'unsupported'
    this.#live.get(key)?.close()
    const notice = this.#options.create({ title: input.title, body: input.body })
    const forget = (): void => {
      if (this.#live.get(key) === notice) this.#live.delete(key)
    }
    notice.on('close', forget)
    notice.on('click', () => {
      forget()
      input.onClick()
    })
    // The map also keeps the notice referenced, so its click handler survives garbage collection.
    this.#live.set(key, notice)
    notice.show()
    return 'shown'
  }
}

/** Collapses one poll's notifications so each id shows once, keeping the newest. */
export const latestPerId = <T extends { readonly id: string }>(items: readonly T[]): readonly T[] => {
  const latest = new Map<string, T>()
  for (const item of items) {
    latest.delete(item.id)
    latest.set(item.id, item)
  }
  return [...latest.values()]
}

/** Connection reminders follow the Desktop-wide switch and the instance's own system notification switch. */
export const connectionNoticeAllowed = (
  connectionNotices: boolean,
  profile: { readonly notificationsEnabled: boolean },
): boolean => connectionNotices && profile.notificationsEnabled
