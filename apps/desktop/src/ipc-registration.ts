export interface IpcRegistrationTarget<HandleListener, EventListener> {
  handle(channel: string, listener: HandleListener): void
  removeHandler(channel: string): void
  on(channel: string, listener: EventListener): void
  removeListener(channel: string, listener: EventListener): void
}

/** Owns exactly one manager's IPC registrations and removes only the recorded listeners. */
export class IpcRegistrationRegistry<HandleListener, EventListener> {
  readonly #target: IpcRegistrationTarget<HandleListener, EventListener>
  readonly #handleChannels = new Set<string>()
  readonly #eventListeners: Array<{ readonly channel: string; readonly listener: EventListener }> = []
  #disposed = false

  constructor(target: IpcRegistrationTarget<HandleListener, EventListener>) {
    this.#target = target
  }

  registerHandle(channel: string, listener: HandleListener): void {
    if (this.#disposed) throw new Error('Desktop IPC 注册表已经停止。')
    this.#target.handle(channel, listener)
    this.#handleChannels.add(channel)
  }

  registerListener(channel: string, listener: EventListener): void {
    if (this.#disposed) throw new Error('Desktop IPC 注册表已经停止。')
    this.#target.on(channel, listener)
    this.#eventListeners.push({ channel, listener })
  }

  transaction<T>(register: () => T): T {
    if (this.#disposed) throw new Error('Desktop IPC 注册表已经停止。')
    try {
      return register()
    } catch (cause) {
      this.dispose()
      throw cause
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const channel of this.#handleChannels) this.#target.removeHandler(channel)
    for (const { channel, listener } of this.#eventListeners) this.#target.removeListener(channel, listener)
    this.#handleChannels.clear()
    this.#eventListeners.length = 0
  }
}

export const cleanupFailedDesktopManagerInitialization = (
  manager: { dispose(): void },
  window: { isDestroyed(): boolean; destroy(): void },
): void => {
  try {
    manager.dispose()
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}

export const initializeDesktopManager = async <Manager extends { dispose(): void }>(
  window: { isDestroyed(): boolean; destroy(): void },
  createManager: () => Manager,
  initialize: (manager: Manager) => Promise<void>,
): Promise<Manager> => {
  let manager: Manager | undefined
  try {
    manager = createManager()
    await initialize(manager)
    return manager
  } catch (cause) {
    if (manager === undefined) {
      if (!window.isDestroyed()) window.destroy()
    } else {
      cleanupFailedDesktopManagerInitialization(manager, window)
    }
    throw cause
  }
}
