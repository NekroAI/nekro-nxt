import { describe, expect, it, vi } from 'vitest'
import {
  initializeDesktopManager,
  IpcRegistrationRegistry,
  type IpcRegistrationTarget,
} from '../src/ipc-registration.ts'
import { RuntimeCredentialStore } from '../src/runtime-credential-store.ts'

type HandleListener = (value: unknown) => unknown
type EventListener = (value: unknown) => void

const fakeIpc = () => {
  const handles = new Map<string, HandleListener>()
  const listeners = new Map<string, Set<EventListener>>()
  const failure: { handle?: string; listener?: string } = {}
  const target: IpcRegistrationTarget<HandleListener, EventListener> = {
    handle: (channel, listener) => {
      if (failure.handle === channel) throw new Error(`handle registration failed: ${channel}`)
      if (handles.has(channel)) throw new Error(`duplicate handle: ${channel}`)
      handles.set(channel, listener)
    },
    removeHandler: (channel) => {
      handles.delete(channel)
    },
    on: (channel, listener) => {
      if (failure.listener === channel) throw new Error(`listener registration failed: ${channel}`)
      const channelListeners = listeners.get(channel) ?? new Set()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener)
    },
  }
  return { failure, handles, listeners, target }
}

describe('Desktop manager runtime disposal', () => {
  it('removes every owned handle and exact listener, is idempotent, and permits a new manager registry', () => {
    const ipc = fakeIpc()
    const foreignListener = vi.fn<EventListener>()
    ipc.target.on('nxt:shell:content-pointer', foreignListener)
    const firstListener = vi.fn<EventListener>()
    const first = new IpcRegistrationRegistry(ipc.target)
    first.registerHandle('nxt:shell:current', vi.fn<HandleListener>())
    first.registerHandle('nxt:instances:remove', vi.fn<HandleListener>())
    first.registerListener('nxt:shell:content-pointer', firstListener)

    first.dispose()
    first.dispose()
    expect(ipc.handles.size).toBe(0)
    expect(ipc.listeners.get('nxt:shell:content-pointer')).toEqual(new Set([foreignListener]))
    expect(() => first.registerHandle('nxt:shell:current', vi.fn<HandleListener>())).toThrow('已经停止')

    const second = new IpcRegistrationRegistry(ipc.target)
    expect(() => second.registerHandle('nxt:shell:current', vi.fn<HandleListener>())).not.toThrow()
    second.dispose()
    expect(ipc.handles.size).toBe(0)
  })

  it('clears decrypted credentials and prevents access or writes after disposal', () => {
    const credentials = new RuntimeCredentialStore()
    credentials.set('remote-1', { deviceId: 'device-1', deviceSecret: 's'.repeat(32) })
    expect(credentials.size).toBe(1)
    expect(credentials.get('remote-1')?.deviceSecret).toBe('s'.repeat(32))

    credentials.dispose()
    credentials.dispose()
    expect(credentials.size).toBe(0)
    expect(credentials.get('remote-1')).toBeUndefined()
    expect(() => credentials.set('remote-2', { deviceId: 'device-2', deviceSecret: 't'.repeat(32) })).toThrow(
      '已经停止',
    )
  })

  it.each(['handle', 'listener'] as const)(
    'rolls back every earlier registration when a late %s registration fails',
    (failureKind) => {
      const ipc = fakeIpc()
      const foreignListener = vi.fn<EventListener>()
      const ownedListener = vi.fn<EventListener>()
      ipc.target.on('nxt:shell:content-pointer', foreignListener)
      const failedChannel = failureKind === 'handle' ? 'nxt:instances:late-handle' : 'nxt:instances:late-listener'
      ipc.failure[failureKind] = failedChannel
      const failed = new IpcRegistrationRegistry(ipc.target)

      expect(() =>
        failed.transaction(() => {
          failed.registerHandle('nxt:shell:current', vi.fn<HandleListener>())
          failed.registerListener('nxt:shell:content-pointer', ownedListener)
          if (failureKind === 'handle') {
            failed.registerHandle(failedChannel, vi.fn<HandleListener>())
          } else {
            failed.registerListener(failedChannel, vi.fn<EventListener>())
          }
        }),
      ).toThrow(`registration failed: ${failedChannel}`)
      expect(ipc.handles.size).toBe(0)
      expect(ipc.listeners.get('nxt:shell:content-pointer')).toEqual(new Set([foreignListener]))
      expect(ipc.listeners.get(failedChannel)?.size ?? 0).toBe(0)

      delete ipc.failure[failureKind]
      const retry = new IpcRegistrationRegistry(ipc.target)
      expect(() =>
        retry.transaction(() => {
          retry.registerHandle('nxt:shell:current', vi.fn<HandleListener>())
          retry.registerListener('nxt:shell:content-pointer', vi.fn<EventListener>())
          if (failureKind === 'handle') {
            retry.registerHandle(failedChannel, vi.fn<HandleListener>())
          } else {
            retry.registerListener(failedChannel, vi.fn<EventListener>())
          }
        }),
      ).not.toThrow()
      retry.dispose()
      expect(ipc.handles.size).toBe(0)
      expect(ipc.listeners.get('nxt:shell:content-pointer')).toEqual(new Set([foreignListener]))
    },
  )

  it('disposes a partially initialized manager and destroys its window before rethrowing', async () => {
    const ipc = fakeIpc()
    ipc.failure.handle = 'nxt:instances:late-handle'
    const registry = new IpcRegistrationRegistry(ipc.target)
    const manager = { dispose: vi.fn(() => registry.dispose()) }
    const window = { isDestroyed: vi.fn(() => false), destroy: vi.fn() }

    await expect(
      initializeDesktopManager(
        window,
        () => manager,
        () => {
          registry.transaction(() => {
            registry.registerHandle('nxt:shell:current', vi.fn<HandleListener>())
            registry.registerHandle('nxt:instances:late-handle', vi.fn<HandleListener>())
          })
          return Promise.resolve()
        },
      ),
    ).rejects.toThrow('handle registration failed: nxt:instances:late-handle')
    expect(manager.dispose).toHaveBeenCalledOnce()
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(ipc.handles.size).toBe(0)

    delete ipc.failure.handle
    const replacement = new IpcRegistrationRegistry(ipc.target)
    expect(() => replacement.registerHandle('nxt:shell:current', vi.fn<HandleListener>())).not.toThrow()
    replacement.dispose()
    expect(ipc.handles.size).toBe(0)
  })
})
