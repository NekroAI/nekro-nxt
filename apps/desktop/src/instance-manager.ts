import {
  BrowserWindow,
  Notification,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session,
} from 'electron'
import { ClientNotificationFeedResponseSchema } from '@nekro-nxt/contracts'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CredentialVault } from './credential-vault.js'
import { trustedInstanceFailure, trustedInstanceSuccess } from './instance-operation-error.js'
import {
  InstanceProfileStore,
  assertInsecureHttpConfirmed,
  normalizeRemoteOrigin,
  type InstanceProfile,
  type InstanceStatus,
} from './instance-profiles.js'
import {
  assertSameOriginRemoteUrl,
  fetchSameOriginRemote,
  installSameOriginNavigationGuard,
} from './remote-navigation.js'
import {
  addRemoteProfile,
  editRemoteProfileConnection,
  reauthenticateRemoteProfile,
  type RemoteProfileConnectionEditResult,
} from './remote-profile-enrollment.js'
import { certificateSpki } from './remote-pairing.js'
import {
  establishRemoteSession,
  probeRemoteProfile as probeRemoteSession,
  tryRevokeRemoteDevice,
} from './remote-session.js'
import { SerialTaskQueue } from './serial-task-queue.js'
import { renderTrustedFallbackHtml, trustedFallbackForError, type TrustedFallbackAction } from './trusted-fallback.js'
import { isAllowedExternalUrl, type ProductRelease } from './distribution.js'
import { desktopTitleBarCss, desktopWindowChrome } from './window-chrome.js'
import { detachAndCloseView } from './view-lifecycle.js'
import type { LocalHostStatus } from './local-host-state.js'
import { SerialProfileMonitor, type ProfileMonitorTarget } from './serial-profile-monitor.js'
import { bringChildViewToFront, desktopViewBounds } from './view-layout.js'
import { SnapshotRevisionClock } from './snapshot-revision.js'
import { ProfileGenerationRegistry } from './profile-generation.js'
import type { OverlayOpenIntent, OverlayVisibility } from './overlay-visibility.js'
import { IpcRegistrationRegistry, type IpcRegistrationTarget } from './ipc-registration.js'
import { initializeDesktopManager } from './ipc-registration.js'
import { RuntimeCredentialStore } from './runtime-credential-store.js'
import { installF12DevToolsShortcut } from './devtools-shortcut.js'
import {
  ManagerMutationLifecycle,
  runManagerMutation,
  type ManagerMutationToken,
} from './manager-mutation-lifecycle.js'
import {
  assertExactTrustedUrl,
  assertTrustedOverlayIpcEvent,
  installExactTrustedNavigationGuard,
  LatestTrustedLoad,
  OverlayLoadRestoreGate,
  runLatestTrustedLoadAction,
  type TrustedLoadToken,
  type TrustedOverlayIpcEvent,
} from './trusted-view-navigation.js'

const OVERLAY_EXIT_MS = 100
const FALLBACK_EXIT_MS = 180
type ClientNotificationFeed = ReturnType<(typeof ClientNotificationFeedResponseSchema)['parse']>
type DesktopHandleListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type DesktopEventListener = (event: IpcMainEvent, ...args: unknown[]) => void

const desktopIpcTarget: IpcRegistrationTarget<DesktopHandleListener, DesktopEventListener> = {
  handle: (channel, listener) => ipcMain.handle(channel, listener),
  removeHandler: (channel) => ipcMain.removeHandler(channel),
  on: (channel, listener) => ipcMain.on(channel, listener),
  removeListener: (channel, listener) => ipcMain.removeListener(channel, listener),
}

interface ProfilePresentation {
  readonly id: string
  readonly kind: 'local' | 'remote'
  readonly displayName: string
  readonly origin: string
  readonly addressLabel: string
  readonly status: InstanceStatus
  readonly notificationsEnabled: boolean
  readonly requiresAuthentication: boolean
  readonly insecureHttp: boolean
}

interface InstanceSnapshot {
  readonly revision: number
  readonly currentProfileId: string
  readonly profiles: readonly ProfilePresentation[]
}

interface CurrentInstancePresentation {
  readonly revision: number
  readonly displayName: string
  readonly status: InstanceStatus
}

type OverlayOpeningSource = 'product' | 'fallback-instances' | 'fallback-reauthenticate'

interface FallbackLoadBinding {
  readonly url: string
  readonly profileId: string
  actions: ReadonlyMap<string, () => void>
}

