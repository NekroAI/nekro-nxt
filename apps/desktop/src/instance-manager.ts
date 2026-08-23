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
import { InstanceDescriptorSchema } from '@nekro-nxt/contracts'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CredentialVault, type DeviceCredential } from './credential-vault.js'
import { InstanceProfileStore, type InstanceProfile, type InstanceStatus } from './instance-profiles.js'
import { certificateSpki, observeRemoteSpki, pairRemoteInstance } from './remote-pairing.js'
import { isAllowedExternalUrl, isSameApplicationOrigin, type ProductRelease } from './distribution.js'
import { desktopTitleBarCss, desktopWindowChrome } from './window-chrome.js'

const OVERLAY_WIDTH = 344
const OVERLAY_MAX_HEIGHT = 480
const OVERLAY_RAIL_OFFSET = 64
const OVERLAY_MARGIN = 12

interface ProfilePresentation {
  readonly id: string
  readonly kind: 'local' | 'remote'
  readonly displayName: string
  readonly origin: string
  readonly addressLabel: string
  readonly status: InstanceStatus
  readonly notificationsEnabled: boolean
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

const fallbackHtml = (
  title: string,
  body: string,
  actions: readonly { readonly label: string; readonly href: string }[],
): string => {
  const buttons = actions
    .map(({ label, href }, index) => `<a class="${index === 0 ? 'primary' : ''}" href="${href}">${label}</a>`)
    .join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  :root{color-scheme:light dark;font-family:Inter,system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;background:#f5f2ee;color:#172a45}body{display:grid;min-height:100vh;margin:0;place-items:center}.card{width:min(520px,calc(100vw - 48px));padding:30px;border:1px solid #cdd3dd;border-radius:12px;background:#fffdf9;box-shadow:0 20px 60px rgb(3 14 22/18%)}h1{margin:0 0 12px;font-size:20px}p{margin:0;color:#5a6679;line-height:1.7}.actions{display:flex;gap:8px;margin-top:24px}a{padding:8px 13px;border-radius:8px;color:inherit;text-decoration:none;background:#e8ecf3}.primary{color:#fff;background:#466394}@media(prefers-color-scheme:dark){:root{background:#0f1a2c;color:#f2f4f7}.card{border-color:#3d5878;background:#182d4a}p{color:#a9b4c4}a{background:#2c4666}.primary{color:#0a121f;background:#96afd8}}</style></head><body><main class="card"><h1>${title}</h1><p>${body}</p><div class="actions">${buttons}</div></main></body></html>`
}

export class DesktopInstanceManager {
  readonly #window: BrowserWindow
  readonly #release: ProductRelease
  readonly #profiles: InstanceProfileStore
  readonly #vault: CredentialVault
  readonly #statuses = new Map<string, InstanceStatus>()
  readonly #memoryCredentials = new Map<string, DeviceCredential>()
  readonly #notifiedApprovals = new Map<string, Set<string>>()
  readonly #overlayWaiters = new Set<() => void>()
  #productView: WebContentsView | undefined
  #overlayView: WebContentsView | undefined
  #fallbackView: WebContentsView | undefined
  #currentProfileId: string
  #overlayOpen = false
  #switchSerial = 0
  #notificationTimer: ReturnType<typeof setInterval> | undefined

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
    manager.#window.on('closed', () => manager.dispose())
    await manager.switchTo(profiles.selectedProfileId, false)
    manager.#window.show()
    manager.#startNotificationMonitor()
    return manager
  }

  get window(): BrowserWindow {
    return this.#window
  }

  async switchTo(profileId: string, persist = true, force = false, skipDraftConfirm = false): Promise<void> {
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
    this.#window.setTitle(`NekroNxt — ${profile.displayName}`)
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
      if (serial !== this.#switchSerial) return
      this.#statuses.set(profile.id, 'ready')
      this.#hideFallback()
      this.#emitSnapshot()
    } catch (error) {
      if (serial !== this.#switchSerial) return
      const authenticationRequired = error instanceof Error && error.message.includes('重新认证')
      const incompatible = error instanceof Error && error.message.includes('版本不兼容')
      this.#statuses.set(
        profile.id,
        incompatible ? 'incompatible' : authenticationRequired ? 'authentication-required' : 'offline',
      )
      this.#showFallback(
        `无法连接「${profile.displayName}」`,
        incompatible
          ? '服务实例与当前 Desktop 的管理协议版本不兼容，请升级版本较旧的一端。'
          : authenticationRequired
            ? '此客户端的设备会话已经失效，请重新认证。'
            : '服务器可能正在启动，或当前网络无法访问该地址。',
        [
          { label: '重试连接', href: 'nxt-desktop://retry' },
          ...(profile.kind === 'remote' ? [{ label: '重新认证', href: 'nxt-desktop://reauthenticate' }] : []),
          { label: '打开实例列表', href: 'nxt-desktop://instances' },
        ],
      )
      this.#emitSnapshot()
    }
  }

