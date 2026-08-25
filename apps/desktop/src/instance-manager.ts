import {
  BrowserWindow,
  Notification,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  session,
  shell,
  type Session,
} from 'electron'
import { ClientNotificationFeedResponseSchema } from '@nekro-nxt/contracts'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CredentialVault, type DeviceCredential } from './credential-vault.js'
import { InstanceOperationError, trustedInstanceFailure, trustedInstanceSuccess } from './instance-operation-error.js'
import {
  InstanceProfileStore,
  assertInsecureHttpConfirmed,
  normalizeRemoteOrigin,
  remoteTransportForOrigin,
  type InstanceProfile,
  type InstanceStatus,
} from './instance-profiles.js'
import {
  assertSameOriginRemoteUrl,
  fetchSameOriginRemote,
  installSameOriginNavigationGuard,
} from './remote-navigation.js'
import { addRemoteProfile, reauthenticateRemoteProfile } from './remote-profile-enrollment.js'
import { certificateSpki, observeRemoteSpki, parseRemoteDescriptor } from './remote-pairing.js'
import { SerialTaskQueue } from './serial-task-queue.js'
import { renderTrustedFallbackHtml, trustedFallbackForError, type TrustedFallbackAction } from './trusted-fallback.js'
import { isAllowedExternalUrl, type ProductRelease } from './distribution.js'
import { desktopTitleBarCss, desktopWindowChrome } from './window-chrome.js'
import { detachAndCloseView } from './view-lifecycle.js'

const OVERLAY_WIDTH = 344
const OVERLAY_MAX_HEIGHT = 480
const OVERLAY_RAIL_OFFSET = 64
const OVERLAY_MARGIN = 12
const OVERLAY_EXIT_MS = 100

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
  readonly currentProfileId: string
  readonly profiles: readonly ProfilePresentation[]
}