const rendererAsset = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url))
const overlayRendererUrl = (): string => pathToFileURL(rendererAsset('instance-overlay.html')).href
const productPreload = (): string => rendererAsset('product-preload.cjs')
const overlayPreload = (): string => rendererAsset('overlay-preload.cjs')

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field}不能为空。`)
  return value
}
const optionalSecret = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

const routeWithDesktop = (profile: InstanceProfile): string => {
  const url = new URL(profile.lastRoute, profile.origin)
  url.searchParams.set('desktop', '1')
  return url.href
}

const savedRoute = (profile: InstanceProfile, target: string): string | undefined => {
  try {
    const url = new URL(target)
    if (url.origin !== profile.origin) return undefined
    url.searchParams.delete('desktop')
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return undefined
  }
}

export class DesktopInstanceManager {
  readonly #window: BrowserWindow
  readonly #release: ProductRelease
  readonly #profiles: InstanceProfileStore
  readonly #vault: CredentialVault
  readonly #statuses = new Map<string, InstanceStatus>()
  readonly #memoryCredentials = new RuntimeCredentialStore()
  readonly #notificationCursors = new Map<string, number>()
  readonly #profileGenerations = new ProfileGenerationRegistry()
  readonly #switchingProfiles = new Map<string, number>()
  readonly #observedRemoteAvailability = new Map<string, boolean>()
  readonly #overlayWaiters = new Set<() => void>()
  readonly #instanceMutations = new SerialTaskQueue()
  readonly #mutationLifecycle = new ManagerMutationLifecycle()
  readonly #profileMonitor: SerialProfileMonitor<ClientNotificationFeed>
  readonly #snapshotRevision = new SnapshotRevisionClock()
  readonly #fallbackLoads = new LatestTrustedLoad<FallbackLoadBinding>()
  readonly #overlayLoadGate = new OverlayLoadRestoreGate()
  readonly #ipcRegistrations = new IpcRegistrationRegistry(desktopIpcTarget)
  #productView: WebContentsView | undefined
  #overlayView: WebContentsView | undefined
  #fallbackView: WebContentsView | undefined
  #currentProfileId: string
  #overlayOpen = false
  #overlayOpeningSource: OverlayOpeningSource | undefined
  #overlayIntent: OverlayOpenIntent = { kind: 'list' }
  #overlayTrustedUrl = overlayRendererUrl()
  #overlayCloseTimer: ReturnType<typeof setTimeout> | undefined
  #overlayOpenSerial = 0
  #fallbackCloseTimer: ReturnType<typeof setTimeout> | undefined
  #surfaceTheme: 'light' | 'dark' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  #switchSerial = 0
  #profileMutationSerial = 0
  #retirementSerial = 0
  #localHostStatus: LocalHostStatus
  #lastCurrentPresentationSignature: string | undefined
  #disposed = false

  private constructor(input: {
    window: BrowserWindow
    release: ProductRelease
    profiles: InstanceProfileStore
    vault: CredentialVault
    localHostStatus: LocalHostStatus
  }) {
    this.#window = input.window
    this.#release = input.release
    this.#profiles = input.profiles
    this.#vault = input.vault
    this.#currentProfileId = input.profiles.selectedProfileId
    this.#localHostStatus = input.localHostStatus
    for (const profile of input.profiles.list()) {
      this.#profileGenerations.register(profile.id)
      this.#statuses.set(profile.id, profile.kind === 'local' ? input.localHostStatus : 'connecting')
    }
    this.#profileMonitor = new SerialProfileMonitor<ClientNotificationFeed>({
      getTargets: () => this.#monitorTargets(),
      isCurrent: (target) => this.#isCurrentMonitorTarget(target),
      probeRemote: (target, signal) => this.#probeRemoteProfile(target, signal),
      statusFromProbeError: (cause) =>
        trustedFallbackForError(cause, { canReauthenticate: true, canReturnLocal: false }).status,
      commitRemoteStatus: (target, status) => this.#commitRemoteMonitorStatus(target, status),
      readNotifications: (target, signal) => this.#readNotifications(target, signal),
      commitNotifications: (target, feed) => this.#commitNotifications(target, feed),
      onNotificationError: (target, cause) => this.#handleNotificationError(target, cause),
      onCycleError: (cause) => console.error('[nekro-nxt] Desktop Profile 监视轮次失败，将继续下一轮：', cause),
    })
  }

  static async create(input: {
    readonly localOrigin: string
    readonly release: ProductRelease
    readonly localHostStatus: LocalHostStatus
  }): Promise<DesktopInstanceManager> {
    const userData = app.getPath('userData')
    const profiles = await InstanceProfileStore.open(path.join(userData, 'instance-profiles.json'), input.localOrigin)
    const vault = await CredentialVault.open(path.join(userData, 'instance-credentials.json'))
    const window = new BrowserWindow({
      width: 1360,
      height: 880,
      minWidth: 980,
      minHeight: 680,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0F1A2C' : '#F5F2EE',
      ...desktopWindowChrome(process.platform),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    return initializeDesktopManager(
      window,
      () =>
        new DesktopInstanceManager({
          window,
          release: input.release,
          profiles,
          vault,
          localHostStatus: input.localHostStatus,
        }),
      async (manager) => {
        manager.#registerIpc()
        manager.#window.on('resize', () => manager.#layout())
        manager.#window.on('close', () => manager.dispose())
        await manager.switchTo(profiles.selectedProfileId, false)
        manager.#window.show()
        manager.#profileMonitor.start()
      },
    )
  }

  get window(): BrowserWindow {
    return this.#window
  }

  commitLocalHostStatus(status: LocalHostStatus): void {
    if (this.#disposed) return
    this.#localHostStatus = status
    if (this.#statuses.get('local') === status) return
    this.#statuses.set('local', status)
    this.#publishPresentationChange()
  }

  async switchTo(profileId: string, persist = true, force = false, skipDraftConfirm = false): Promise<void> {
    if (this.#disposed) throw new Error('Desktop 实例管理器已经停止。')
    const profile = this.#profiles.get(profileId)
    if (profile === undefined) throw new Error('服务实例不存在。')
    if (!force && profileId === this.#currentProfileId && this.#productView !== undefined) return
    if (!skipDraftConfirm && profileId !== this.#currentProfileId && !(await this.#confirmDiscardDrafts())) return
    this.#surfaceTheme = (await this.#readProductTheme()) ?? this.#surfaceTheme
    const serial = ++this.#switchSerial
    this.#profileGenerations.advance(profile.id, 'switch')
    this.#switchingProfiles.set(profile.id, serial)
    this.closeOverlay(false, false)
    this.#statuses.set(profile.id, 'connecting')
    this.#currentProfileId = profile.id
    await this.#showFallback(profile, `正在连接「${profile.displayName}」`, '正在读取该实例的工作区…', [])
    if (serial !== this.#switchSerial) return
    this.#destroyProductView()
    this.#window.setTitle(`NekroNXT — ${profile.displayName}`)
    this.#publishPresentationChange()
    try {
      if (persist) await this.#profiles.select(profile.id)
      const partitionSession = session.fromPartition(profile.partition)
      this.#configureSession(profile, partitionSession)
      if (profile.kind === 'remote') await this.#establishRemoteSession(profile, partitionSession)
      if (serial !== this.#switchSerial) return
      const view = this.#createProductView(profile)
      this.#productView = view
      this.#window.contentView.addChildView(view)
      this.#bringFallbackToFront()
      this.#bringOverlayToFront()
      this.#layout()
      await view.webContents.loadURL(routeWithDesktop(profile))
      assertSameOriginRemoteUrl(profile.origin, view.webContents.getURL())
      if (serial !== this.#switchSerial) return
      if (profile.kind === 'local') this.#localHostStatus = 'ready'
      this.#statuses.set(profile.id, 'ready')
      this.#hideFallback()
      this.#publishPresentationChange()
    } catch (error) {
      if (serial !== this.#switchSerial) return
      this.#destroyProductView()
      console.error(`[nekro-nxt] Desktop 实例连接失败（${profile.id} · ${profile.origin}）：`, error)
      const fallback = trustedFallbackForError(error, {
        canReauthenticate: profile.kind === 'remote' && profile.transport !== 'loopback-http',
        canReturnLocal: profile.kind === 'remote',
      })
      this.#statuses.set(profile.id, profile.kind === 'local' ? this.#localHostStatus : fallback.status)
      await this.#showFallback(profile, `无法连接「${profile.displayName}」`, fallback.body, fallback.actions)
      this.#publishPresentationChange()
    } finally {
      if (this.#switchingProfiles.get(profile.id) === serial) this.#switchingProfiles.delete(profile.id)
    }
  }

  async openOverlay(
    source: OverlayOpeningSource = 'product',
    intent: OverlayOpenIntent = { kind: 'list' },
  ): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error('Desktop 实例管理器已经停止。'))
    const serial = ++this.#overlayOpenSerial
    this.#surfaceTheme = (await this.#readProductTheme()) ?? this.#surfaceTheme
    if (this.#disposed) throw new Error('Desktop 实例管理器已经停止。')
    if (serial !== this.#overlayOpenSerial) return
    this.#overlayIntent = intent
    this.#overlayLoadGate.updateIntent()
    if (!this.#overlayOpen) {
      this.#overlayOpen = true
      this.#overlayOpeningSource = source
      if (this.#overlayCloseTimer !== undefined) clearTimeout(this.#overlayCloseTimer)
      this.#overlayCloseTimer = undefined
      if (this.#overlayView === undefined) {
        const view = new WebContentsView({
          webPreferences: {
            preload: overlayPreload(),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        })
        view.setBackgroundColor('#00000000')
        installF12DevToolsShortcut(view.webContents)
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        installExactTrustedNavigationGuard(view.webContents, () => this.#overlayTrustedUrl)
        view.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
          if (isMainFrame) this.#overlayLoadGate.beginDocument()
        })
        view.webContents.on('dom-ready', () => this.#restoreOverlayAfterLoad(view))
        view.webContents.on('did-finish-load', () => this.#restoreOverlayAfterLoad(view))
        void view.webContents
          .loadURL(this.#overlayTrustedUrl)
          .then(() => this.#restoreOverlayAfterLoad(view))
          .catch((error: unknown) => {
            if (!this.#disposed && !view.webContents.isDestroyed()) {
              console.error('[nekro-nxt] Desktop 实例浮层加载失败：', error)
            }
            this.#discardFailedOverlay(view)
          })
        this.#overlayView = view
      }
      if (!this.#window.contentView.children.includes(this.#overlayView)) {
        this.#window.contentView.addChildView(this.#overlayView)
      }
      this.#layout()
      if (!this.#overlayView.webContents.isLoading()) {
        this.#restoreOverlayAfterLoad(this.#overlayView)
      }
      this.#overlayView.webContents.focus()
    } else {
      const view = this.#overlayView
      if (view !== undefined) this.#restoreOverlayAfterLoad(view)
    }
    return new Promise((resolve) => this.#overlayWaiters.add(resolve))
  }

  closeOverlay(immediate = false, restoreFocus = true, restoreControl = false): void {
    this.#overlayOpenSerial += 1
    if (!this.#overlayOpen) return
    this.#overlayOpen = false
    const openingSource = this.#overlayOpeningSource
    this.#overlayOpeningSource = undefined
    for (const resolve of this.#overlayWaiters) resolve()
    this.#overlayWaiters.clear()
    const view = this.#overlayView
    if (view !== undefined && !view.webContents.isDestroyed()) {
      this.#sendOverlayVisibility({ state: 'closing' })
    }
    const detach = (): void => {
      this.#overlayCloseTimer = undefined
      if (view === undefined || this.#overlayView !== view || this.#overlayOpen) return
      try {
        if (!this.#window.isDestroyed() && this.#window.contentView.children.includes(view)) {
          this.#window.contentView.removeChildView(view)
        }
      } catch {
        // BrowserWindow teardown may finish before the exit transition callback.
      }
      if (!this.#disposed && restoreFocus) this.#restoreOverlayFocus(openingSource, restoreControl)
    }
    if (this.#overlayCloseTimer !== undefined) clearTimeout(this.#overlayCloseTimer)
    if (immediate) detach()
    else this.#overlayCloseTimer = setTimeout(detach, OVERLAY_EXIT_MS)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#ipcRegistrations.dispose()
    this.#mutationLifecycle.dispose()
    this.#instanceMutations.close()
    this.#switchSerial += 1
    this.#profileMonitor.stop()
    this.#memoryCredentials.dispose()
    this.#notificationCursors.clear()
    this.#observedRemoteAvailability.clear()
    this.#switchingProfiles.clear()
    this.#statuses.clear()
    this.#profileGenerations.clear()
    this.#fallbackLoads.clear()
    this.#overlayIntent = { kind: 'list' }
    this.#lastCurrentPresentationSignature = undefined
    if (this.#overlayCloseTimer !== undefined) clearTimeout(this.#overlayCloseTimer)
    this.#overlayCloseTimer = undefined
    if (this.#fallbackCloseTimer !== undefined) clearTimeout(this.#fallbackCloseTimer)
    this.#fallbackCloseTimer = undefined
    this.closeOverlay(true, false)
    this.#destroyProductView()
    detachAndCloseView(this.#window, this.#fallbackView)
    this.#fallbackView = undefined
    detachAndCloseView(this.#window, this.#overlayView)
    this.#overlayView = undefined
  }

  #registerIpc(): void {
    this.#ipcRegistrations.transaction(() => {
      this.#ipcRegistrations.registerHandle('nxt:shell:current', (event) => {
        this.#assertProductSender(event.sender.id)
        return this.#currentPresentation()
      })
      this.#ipcRegistrations.registerHandle('nxt:shell:open-switcher', (event) => {
        this.#assertProductSender(event.sender.id)
        return this.openOverlay('product', { kind: 'list' })
      })
      this.#ipcRegistrations.registerHandle('nxt:shell:close-switcher', (event) => {
        this.#assertProductSender(event.sender.id)
        this.closeOverlay(false, true, false)
      })
      this.#ipcRegistrations.registerListener('nxt:shell:content-pointer', (event) => {
        if (event.sender.id === this.#productView?.webContents.id) this.closeOverlay(false, true, false)
      })
      this.#registerOverlayIpc('list', () => this.#snapshot())
      this.#registerOverlayIpc('close', (value) =>
        this.closeOverlay(false, true, isRecord(value) && value['restoreControl'] === true),
      )
      this.#registerOverlayIpc('switch', async (value) => {
        await this.#runInstanceMutation(() =>
          this.switchTo(requiredString(isRecord(value) ? value['profileId'] : undefined, '服务实例')),
        )
      })
      this.#registerOverlayIpc('retry', async (value) => {
        await this.#runInstanceMutation(() =>
          this.switchTo(requiredString(isRecord(value) ? value['profileId'] : undefined, '服务实例'), true, true),
        )
      })
      this.#registerOverlayIpc('add', async (value) => {
        await this.#runInstanceMutation(async (lifecycle) => {
          if (!isRecord(value)) throw new Error('添加实例参数无效。')
          const managementKey = optionalSecret(value['managementKey'])
          const origin = normalizeRemoteOrigin(typeof value['address'] === 'string' ? value['address'] : '')
          assertInsecureHttpConfirmed(origin, value['confirmedInsecureHttpOrigin'])
          const added = await addRemoteProfile({
            profiles: this.#profiles,
            credentials: this.#vault,
            displayName: typeof value['displayName'] === 'string' ? value['displayName'] : '',
            address: origin,
            ...(managementKey === undefined ? {} : { managementKey }),
            deviceLabel: `${app.getName()} · ${process.platform}`,
            clientReleaseId: this.#release.releaseId,
            assertActive: () => this.#mutationLifecycle.assertActive(lifecycle),
          })
          if (!this.#mutationLifecycle.isActive(lifecycle)) return
          if (added.credential !== undefined) this.#memoryCredentials.set(added.profile.id, added.credential)
          this.#profileGenerations.register(added.profile.id)
          this.#statuses.set(added.profile.id, 'connecting')
          await this.switchTo(added.profile.id, false)
        })
      })
      this.#registerOverlayIpc('update', async (value) => {
        await this.#runInstanceMutation(async (lifecycle) => {
          if (!isRecord(value)) throw new Error('实例修改参数无效。')
          if ('origin' in value) throw new Error('已保存服务实例的服务器地址不能修改，请添加新的服务实例。')
          const profileId = requiredString(value['profileId'], '服务实例')
          if (this.#profiles.get(profileId) === undefined) throw new Error('服务实例不存在。')
          this.#profileGenerations.advance(profileId, 'update')
          await this.#profiles.update(profileId, {
            ...(typeof value['displayName'] === 'string' ? { displayName: value['displayName'].trim() } : {}),
            ...(typeof value['notificationsEnabled'] === 'boolean'
              ? { notificationsEnabled: value['notificationsEnabled'] }
              : {}),
          })
          if (!this.#mutationLifecycle.isActive(lifecycle)) return
          if (profileId === this.#currentProfileId && typeof value['displayName'] === 'string') {
            await this.switchTo(profileId, false, true)
          }
          this.#publishPresentationChange()
        })
      })
      this.#registerOverlayIpc('editConnection', async (value) => {
        return this.#runInstanceMutation(async (lifecycle) => {
          if (!isRecord(value)) throw new Error('连接修改参数无效。')
          const profileId = requiredString(value['profileId'], '服务实例')
          const current = this.#profiles.get(profileId)
          if (current === undefined || current.kind !== 'remote') throw new Error('远程服务实例不存在。')
          const managementKey = optionalSecret(value['managementKey'])
          const origin = normalizeRemoteOrigin(typeof value['address'] === 'string' ? value['address'] : '')
          assertInsecureHttpConfirmed(origin, value['confirmedInsecureHttpOrigin'])
          const reconnects = origin !== current.origin || managementKey !== undefined
          if (reconnects && profileId === this.#currentProfileId && !(await this.#confirmDiscardDrafts())) {
            return { saved: false }
          }
          this.#mutationLifecycle.assertActive(lifecycle)
          this.#profileGenerations.advance(profileId, 'update')
          const mutationSerial = --this.#profileMutationSerial
          this.#switchingProfiles.set(profileId, mutationSerial)
          const previousCredential =
            this.#memoryCredentials.get(profileId) ??
            (current.credentialRef === undefined ? undefined : this.#vault.get(current.credentialRef))
          try {
            const edited = await editRemoteProfileConnection({
              profiles: this.#profiles,
              credentials: this.#vault,
              profileId,
              displayName: typeof value['displayName'] === 'string' ? value['displayName'] : '',
              address: origin,
              ...(managementKey === undefined ? {} : { managementKey }),
              deviceLabel: `${app.getName()} · ${process.platform}`,
              clientReleaseId: this.#release.releaseId,
              assertActive: () => this.#mutationLifecycle.assertActive(lifecycle),
            })
            if (!this.#mutationLifecycle.isActive(lifecycle)) return { saved: false }
            if (edited.credential !== undefined) this.#memoryCredentials.set(profileId, edited.credential)
            else if (reconnects) this.#memoryCredentials.delete(profileId)
            if (profileId === this.#currentProfileId) {
              if (reconnects) await this.switchTo(profileId, false, true, true)
              else this.#window.setTitle(`NekroNXT — ${edited.profile.displayName}`)
            }
            this.#publishPresentationChange()
            if (reconnects) {
              this.#runBackgroundAction(
                '清理旧实例连接',
                this.#retireReplacedConnection(current, previousCredential, edited),
              )
            }
            return { saved: true }
          } finally {
            if (this.#switchingProfiles.get(profileId) === mutationSerial) this.#switchingProfiles.delete(profileId)
          }
        })
      })
      this.#registerOverlayIpc('reauthenticate', async (value) => {
        await this.#runInstanceMutation(async (lifecycle) => {
          if (!isRecord(value)) throw new Error('重新认证参数无效。')
          if ('address' in value || 'origin' in value) {
            throw new Error('重新认证不能修改服务器地址，请添加新的服务实例。')
          }
          const profileId = requiredString(value['profileId'], '服务实例')
          const profile = this.#profiles.get(profileId)
          if (profile?.transport === 'explicit-http-v1') {
            assertInsecureHttpConfirmed(profile.origin, value['confirmedInsecureHttpOrigin'])
          }
          this.#profileGenerations.advance(profileId, 'reauthenticate')
          const mutationSerial = --this.#profileMutationSerial
          this.#switchingProfiles.set(profileId, mutationSerial)
          const managementKey = optionalSecret(value['managementKey'])
          try {
            const authenticated = await reauthenticateRemoteProfile({
              profiles: this.#profiles,
              credentials: this.#vault,
              profileId,
              ...(managementKey === undefined ? {} : { managementKey }),
              deviceLabel: `${app.getName()} · ${process.platform}`,
              clientReleaseId: this.#release.releaseId,
              assertActive: () => this.#mutationLifecycle.assertActive(lifecycle),
            })
            if (!this.#mutationLifecycle.isActive(lifecycle)) return
            if (authenticated.credential !== undefined) {
              this.#memoryCredentials.set(authenticated.profile.id, authenticated.credential)
            }
            await this.switchTo(authenticated.profile.id, false, true)
          } finally {
            if (this.#switchingProfiles.get(profileId) === mutationSerial) this.#switchingProfiles.delete(profileId)
          }
        })
      })
      this.#registerOverlayIpc('remove', async (value) => {
        await this.#runInstanceMutation(async (lifecycle) => {
          const profileId = requiredString(isRecord(value) ? value['profileId'] : undefined, '服务实例')
          const profile = this.#profiles.get(profileId)
          if (profile === undefined || profile.kind !== 'remote') throw new Error('远程服务实例不存在。')
          if (profile.id === this.#currentProfileId) {
            if (!(await this.#confirmDiscardDrafts())) return
            this.#mutationLifecycle.assertActive(lifecycle)
            await this.switchTo('local', true, false, true)
            this.#mutationLifecycle.assertActive(lifecycle)
          }
          this.#profileGenerations.advance(profile.id, 'remove')
          const profileSession = session.fromPartition(profile.partition)
          await this.#tryRevokeDevice(profile, profileSession)
          this.#mutationLifecycle.assertActive(lifecycle)
          await profileSession.clearStorageData()
          await profileSession.closeAllConnections()
          if (profile.credentialRef !== undefined) await this.#vault.remove(profile.credentialRef)
          this.#memoryCredentials.delete(profile.id)
          this.#notificationCursors.delete(profile.id)
          this.#observedRemoteAvailability.delete(profile.id)
          await this.#profiles.remove(profile.id)
          this.#statuses.delete(profile.id)
          this.#profileGenerations.remove(profile.id)
          this.#publishPresentationChange()
        })
      })
    })
  }

  #runInstanceMutation<T>(operation: (lifecycle: ManagerMutationToken) => Promise<T>): Promise<T> {
    return runManagerMutation(this.#instanceMutations, this.#mutationLifecycle, operation)
  }

  #registerOverlayIpc(action: string, operation: (value: unknown) => unknown): void {
    const channel = `nxt:instances:${action}`
    this.#ipcRegistrations.registerHandle(channel, async (event, value: unknown) => {
      this.#assertOverlaySender(event)
      try {
        return trustedInstanceSuccess(await operation(value))
      } catch (cause) {
        console.error(`[nekro-nxt] Desktop 实例操作失败（${channel}）：`, cause)
        return trustedInstanceFailure(cause)
      }
    })
  }

  #assertProductSender(senderId: number): void {
    if (senderId !== this.#productView?.webContents.id) throw new Error('Product View 无权访问该 Desktop Shell 操作。')
  }

  #assertOverlaySender(event: TrustedOverlayIpcEvent): void {
    assertTrustedOverlayIpcEvent(event, this.#overlayView?.webContents.id, this.#overlayTrustedUrl)
  }

  #snapshot(): InstanceSnapshot {
    return {
      revision: this.#snapshotRevision.revision,
      currentProfileId: this.#currentProfileId,
      profiles: this.#profiles.list().map((profile) => ({
        id: profile.id,
        kind: profile.kind,
        displayName: profile.displayName,
        origin: profile.origin,
        addressLabel:
          profile.kind === 'local'
            ? '此设备'
            : new URL(profile.origin).protocol === 'http:'
              ? `http://${new URL(profile.origin).host}`
              : new URL(profile.origin).host,
        status: this.#statuses.get(profile.id) ?? 'offline',
        notificationsEnabled: profile.notificationsEnabled,
        requiresAuthentication: profile.kind === 'remote' && profile.transport !== 'loopback-http',
        insecureHttp: profile.kind === 'remote' && profile.transport === 'explicit-http-v1',
      })),
    }
  }

  #currentPresentation(): CurrentInstancePresentation {
    const profile = this.#profiles.get(this.#currentProfileId) ?? this.#profiles.get('local')!
    return {
      revision: this.#snapshotRevision.revision,
      displayName: profile.displayName,
      status: this.#statuses.get(profile.id) ?? 'offline',
    }
  }

  #publishPresentationChange(): void {
    if (this.#disposed) return
    const snapshotWithoutRevision = {
      currentProfileId: this.#currentProfileId,
      profiles: this.#snapshot().profiles,
    }
    if (this.#snapshotRevision.commit(snapshotWithoutRevision) === undefined) return
    const snapshot = this.#snapshot()
    if (!this.#overlayView?.webContents.isDestroyed()) {
      this.#overlayView?.webContents.send('nxt:instances:changed', snapshot)
    }
    const currentPresentation = this.#currentPresentation()
    const currentSignature = JSON.stringify({
      profileId: this.#currentProfileId,
      displayName: currentPresentation.displayName,
      status: currentPresentation.status,
    })
    if (currentSignature !== this.#lastCurrentPresentationSignature) {
      this.#lastCurrentPresentationSignature = currentSignature
      if (!this.#productView?.webContents.isDestroyed()) {
        this.#productView?.webContents.send('nxt:shell:current-changed', currentPresentation)
      }
    }
  }

  #layout(): void {
    if (this.#disposed || this.#window.isDestroyed()) return
    const size = this.#window.getContentSize()
    const width = size[0] ?? 0
    const height = size[1] ?? 0
    const bounds = desktopViewBounds(width, height)
    this.#productView?.setBounds(bounds.product)
    this.#fallbackView?.setBounds(bounds.fallback)
    if (this.#overlayOpen && this.#overlayView !== undefined) {
      this.#overlayView.setBounds(bounds.overlay)
    }
  }

  #configureSession(profile: InstanceProfile, profileSession: Session): void {
    profileSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    profileSession.setPermissionCheckHandler(() => false)
    if (profile.kind === 'local') {
      profileSession.setCertificateVerifyProc(null)
      return
    }
    if (new URL(profile.origin).protocol === 'http:') profileSession.setCertificateVerifyProc(null)
    else {
      profileSession.setCertificateVerifyProc((request, callback) => {
        try {
          const sameHost = request.hostname === new URL(profile.origin).hostname
          callback(sameHost && certificateSpki(request.certificate.data) === profile.pinnedSpkiSha256 ? 0 : -2)
        } catch {
          callback(-2)
        }
      })
    }
    if (profile.transport === 'loopback-http') return
    profileSession.webRequest.onBeforeSendHeaders({ urls: [`${profile.origin}/*`] }, (details, callback) => {
      if (details.method === 'GET' || details.method === 'HEAD' || details.method === 'OPTIONS') {
        callback({ requestHeaders: details.requestHeaders })
        return
      }
      void profileSession.cookies
        .get({ url: profile.origin, name: 'nxt_csrf' })
        .then((cookies) => {
          const csrfToken = cookies[0]?.value
          callback({
            requestHeaders: {
              ...details.requestHeaders,
              Origin: profile.origin,
              ...(csrfToken === undefined ? {} : { 'X-Nxt-Csrf': csrfToken }),
            },
          })
        })
        .catch(() => callback({ requestHeaders: details.requestHeaders }))
    })
  }

  async #establishRemoteSession(
    profile: InstanceProfile,
    profileSession: Session,
    signal?: AbortSignal,
  ): Promise<void> {
    const credential =
      this.#memoryCredentials.get(profile.id) ??
      (profile.credentialRef ? this.#vault.get(profile.credentialRef) : undefined)
    await establishRemoteSession({
      profile,
      fetcher: profileSession.fetch.bind(profileSession),
      ...(credential === undefined ? {} : { credential }),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  #createProductView(profile: InstanceProfile): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: profile.partition,
        preload: productPreload(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    view.setBackgroundColor(this.#surfaceTheme === 'dark' ? '#0F1A2C' : '#F5F2EE')
    installF12DevToolsShortcut(view.webContents)
    view.webContents.on('dom-ready', () => {
      if (view.webContents.isDestroyed()) return
      void view.webContents.insertCSS(desktopTitleBarCss(process.platform)).catch((error: unknown) => {
        if (!this.#disposed && !view.webContents.isDestroyed()) {
          console.error('[nekro-nxt] Desktop 标题栏样式注入失败：', error)
        }
      })
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    installSameOriginNavigationGuard(view.webContents, profile.origin, (target) => {
      if (isAllowedExternalUrl(target)) void shell.openExternal(target)
    })
    const rememberRoute = (_event: Electron.Event, target: string): void => {
      const route = savedRoute(profile, target)
      if (route !== undefined) {
        this.#runBackgroundAction('保存实例路由', this.#profiles.update(profile.id, { lastRoute: route }))
      }
    }
    view.webContents.on('did-navigate', rememberRoute)
    view.webContents.on('did-navigate-in-page', rememberRoute)
    view.webContents.on('render-process-gone', () => {
      if (this.#productView !== view) return
      if (profile.kind === 'remote') {
        this.#profileGenerations.advance(profile.id, 'switch')
        this.#statuses.set(profile.id, 'offline')
        this.#publishPresentationChange()
      }
      void this.#showFallback(profile, '实例页面已经停止', '重新连接可恢复已保存的数据。', [
        ...(profile.kind === 'remote' ? ([{ label: '返回本地实例', href: 'nxt-desktop://local' }] as const) : []),
        { label: '重新连接', href: 'nxt-desktop://retry' },
        { label: '管理服务实例', href: 'nxt-desktop://instances' },
      ])
    })
    return view
  }

  #destroyProductView(): void {
    const view = this.#productView
    this.#productView = undefined
    if (view === undefined) return
    detachAndCloseView(this.#window, view)
  }

  async #readProductTheme(): Promise<'light' | 'dark' | undefined> {
    const view = this.#productView
    if (view === undefined || view.webContents.isDestroyed()) return undefined
    try {
      const theme: unknown = await view.webContents.executeJavaScript('document.documentElement.dataset.theme', true)
      return theme === 'light' || theme === 'dark' ? theme : undefined
    } catch {
      return undefined
    }
  }

  async #confirmDiscardDrafts(): Promise<boolean> {
    const view = this.#productView
    if (view === undefined || view.webContents.isDestroyed()) return true
    let dirty = false
    try {
      const result: unknown = await view.webContents.executeJavaScript(
        'Boolean(globalThis.__nxtHasUnsavedDrafts?.())',
        true,
      )
      dirty = result === true
    } catch {
      return true
    }
    if (!dirty) return true
    const result = await dialog.showMessageBox(this.#window, {
      type: 'warning',
      title: '切换服务实例？',
      message: '当前页面有未保存的更改。',
      detail: '切换后这些更改会丢失。',
      buttons: ['留在当前实例', '放弃更改并切换'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    return result.response === 1
  }

  #showFallback(
    profile: InstanceProfile,
    title: string,
    body: string,
    actions: readonly TrustedFallbackAction[],
  ): Promise<void> {
    if (this.#fallbackCloseTimer !== undefined) clearTimeout(this.#fallbackCloseTimer)
    this.#fallbackCloseTimer = undefined
    const fallbackUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
      renderTrustedFallbackHtml({
        title,
        body,
        actions,
        platform: process.platform,
        theme: this.#surfaceTheme,
        instance: {
          displayName: profile.displayName,
          addressLabel:
            profile.kind === 'local'
              ? '此设备'
              : new URL(profile.origin).protocol === 'http:'
                ? `http://${new URL(profile.origin).host}`
                : new URL(profile.origin).host,
          status: this.#statuses.get(profile.id) ?? 'offline',
        },
      }),
    )}`
    const binding: FallbackLoadBinding = { url: fallbackUrl, profileId: profile.id, actions: new Map() }
    const load = this.#fallbackLoads.begin(binding)
    binding.actions = new Map([
      [
        'nxt-desktop://retry',
        () => this.#runFallbackLoadAction(load, (profileId) => this.switchTo(profileId, false, true)),
      ],
      ['nxt-desktop://local', () => this.#runFallbackLoadAction(load, () => this.switchTo('local', true, false, true))],
      [
        'nxt-desktop://instances',
        () => this.#runFallbackLoadAction(load, () => this.openOverlay('fallback-instances', { kind: 'list' })),
      ],
      [
        'nxt-desktop://reauthenticate',
        () =>
          this.#runFallbackLoadAction(load, (profileId) =>
            this.openOverlay('fallback-reauthenticate', {
              kind: 'reauthenticate',
              profileId,
            }),
          ),
      ],
    ])
    let view = this.#fallbackView
    if (view === undefined) {
      view = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
      installF12DevToolsShortcut(view.webContents)
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      installExactTrustedNavigationGuard(
        view.webContents,
        () => this.#fallbackLoads.current?.value.url,
        () => this.#fallbackLoads.current?.value.actions ?? new Map(),
      )
      this.#fallbackView = view
    }
    view.setBackgroundColor(this.#surfaceTheme === 'dark' ? '#0F1A2C' : '#F5F2EE')
    if (!this.#window.contentView.children.includes(view)) this.#window.contentView.addChildView(view)
    this.#bringFallbackToFront()
    this.#bringOverlayToFront()
    this.#layout()
    return view.webContents
      .loadURL(fallbackUrl)
      .then(() => {
        if (this.#fallbackLoads.isCurrent(load)) assertExactTrustedUrl(view.webContents.getURL(), fallbackUrl)
      })
      .catch((error: unknown) => {
        if (!this.#fallbackLoads.isCurrent(load)) return
        if (!this.#disposed && !view.webContents.isDestroyed()) {
          console.error('[nekro-nxt] Desktop 连接状态页加载失败：', error)
        }
        if (this.#fallbackView === view) {
          detachAndCloseView(this.#window, view)
          this.#fallbackView = undefined
        }
      })
  }

  #hideFallback(): void {
    const view = this.#fallbackView
    if (view === undefined || !this.#window.contentView.children.includes(view)) return
    if (this.#fallbackCloseTimer !== undefined) clearTimeout(this.#fallbackCloseTimer)
    if (!view.webContents.isDestroyed()) {
      void view.webContents
        .executeJavaScript("document.documentElement.dataset.visibility = 'closing'", true)
        .catch(() => undefined)
    }
    this.#fallbackCloseTimer = setTimeout(() => {
      this.#fallbackCloseTimer = undefined
      if (
        this.#disposed ||
        this.#fallbackView !== view ||
        this.#window.isDestroyed() ||
        !this.#window.contentView.children.includes(view)
      ) {
        return
      }
      this.#window.contentView.removeChildView(view)
    }, FALLBACK_EXIT_MS)
  }

  #bringFallbackToFront(): void {
    const fallback = this.#fallbackView
    if (fallback === undefined || this.#window.isDestroyed() || !this.#window.contentView.children.includes(fallback)) {
      return
    }
    bringChildViewToFront(this.#window.contentView, fallback)
  }

  #bringOverlayToFront(): void {
    const overlay = this.#overlayView
    if (
      !this.#overlayOpen ||
      overlay === undefined ||
      this.#window.isDestroyed() ||
      !this.#window.contentView.children.includes(overlay)
    ) {
      return
    }
    bringChildViewToFront(this.#window.contentView, overlay)
  }

  #sendOverlayVisibility(visibility: OverlayVisibility): void {
    const view = this.#overlayView
    if (view === undefined || view.webContents.isDestroyed()) return
    view.webContents.send('nxt:instances:visibility', visibility)
  }

  #restoreOverlayAfterLoad(view: WebContentsView): void {
    if (this.#overlayView !== view || view.webContents.isDestroyed()) return
    const actualUrl = view.webContents.getURL()
    const decision = this.#overlayLoadGate.decide({
      open: this.#overlayOpen,
      actualUrl,
      expectedUrl: this.#overlayTrustedUrl,
    })
    if (decision === 'untrusted') {
      console.error(`[nekro-nxt] Desktop 实例 Sheet 已离开可信页面：${actualUrl}`)
      this.#discardFailedOverlay(view)
      return
    }
    assertExactTrustedUrl(actualUrl, this.#overlayTrustedUrl)
    if (decision === 'send-open') {
      void this.#applyOverlayTheme(view).then(() => {
        if (this.#overlayView === view && this.#overlayOpen && !view.webContents.isDestroyed()) {
          this.#sendOverlayVisibility({ state: 'open', intent: this.#overlayIntent })
        }
      })
    }
  }

  async #applyOverlayTheme(view: WebContentsView): Promise<void> {
    if (view.webContents.isDestroyed()) return
    await view.webContents
      .executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(this.#surfaceTheme)}`, true)
      .catch(() => undefined)
  }

  #discardFailedOverlay(view: WebContentsView): void {
    if (this.#overlayView !== view) return
    this.#overlayOpen = false
    this.#overlayView = undefined
    for (const resolve of this.#overlayWaiters) resolve()
    this.#overlayWaiters.clear()
    detachAndCloseView(this.#window, view)
    this.#restoreOverlayFocus(this.#overlayOpeningSource, false)
    this.#overlayOpeningSource = undefined
  }

  #runFallbackLoadAction(
    load: TrustedLoadToken<FallbackLoadBinding>,
    action: (profileId: string) => Promise<unknown>,
  ): void {
    runLatestTrustedLoadAction(this.#fallbackLoads, load, (binding) => {
      this.#runBackgroundAction('恢复操作', action(binding.profileId))
    })
  }

  #runBackgroundAction(label: string, action: Promise<unknown>): void {
    void action.catch((error: unknown) => {
      if (!this.#disposed) console.error(`[nekro-nxt] Desktop ${label}失败：`, error)
    })
  }

  #restoreOverlayFocus(source: OverlayOpeningSource | undefined, restoreControl: boolean): void {
    const view = source?.startsWith('fallback-') === true ? this.#fallbackView : this.#productView
    if (view === undefined || view.webContents.isDestroyed()) return
    view.webContents.focus()
    if (!restoreControl) return
    const selector =
      source === 'fallback-instances'
        ? '[data-instance-sheet-trigger="instances"]'
        : source === 'fallback-reauthenticate'
          ? '[data-instance-sheet-trigger="reauthenticate"]'
          : '[data-desktop-instance-switcher]'
    void view.webContents
      .executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.focus()`, true)
      .catch(() => undefined)
  }

  async #tryRevokeDevice(profile: InstanceProfile, profileSession: Session): Promise<void> {
    const credential =
      this.#memoryCredentials.get(profile.id) ??
      (profile.credentialRef ? this.#vault.get(profile.credentialRef) : undefined)
    if (credential === undefined) return
    this.#configureSession(profile, profileSession)
    await tryRevokeRemoteDevice({
      profile,
      fetcher: profileSession.fetch.bind(profileSession),
      credential,
    })
  }

  async #retireReplacedConnection(
    previous: InstanceProfile,
    previousCredential: ReturnType<CredentialVault['get']>,
    edited: RemoteProfileConnectionEditResult,
  ): Promise<void> {
    const revokeSession = session.fromPartition(`nxt-retire-${previous.id}-${++this.#retirementSerial}`)
    if (previousCredential !== undefined) {
      this.#configureSession(previous, revokeSession)
      await tryRevokeRemoteDevice({
        profile: previous,
        fetcher: revokeSession.fetch.bind(revokeSession),
        credential: previousCredential,
      })
    }
    await revokeSession.clearStorageData().catch(() => undefined)
    await revokeSession.closeAllConnections().catch(() => undefined)
    if (edited.replaced?.partition !== undefined) {
      const previousSession = session.fromPartition(edited.replaced.partition)
      try {
        await previousSession.clearStorageData()
        await previousSession.closeAllConnections()
      } catch (error) {
        console.warn('[nekro-nxt] Desktop 旧实例分区清理失败：', error)
      }
    }
    if (edited.replaced?.credentialRef !== undefined) {
      try {
        await this.#vault.remove(edited.replaced.credentialRef)
      } catch (error) {
        console.warn('[nekro-nxt] Desktop 旧设备凭据清理失败：', error)
      }
    }
  }

  #monitorTargets(): readonly ProfileMonitorTarget[] {
    return this.#profiles
      .list()
      .filter((profile) => !this.#switchingProfiles.has(profile.id))
      .map((profile) => ({
        id: profile.id,
        kind: profile.kind,
        generation: this.#profileGenerations.current(profile.id),
        notificationsEnabled: profile.notificationsEnabled,
        status: this.#statuses.get(profile.id) ?? 'offline',
      }))
  }

  #isCurrentMonitorTarget(target: ProfileMonitorTarget): boolean {
    const profile = this.#profiles.get(target.id)
    return (
      !this.#disposed &&
      profile?.kind === target.kind &&
      !this.#switchingProfiles.has(target.id) &&
      this.#profileGenerations.isCurrent({ profileId: target.id, generation: target.generation })
    )
  }

  async #probeRemoteProfile(target: ProfileMonitorTarget, signal: AbortSignal): Promise<InstanceStatus> {
    const profile = this.#profiles.get(target.id)
    if (profile?.kind !== 'remote') throw new Error('远程服务实例不存在。')
    const profileSession = session.fromPartition(profile.partition)
    this.#configureSession(profile, profileSession)
    const credential =
      this.#memoryCredentials.get(profile.id) ??
      (profile.credentialRef ? this.#vault.get(profile.credentialRef) : undefined)
    return probeRemoteSession({
      profile,
      fetcher: profileSession.fetch.bind(profileSession),
      ...(credential === undefined ? {} : { credential }),
      signal,
    })
  }

  #commitRemoteMonitorStatus(target: ProfileMonitorTarget, status: InstanceStatus): void {
    if (!this.#isCurrentMonitorTarget(target)) return
    const previousStatus = this.#statuses.get(target.id)
    const available = status === 'ready'
    const previousAvailable = this.#observedRemoteAvailability.get(target.id)
    this.#observedRemoteAvailability.set(target.id, available)
    if (previousStatus !== status) {
      this.#statuses.set(target.id, status)
      this.#publishPresentationChange()
    }
    if (previousAvailable === undefined || previousAvailable === available || !Notification.isSupported()) return
    const profile = this.#profiles.get(target.id)
    if (profile === undefined) return
    const notice = new Notification({
      title: `NekroNXT · ${profile.displayName}`,
      body: available ? '服务实例已经恢复连接。' : '服务实例持续无法连接。',
    })
    notice.on('click', () => {
      this.#window.show()
      this.#window.focus()
      this.#runBackgroundAction('通知实例切换', this.switchTo(profile.id))
    })
    notice.show()
  }

  async #readNotifications(target: ProfileMonitorTarget, signal: AbortSignal): Promise<ClientNotificationFeed> {
    const profile = this.#profiles.get(target.id)
    if (profile === undefined) throw new Error('服务实例不存在。')
    const profileSession = session.fromPartition(profile.partition)
    this.#configureSession(profile, profileSession)
    const cursor = this.#notificationCursors.get(profile.id)
    const response = await fetchSameOriginRemote(
      profileSession.fetch.bind(profileSession),
      profile.origin,
      `/api/client-notifications${cursor === undefined ? '' : `?cursor=${cursor}`}`,
      { credentials: 'include', signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) },
    )
    if (!response.ok) throw new Error(`系统通知请求失败（HTTP ${response.status}）。`)
    return ClientNotificationFeedResponseSchema.parse(await response.json())
  }

  #commitNotifications(target: ProfileMonitorTarget, feed: ClientNotificationFeed): void {
    if (!this.#isCurrentMonitorTarget(target)) return
    const profile = this.#profiles.get(target.id)
    if (profile === undefined) return
    this.#notificationCursors.set(profile.id, feed.cursor)
    for (const item of feed.notifications) {
      if (!Notification.isSupported()) continue
      const notice = new Notification({
        title: `NekroNXT · ${profile.displayName} · ${item.title}`,
        body: item.body,
      })
      notice.on('click', () => {
        this.#window.show()
        this.#window.focus()
        this.#runBackgroundAction('通知路由打开', this.#openProfileRoute(profile.id, item.route ?? '/work'))
      })
      notice.show()
    }
  }

  #handleNotificationError(target: ProfileMonitorTarget, cause: unknown): void {
    this.#notificationCursors.delete(target.id)
    console.warn(`[nekro-nxt] Desktop 系统通知读取失败（${target.id}），实例健康状态保持不变：`, cause)
  }

  async #openProfileRoute(profileId: string, route: string): Promise<void> {
    await this.#profiles.update(profileId, { lastRoute: route })
    await this.switchTo(profileId, true, true)
  }
}