  openOverlay(): Promise<void> {
    if (!this.#overlayOpen) {
      this.#overlayOpen = true
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
        void view.webContents.loadFile(rendererAsset('instance-overlay.html'))
        this.#overlayView = view
      }
      this.#window.contentView.addChildView(this.#overlayView)
      this.#layout()
      this.#overlayView.webContents.focus()
      this.#emitSnapshot()
    }
    return new Promise((resolve) => this.#overlayWaiters.add(resolve))
  }

  closeOverlay(): void {
    if (!this.#overlayOpen) return
    this.#overlayOpen = false
    if (this.#overlayView !== undefined) this.#window.contentView.removeChildView(this.#overlayView)
    for (const resolve of this.#overlayWaiters) resolve()
    this.#overlayWaiters.clear()
    this.#productView?.webContents.focus()
  }

  dispose(): void {
    if (this.#notificationTimer !== undefined) clearInterval(this.#notificationTimer)
    this.#notificationTimer = undefined
    this.closeOverlay()
    this.#destroyProductView()
    this.#fallbackView?.webContents.close()
    this.#fallbackView = undefined
    this.#overlayView?.webContents.close()
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
    ipcMain.on('nxt:shell:content-pointer', (event) => {
      if (event.sender.id === this.#productView?.webContents.id) this.closeOverlay()
    })
    ipcMain.handle('nxt:instances:list', (event) => {
      this.#assertOverlaySender(event.sender.id)
      return this.#snapshot()
    })
    ipcMain.handle('nxt:instances:close', (event) => {
      this.#assertOverlaySender(event.sender.id)
      this.closeOverlay()
    })
    ipcMain.handle('nxt:instances:switch', async (event, value: unknown) => {
      this.#assertOverlaySender(event.sender.id)
      await this.switchTo(requiredString(isRecord(value) ? value['profileId'] : undefined, '服务实例'))
    })
    ipcMain.handle('nxt:instances:retry', async (event, value: unknown) => {
      this.#assertOverlaySender(event.sender.id)
      await this.switchTo(requiredString(isRecord(value) ? value['profileId'] : undefined, '服务实例'), true, true)
    })
    ipcMain.handle('nxt:instances:add', async (event, value: unknown) => {
      this.#assertOverlaySender(event.sender.id)
      if (!isRecord(value)) throw new Error('添加实例参数无效。')
      const address = requiredString(value['address'], '服务器地址')
      const managementKey = requiredString(value['managementKey'], '管理密钥')
      const displayName = typeof value['displayName'] === 'string' ? value['displayName'] : ''
      const paired = await pairRemoteInstance({
        address,
        managementKey,
        deviceLabel: `${app.getName()} · ${process.platform}`,
        clientReleaseId: this.#release.releaseId,
      })
      if (
        this.#profiles
          .list()
          .some(
            (profile) =>
              profile.origin === paired.origin || profile.observedInstanceId === paired.descriptor.instanceId,
          )
      ) {
        throw new Error('该服务实例已经添加。')
      }
      const credential = { deviceId: paired.deviceId, deviceSecret: paired.deviceSecret }
      const credentialRef = await this.#vault.put(credential)
      const profile = await this.#profiles.addRemote({
        displayName,
        origin: paired.origin,
        observedInstanceId: paired.descriptor.instanceId,
        pinnedSpkiSha256: paired.spkiSha256,
        ...(credentialRef === undefined ? {} : { credentialRef }),
      })
      this.#memoryCredentials.set(profile.id, credential)
      this.#statuses.set(profile.id, 'connecting')
      await this.switchTo(profile.id, false)
    })
    ipcMain.handle('nxt:instances:update', async (event, value: unknown) => {
      this.#assertOverlaySender(event.sender.id)
      if (!isRecord(value)) throw new Error('实例修改参数无效。')
      const profileId = requiredString(value['profileId'], '服务实例')
      await this.#profiles.update(profileId, {
        ...(typeof value['displayName'] === 'string' ? { displayName: value['displayName'].trim() } : {}),
        ...(typeof value['origin'] === 'string' ? { origin: value['origin'] } : {}),
        ...(typeof value['notificationsEnabled'] === 'boolean'
          ? { notificationsEnabled: value['notificationsEnabled'] }
          : {}),
      })
      if (
        profileId === this.#currentProfileId &&
        (typeof value['origin'] === 'string' || typeof value['displayName'] === 'string')
      ) {
        await this.switchTo(profileId, false, true)
      }
      this.#emitSnapshot()
    })
    ipcMain.handle('nxt:instances:reauthenticate', async (event, value: unknown) => {
      this.#assertOverlaySender(event.sender.id)
      if (!isRecord(value)) throw new Error('重新认证参数无效。')
      const profileId = requiredString(value['profileId'], '服务实例')
      const profile = this.#profiles.get(profileId)
      if (profile === undefined || profile.kind !== 'remote') throw new Error('远程服务实例不存在。')
      const paired = await pairRemoteInstance({
        address: profile.origin,
        managementKey: requiredString(value['managementKey'], '管理密钥'),
        deviceLabel: `${app.getName()} · ${process.platform}`,
        clientReleaseId: this.#release.releaseId,
      })
      if (profile.observedInstanceId !== paired.descriptor.instanceId)
        throw new Error('该地址对应的服务实例身份已经变化。')
      const oldRef = profile.credentialRef
      const credential = { deviceId: paired.deviceId, deviceSecret: paired.deviceSecret }
      const credentialRef = await this.#vault.put(credential)
      await this.#profiles.updateSecurity(profile.id, {
        observedInstanceId: paired.descriptor.instanceId,
        pinnedSpkiSha256: paired.spkiSha256,
        ...(credentialRef === undefined ? {} : { credentialRef }),
      })
      if (oldRef !== undefined) await this.#vault.remove(oldRef)
      this.#memoryCredentials.set(profile.id, credential)
      await this.switchTo(profile.id, false, true)
    })
    ipcMain.handle('nxt:instances:remove', async (event, value: unknown) => {
      this.#assertOverlaySender(event.sender.id)
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
      await this.#profiles.remove(profile.id)
      this.#statuses.delete(profile.id)
      this.#emitSnapshot()
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
        addressLabel: profile.kind === 'local' ? '此设备' : new URL(profile.origin).host,
        status: this.#statuses.get(profile.id) ?? 'offline',
        notificationsEnabled: profile.notificationsEnabled,
      })),
    }
  }

  #currentPresentation(): { readonly displayName: string; readonly status: InstanceStatus } {
    const profile = this.#profiles.get(this.#currentProfileId) ?? this.#profiles.get('local')!
    return { displayName: profile.displayName, status: this.#statuses.get(profile.id) ?? 'offline' }
  }

  #emitSnapshot(): void {
    const snapshot = this.#snapshot()
    this.#overlayView?.webContents.send('nxt:instances:changed', snapshot)
    this.#productView?.webContents.send('nxt:shell:current-changed', this.#currentPresentation())
  }

  #layout(): void {
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
    profileSession.setCertificateVerifyProc((request, callback) => {
      try {
        const sameHost = request.hostname === new URL(profile.origin).hostname
        callback(sameHost && certificateSpki(request.certificate.data) === profile.pinnedSpkiSha256 ? 0 : -2)
      } catch {
        callback(-2)
      }
    })
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
    const observedSpki = await observeRemoteSpki(profile.origin)
    if (observedSpki !== profile.pinnedSpkiSha256) throw new Error('服务器证书已经变化，请使用管理密钥重新认证。')
    const descriptorResponse = await profileSession.fetch(`${profile.origin}/.well-known/nekro-nxt`)
    if (!descriptorResponse.ok) throw new Error('该地址不是可识别的 NekroNxt 服务实例。')
    const descriptor = InstanceDescriptorSchema.parse(await descriptorResponse.json())
    if (descriptor.managementProtocol !== 1 || descriptor.desktopChromeProtocol !== 1) {
      throw new Error('服务实例版本不兼容。')
    }
    if (descriptor.instanceId !== profile.observedInstanceId)
      throw new Error('服务器身份已经变化，请使用管理密钥重新认证。')
    const currentSession = await profileSession.fetch(`${profile.origin}/api/management/session`, {
      credentials: 'include',
    })
    if (currentSession.ok) return
    const credential =
      this.#memoryCredentials.get(profile.id) ??
      (profile.credentialRef ? this.#vault.get(profile.credentialRef) : undefined)
    if (credential === undefined) throw new Error('设备凭据不可用，请重新认证。')
    const response = await profileSession.fetch(`${profile.origin}/api/management/session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credential),
    })
    if (!response.ok) throw new Error('设备会话已经失效，请重新认证。')
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
    view.webContents.on('dom-ready', () => void view.webContents.insertCSS(desktopTitleBarCss(process.platform)))
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, target) => {
      if (isSameApplicationOrigin(profile.origin, target)) return
      event.preventDefault()
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
    this.#window.contentView.removeChildView(view)
    view.webContents.close()
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
    title: string,
    body: string,
    actions: readonly { readonly label: string; readonly href: string }[],
  ): void {
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
    void view.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(fallbackHtml(title, body, actions))}`,
    )
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
      const sessionResponse = await profileSession.fetch(`${profile.origin}/api/management/session`, {
        credentials: 'include',
      })
      if (!sessionResponse.ok) return
      const state: unknown = await sessionResponse.json()
      if (!isRecord(state) || typeof state['csrfToken'] !== 'string') return
      await profileSession.fetch(
        `${profile.origin}/api/management/devices/${encodeURIComponent(credential.deviceId)}`,
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
          .filter((profile) => profile.kind === 'remote' && profile.notificationsEnabled)
          .map(async (profile) => {
            let available = false
            try {
              const profileSession = session.fromPartition(profile.partition)
              this.#configureSession(profile, profileSession)
              const response = await profileSession.fetch(`${profile.origin}/health/ready`, {
                signal: AbortSignal.timeout(4_000),
              })
              available = response.ok
              if (available) {
                await this.#establishRemoteSession(profile, profileSession)
                const snapshotResponse = await profileSession.fetch(`${profile.origin}/api/snapshot`, {
                  credentials: 'include',
                  signal: AbortSignal.timeout(8_000),
                })
                if (!snapshotResponse.ok) throw new Error('设备会话已经失效，请重新认证。')
                const snapshot = (await snapshotResponse.json()) as unknown
                const dynamic = isRecord(snapshot) && Array.isArray(snapshot['dynamic']) ? snapshot['dynamic'] : []
                const notified = this.#notifiedApprovals.get(profile.id) ?? new Set<string>()
                this.#notifiedApprovals.set(profile.id, notified)
                for (const row of dynamic) {
                  if (!isRecord(row) || !isRecord(row['latestRun'])) continue
                  const latest = row['latestRun']
                  const requestId = latest['approvalRequestId']
                  if (
                    latest['status'] !== 'awaiting-approval' ||
                    typeof requestId !== 'string' ||
                    notified.has(requestId)
                  )
                    continue
                  notified.add(requestId)
                  if (Notification.isSupported()) {
                    const notice = new Notification({
                      title: `NekroNxt · ${profile.displayName}`,
                      body: '智能体正在等待你确认动态扩展操作。',
                    })
                    notice.on('click', () => {
                      this.#window.show()
                      this.#window.focus()
                      void this.#openProfileRoute(profile.id, '/work/creator')
                    })
                    notice.show()
                  }
                }
              }
            } catch (error) {
              available = false
              this.#statuses.set(
                profile.id,
                error instanceof Error && error.message.includes('重新认证') ? 'authentication-required' : 'offline',
              )
            }
            if (available) this.#statuses.set(profile.id, 'ready')
            this.#emitSnapshot()
            const last = previous.get(profile.id)
            previous.set(profile.id, available)
            if (last === undefined || last === available) return
            if (Notification.isSupported()) {
              const notice = new Notification({
                title: `NekroNxt · ${profile.displayName}`,
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
    this.#notificationTimer = setInterval(() => void poll(), 30_000)
  }

  async #openProfileRoute(profileId: string, route: string): Promise<void> {
    await this.#profiles.update(profileId, { lastRoute: route })
    await this.switchTo(profileId, true, true)
  }
}