const rendererAsset = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url))
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
  readonly #memoryCredentials = new Map<string, DeviceCredential>()
  readonly #notificationCursors = new Map<string, number>()
  readonly #overlayWaiters = new Set<() => void>()
  readonly #instanceMutations = new SerialTaskQueue()
  #productView: WebContentsView | undefined
  #overlayView: WebContentsView | undefined
  #fallbackView: WebContentsView | undefined
  #currentProfileId: string
  #overlayOpen = false
  #overlayCloseTimer: ReturnType<typeof setTimeout> | undefined
  #switchSerial = 0
  #notificationTimer: ReturnType<typeof setInterval> | undefined
  #disposed = false

  private constructor(input: {
    window: BrowserWindow
    release: ProductRelease
    profiles: InstanceProfileStore
    vault: CredentialVault
  }) {
    this.#window = input.window
    this.#release = input.release
    this.#profiles = input.profiles
    this.#vault = input.vault
    this.#currentProfileId = input.profiles.selectedProfileId
    for (const profile of input.profiles.list())
      this.#statuses.set(profile.id, profile.kind === 'local' ? 'ready' : 'connecting')
  }

  static async create(input: {
    readonly localOrigin: string
    readonly release: ProductRelease
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
      backgroundColor: '#172A45',
      ...desktopWindowChrome(process.platform),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    const manager = new DesktopInstanceManager({ window, release: input.release, profiles, vault })
    manager.#registerIpc()
    manager.#window.on('resize', () => manager.#layout())
    manager.#window.on('close', () => manager.dispose())
    await manager.switchTo(profiles.selectedProfileId, false)
    manager.#window.show()
    manager.#startNotificationMonitor()
    return manager
  }

  get window(): BrowserWindow {
    return this.#window
  }

  async switchTo(profileId: string, persist = true, force = false, skipDraftConfirm = false): Promise<void> {
    if (this.#disposed) throw new Error('Desktop 实例管理器已经停止。')
    const profile = this.#profiles.get(profileId)
    if (profile === undefined) throw new Error('服务实例不存在。')
    if (!force && profileId === this.#currentProfileId && this.#productView !== undefined) return
    if (!skipDraftConfirm && profileId !== this.#currentProfileId && !(await this.#confirmDiscardDrafts())) return
    const serial = ++this.#switchSerial
    this.closeOverlay()
    this.#statuses.set(profile.id, 'connecting')
    this.#currentProfileId = profile.id
    if (persist) await this.#profiles.select(profile.id)
    this.#destroyProductView()
    this.#showFallback(`正在连接「${profile.displayName}」`, '正在读取该实例的工作区…', [])
    this.#emitSnapshot()
    this.#window.setTitle(`NekroNXT — ${profile.displayName}`)
    try {
      const partitionSession = session.fromPartition(profile.partition)
      this.#configureSession(profile, partitionSession)
      if (profile.kind === 'remote') await this.#establishRemoteSession(profile, partitionSession)
      if (serial !== this.#switchSerial) return
      const view = this.#createProductView(profile)
      this.#productView = view
      this.#window.contentView.addChildView(view)
      this.#layout()
      await view.webContents.loadURL(routeWithDesktop(profile))
      assertSameOriginRemoteUrl(profile.origin, view.webContents.getURL())
      if (serial !== this.#switchSerial) return
      this.#statuses.set(profile.id, 'ready')
      this.#hideFallback()
      this.#emitSnapshot()
    } catch (error) {
      if (serial !== this.#switchSerial) return
      this.#destroyProductView()
      console.error(`[nekro-nxt] Desktop 实例连接失败（${profile.id} · ${profile.origin}）：`, error)
      const fallback = trustedFallbackForError(error, {
        canReauthenticate: profile.kind === 'remote' && profile.transport !== 'loopback-http',
      })
      this.#statuses.set(profile.id, fallback.status)
      this.#showFallback(`无法连接「${profile.displayName}」`, fallback.body, fallback.actions)
      this.#emitSnapshot()
    }
  }

  openOverlay(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error('Desktop 实例管理器已经停止。'))
    if (!this.#overlayOpen) {
      this.#overlayOpen = true
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
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        void view.webContents
          .loadFile(rendererAsset('instance-overlay.html'))
          .then(() => {
            if (this.#overlayOpen && this.#overlayView === view && !view.webContents.isDestroyed()) {
              view.webContents.send('nxt:instances:visibility', 'open')
              this.#emitSnapshot()
            }
          })
          .catch((error: unknown) => {
            if (!this.#disposed && !view.webContents.isDestroyed()) {
              console.error('[nekro-nxt] Desktop 实例浮层加载失败：', error)
            }
          })
        this.#overlayView = view
      }
      if (!this.#window.contentView.children.includes(this.#overlayView)) {
        this.#window.contentView.addChildView(this.#overlayView)
      }
      this.#layout()
      if (!this.#overlayView.webContents.isLoading()) {
        this.#overlayView.webContents.send('nxt:instances:visibility', 'open')
      }
      this.#overlayView.webContents.focus()
      this.#emitSnapshot()
    }
    return new Promise((resolve) => this.#overlayWaiters.add(resolve))
  }

  closeOverlay(immediate = false): void {
    if (!this.#overlayOpen) return
    this.#overlayOpen = false
    for (const resolve of this.#overlayWaiters) resolve()
    this.#overlayWaiters.clear()
    const view = this.#overlayView
    if (view !== undefined && !view.webContents.isDestroyed()) {
      view.webContents.send('nxt:instances:visibility', 'closing')
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
      if (!this.#disposed && !this.#productView?.webContents.isDestroyed()) this.#productView?.webContents.focus()
    }
    if (this.#overlayCloseTimer !== undefined) clearTimeout(this.#overlayCloseTimer)
    if (immediate) detach()
    else this.#overlayCloseTimer = setTimeout(detach, OVERLAY_EXIT_MS)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#switchSerial += 1
    if (this.#notificationTimer !== undefined) clearInterval(this.#notificationTimer)
    this.#notificationTimer = undefined
    if (this.#overlayCloseTimer !== undefined) clearTimeout(this.#overlayCloseTimer)
    this.#overlayCloseTimer = undefined
    this.closeOverlay(true)
    this.#destroyProductView()
    detachAndCloseView(this.#window, this.#fallbackView)
    this.#fallbackView = undefined
    detachAndCloseView(this.#window, this.#overlayView)
    this.#overlayView = undefined
  }

  #registerIpc(): void {
    ipcMain.handle('nxt:shell:current', (event) => {
      this.#assertProductSender(event.sender.id)
      return this.#currentPresentation()
    })
    ipcMain.handle('nxt:shell:open-switcher', (event) => {
      this.#assertProductSender(event.sender.id)
      return this.openOverlay()
    })
    ipcMain.handle('nxt:shell:close-switcher', (event) => {
      this.#assertProductSender(event.sender.id)
      this.closeOverlay()
    })
    ipcMain.on('nxt:shell:content-pointer', (event) => {
      if (event.sender.id === this.#productView?.webContents.id) this.closeOverlay()
    })
    this.#registerOverlayIpc('list', () => this.#snapshot())
    this.#registerOverlayIpc('close', () => this.closeOverlay())
    this.#registerOverlayIpc('switch', async (value) => {
      await this.#instanceMutations.run(() =>
        this.switchTo(requiredString(isRecord(value) ? value['profileId'] : undefined, '服务实例')),
      )
    })
    this.#registerOverlayIpc('retry', async (value) => {
      await this.#instanceMutations.run(() =>
        this.switchTo(requiredString(isRecord(value) ? value['profileId'] : undefined, '服务实例'), true, true),
      )
    })
    this.#registerOverlayIpc('add', async (value) => {
      await this.#instanceMutations.run(async () => {
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
        })
        if (added.credential !== undefined) this.#memoryCredentials.set(added.profile.id, added.credential)
        this.#statuses.set(added.profile.id, 'connecting')
        await this.switchTo(added.profile.id, false)
      })
    })
    this.#registerOverlayIpc('update', async (value) => {
      await this.#instanceMutations.run(async () => {
        if (!isRecord(value)) throw new Error('实例修改参数无效。')
        if ('origin' in value) throw new Error('已保存服务实例的服务器地址不能修改，请添加新的服务实例。')
        const profileId = requiredString(value['profileId'], '服务实例')
        if (this.#profiles.get(profileId) === undefined) throw new Error('服务实例不存在。')
        await this.#profiles.update(profileId, {
          ...(typeof value['displayName'] === 'string' ? { displayName: value['displayName'].trim() } : {}),
          ...(typeof value['notificationsEnabled'] === 'boolean'
            ? { notificationsEnabled: value['notificationsEnabled'] }
            : {}),
        })
        if (profileId === this.#currentProfileId && typeof value['displayName'] === 'string') {
          await this.switchTo(profileId, false, true)
        }
        this.#emitSnapshot()
      })
    })
    this.#registerOverlayIpc('reauthenticate', async (value) => {
      await this.#instanceMutations.run(async () => {
        if (!isRecord(value)) throw new Error('重新认证参数无效。')
        if ('address' in value || 'origin' in value) {
          throw new Error('重新认证不能修改服务器地址，请添加新的服务实例。')
        }
        const profileId = requiredString(value['profileId'], '服务实例')
        const profile = this.#profiles.get(profileId)
        if (profile?.transport === 'explicit-http-v1') {
          assertInsecureHttpConfirmed(profile.origin, value['confirmedInsecureHttpOrigin'])
        }
        const managementKey = optionalSecret(value['managementKey'])
        const authenticated = await reauthenticateRemoteProfile({
          profiles: this.#profiles,
          credentials: this.#vault,
          profileId,
          ...(managementKey === undefined ? {} : { managementKey }),
          deviceLabel: `${app.getName()} · ${process.platform}`,
          clientReleaseId: this.#release.releaseId,
        })
        if (authenticated.credential !== undefined) {
          this.#memoryCredentials.set(authenticated.profile.id, authenticated.credential)
        }
        await this.switchTo(authenticated.profile.id, false, true)
      })
    })
    this.#registerOverlayIpc('remove', async (value) => {
      await this.#instanceMutations.run(async () => {
        const profileId = requiredString(isRecord(value) ? value['profileId'] : undefined, '服务实例')
        const profile = this.#profiles.get(profileId)
        if (profile === undefined || profile.kind !== 'remote') throw new Error('远程服务实例不存在。')
        if (profile.id === this.#currentProfileId) {
          if (!(await this.#confirmDiscardDrafts())) return
          await this.switchTo('local', true, false, true)
        }
        const profileSession = session.fromPartition(profile.partition)
        await this.#tryRevokeDevice(profile, profileSession)
        await profileSession.clearStorageData()
        await profileSession.closeAllConnections()
        if (profile.credentialRef !== undefined) await this.#vault.remove(profile.credentialRef)
        this.#memoryCredentials.delete(profile.id)
        this.#notificationCursors.delete(profile.id)
        await this.#profiles.remove(profile.id)
        this.#statuses.delete(profile.id)
        this.#emitSnapshot()
      })
    })
  }

  #registerOverlayIpc(action: string, operation: (value: unknown) => unknown): void {
    const channel = `nxt:instances:${action}`
    ipcMain.handle(channel, async (event, value: unknown) => {
      this.#assertOverlaySender(event.sender.id)
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

  #assertOverlaySender(senderId: number): void {
    if (senderId !== this.#overlayView?.webContents.id) throw new Error('只有可信实例浮层可以执行该操作。')
  }

  #snapshot(): InstanceSnapshot {
    return {
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

  #currentPresentation(): { readonly displayName: string; readonly status: InstanceStatus } {
    const profile = this.#profiles.get(this.#currentProfileId) ?? this.#profiles.get('local')!
    return { displayName: profile.displayName, status: this.#statuses.get(profile.id) ?? 'offline' }
  }

  #emitSnapshot(): void {
    if (this.#disposed) return
    const snapshot = this.#snapshot()
    if (!this.#overlayView?.webContents.isDestroyed()) {
      this.#overlayView?.webContents.send('nxt:instances:changed', snapshot)
    }
    if (!this.#productView?.webContents.isDestroyed()) {
      this.#productView?.webContents.send('nxt:shell:current-changed', this.#currentPresentation())
    }
  }

  #layout(): void {
    if (this.#disposed || this.#window.isDestroyed()) return
    const size = this.#window.getContentSize()
    const width = size[0] ?? 0
    const height = size[1] ?? 0
    const fullBounds = { x: 0, y: 0, width, height }
    this.#productView?.setBounds(fullBounds)
    this.#fallbackView?.setBounds(fullBounds)
    if (this.#overlayOpen && this.#overlayView !== undefined) {
      const overlayHeight = Math.min(OVERLAY_MAX_HEIGHT, height - OVERLAY_MARGIN * 2)
      this.#overlayView.setBounds({
        x: OVERLAY_RAIL_OFFSET,
        y: height - overlayHeight - OVERLAY_MARGIN,
        width: OVERLAY_WIDTH,
        height: overlayHeight,
      })
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

  async #establishRemoteSession(profile: InstanceProfile, profileSession: Session): Promise<void> {
    const secure = new URL(profile.origin).protocol === 'https:'
    if (secure) {
      const observedSpki = await observeRemoteSpki(profile.origin)
      if (observedSpki !== profile.pinnedSpkiSha256) {
        throw new InstanceOperationError('tls-identity-changed', '服务器 TLS 身份已经变化，请重新认证。')
      }
    }
    const descriptorResponse = await fetchSameOriginRemote(
      profileSession.fetch.bind(profileSession),
      profile.origin,
      '/.well-known/nekro-nxt',
    )
    if (!descriptorResponse.ok) {
      throw new InstanceOperationError('operation-failed', `实例描述请求失败（HTTP ${descriptorResponse.status}）。`)
    }
    const descriptor = parseRemoteDescriptor(
      await descriptorResponse.json(),
      profile.transport ?? remoteTransportForOrigin(profile.origin),
    )
    if (descriptor.instanceId !== profile.observedInstanceId) {
      throw new InstanceOperationError('instance-identity-changed', '实例描述中的 instanceId 与保存的身份不一致。')
    }
    if (profile.transport === 'loopback-http') return
    const currentSession = await fetchSameOriginRemote(
      profileSession.fetch.bind(profileSession),
      profile.origin,
      '/api/management/session',
      {
        credentials: 'include',
      },
    )
    if (currentSession.ok) return
    const credential =
      this.#memoryCredentials.get(profile.id) ??
      (profile.credentialRef ? this.#vault.get(profile.credentialRef) : undefined)
    if (credential === undefined) {
      throw new InstanceOperationError('authentication-required', '本地设备凭据不可用。')
    }
    const response = await fetchSameOriginRemote(
      profileSession.fetch.bind(profileSession),
      profile.origin,
      '/api/management/session',
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(credential),
      },
    )
    if (!response.ok) {
      throw new InstanceOperationError('authentication-required', `设备会话请求失败（HTTP ${response.status}）。`)
    }
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
    view.setBackgroundColor('#172A45')
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
      if (route !== undefined) void this.#profiles.update(profile.id, { lastRoute: route })
    }
    view.webContents.on('did-navigate', rememberRoute)
    view.webContents.on('did-navigate-in-page', rememberRoute)
    view.webContents.on('render-process-gone', () => {
      if (this.#productView !== view) return
      this.#statuses.set(profile.id, 'offline')
      this.#emitSnapshot()
      this.#showFallback('实例页面已经停止', '重新连接可恢复已保存的数据。', [
        { label: '重新连接', href: 'nxt-desktop://retry' },
        { label: '打开实例列表', href: 'nxt-desktop://instances' },
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

  #showFallback(title: string, body: string, actions: readonly TrustedFallbackAction[]): void {
    let view = this.#fallbackView
    if (view === undefined) {
      view = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
      view.setBackgroundColor('#F5F2EE')
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('will-navigate', (event, target) => {
        if (!target.startsWith('nxt-desktop://')) return
        event.preventDefault()
        if (target === 'nxt-desktop://retry') void this.switchTo(this.#currentProfileId, false, true)
        if (target === 'nxt-desktop://instances') void this.openOverlay()
        if (target === 'nxt-desktop://reauthenticate') void this.openOverlay()
      })
      this.#fallbackView = view
    }
    if (!this.#window.contentView.children.includes(view)) this.#window.contentView.addChildView(view)
    this.#layout()
    void view.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderTrustedFallbackHtml(title, body, actions))}`)
      .catch((error: unknown) => {
        if (!this.#disposed && !view.webContents.isDestroyed()) {
          console.error('[nekro-nxt] Desktop 连接状态页加载失败：', error)
        }
      })
  }

  #hideFallback(): void {
    if (this.#fallbackView !== undefined && this.#window.contentView.children.includes(this.#fallbackView)) {
      this.#window.contentView.removeChildView(this.#fallbackView)
    }
  }

  async #tryRevokeDevice(profile: InstanceProfile, profileSession: Session): Promise<void> {
    const credential =
      this.#memoryCredentials.get(profile.id) ??
      (profile.credentialRef ? this.#vault.get(profile.credentialRef) : undefined)
    if (credential === undefined) return
    try {
      this.#configureSession(profile, profileSession)
      await this.#establishRemoteSession(profile, profileSession)
      const sessionResponse = await fetchSameOriginRemote(
        profileSession.fetch.bind(profileSession),
        profile.origin,
        '/api/management/session',
        { credentials: 'include' },
      )
      if (!sessionResponse.ok) return
      const state: unknown = await sessionResponse.json()
      if (!isRecord(state) || typeof state['csrfToken'] !== 'string') return
      await fetchSameOriginRemote(
        profileSession.fetch.bind(profileSession),
        profile.origin,
        `/api/management/devices/${encodeURIComponent(credential.deviceId)}`,
        {
          method: 'DELETE',
          credentials: 'include',
          headers: { 'x-nxt-csrf': state['csrfToken'], origin: profile.origin },
        },
      )
    } catch {
      // Local removal must remain available while the Server is offline.
    }
  }

  #startNotificationMonitor(): void {
    const previous = new Map<string, boolean>()
    const poll = async (): Promise<void> => {
      await Promise.all(
        this.#profiles
          .list()
          .filter((profile) => profile.notificationsEnabled)
          .map(async (profile) => {
            let available = false
            try {
              const profileSession = session.fromPartition(profile.partition)
              this.#configureSession(profile, profileSession)
              const response = await fetchSameOriginRemote(
                profileSession.fetch.bind(profileSession),
                profile.origin,
                '/health/ready',
                { signal: AbortSignal.timeout(4_000) },
              )
              available = response.ok
              if (available) {
                if (profile.kind === 'remote') await this.#establishRemoteSession(profile, profileSession)
                const cursor = this.#notificationCursors.get(profile.id)
                const notificationResponse = await fetchSameOriginRemote(
                  profileSession.fetch.bind(profileSession),
                  profile.origin,
                  `/api/client-notifications${cursor === undefined ? '' : `?cursor=${cursor}`}`,
                  { credentials: 'include', signal: AbortSignal.timeout(8_000) },
                )
                if (!notificationResponse.ok) {
                  throw new InstanceOperationError(
                    'authentication-required',
                    `系统通知请求失败（HTTP ${notificationResponse.status}）。`,
                  )
                }
                const feed = ClientNotificationFeedResponseSchema.parse(await notificationResponse.json())
                this.#notificationCursors.set(profile.id, feed.cursor)
                for (const item of feed.notifications) {
                  if (Notification.isSupported()) {
                    const notice = new Notification({
                      title: `NekroNXT · ${profile.displayName} · ${item.title}`,
                      body: item.body,
                    })
                    notice.on('click', () => {
                      this.#window.show()
                      this.#window.focus()
                      void this.#openProfileRoute(profile.id, item.route ?? '/work')
                    })
                    notice.show()
                  }
                }
              }
            } catch (error) {
              available = false
              this.#notificationCursors.delete(profile.id)
              this.#statuses.set(
                profile.id,
                trustedFallbackForError(error, {
                  canReauthenticate: profile.transport !== 'loopback-http',
                }).status,
              )
            }
            if (available) this.#statuses.set(profile.id, 'ready')
            this.#emitSnapshot()
            const last = previous.get(profile.id)
            previous.set(profile.id, available)
            if (last === undefined || last === available) return
            if (Notification.isSupported()) {
              const notice = new Notification({
                title: `NekroNXT · ${profile.displayName}`,
                body: available ? '服务实例已经恢复连接。' : '服务实例持续无法连接。',
              })
              notice.on('click', () => {
                this.#window.show()
                this.#window.focus()
                void this.switchTo(profile.id)
              })
              notice.show()
            }
          }),
      )
    }
    void poll()
    this.#notificationTimer = setInterval(() => void poll(), 5_000)
  }

  async #openProfileRoute(profileId: string, route: string): Promise<void> {
    await this.#profiles.update(profileId, { lastRoute: route })
    await this.switchTo(profileId, true, true)
  }
}
