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

/**
 * Whether to tell about an instance losing or regaining the connection. Each instance stores its own switch; Desktop
 * remembers the last answer, because the notice matters most while the instance cannot be asked.
 */
export class ConnectionNoticeSwitches {
  readonly #known = new Map<string, boolean>()

  /** `undefined` means the instance did not answer (older versions have no such switch); the last answer stays. */
  remember(profileId: string, enabled: boolean | undefined): void {
    if (enabled !== undefined) this.#known.set(profileId, enabled)
  }

  forget(profileId: string): void {
    this.#known.delete(profileId)
  }

  allows(profile: { readonly id: string; readonly notificationsEnabled: boolean }): boolean {
    return profile.notificationsEnabled && (this.#known.get(profile.id) ?? true)
  }
}
