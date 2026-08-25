import { InstanceOperationError } from './instance-operation-error.js'
import type { InstanceStatus } from './instance-profiles.js'

export const FALLBACK_MIN_VISIBLE_MS = 480

export const fallbackRemainingVisibleMs = (visibleAt: number, now: number): number =>
  Math.max(0, FALLBACK_MIN_VISIBLE_MS - Math.max(0, now - visibleAt))

export interface TrustedFallbackAction {
  readonly label: string
  readonly href: `nxt-desktop://${string}`
}

export interface TrustedFallbackPresentation {
  readonly status: Extract<InstanceStatus, 'offline' | 'authentication-required' | 'incompatible'>
  readonly body: string
  readonly actions: readonly TrustedFallbackAction[]
}

const retryAction = { label: '重试连接', href: 'nxt-desktop://retry' } as const
const reauthenticateAction = { label: '重新认证', href: 'nxt-desktop://reauthenticate' } as const
const instancesAction = { label: '管理服务实例', href: 'nxt-desktop://instances' } as const
const localAction = { label: '返回本地实例', href: 'nxt-desktop://local' } as const

const retryActions = [retryAction, instancesAction] as const
const authenticationActions = (canReauthenticate: boolean): readonly TrustedFallbackAction[] =>
  canReauthenticate ? [reauthenticateAction, retryAction, instancesAction] : retryActions

const assertNever = (value: never): never => {
  throw new Error(`未处理的实例错误码：${String(value)}`)
}

const baseTrustedFallbackForError = (
  cause: unknown,
  options: { readonly canReauthenticate: boolean },
): TrustedFallbackPresentation => {
  if (!(cause instanceof InstanceOperationError)) {
    return {
      status: 'offline',
      body: '无法完成实例连接，请检查服务器状态和网络后重试。',
      actions: retryActions,
    }
  }
  const code = cause.code
  switch (code) {
    case 'invalid-address':
      return {
        status: 'incompatible',
        body: '保存的服务器地址无效，请从实例列表移除后重新添加。',
        actions: [instancesAction],
      }
    case 'unsupported-protocol':
      return {
        status: 'incompatible',
        body: '该实例使用当前 Desktop 不支持的地址协议，请升级 Desktop 或重新添加实例。',
        actions: [instancesAction],
      }
    case 'duplicate-instance':
      return { status: 'offline', body: '该服务实例已经存在，请从实例列表选择。', actions: [instancesAction] }
    case 'management-key-required':
      return {
        status: 'authentication-required',
        body: '此服务实例需要管理密钥，请重新认证。',
        actions: authenticationActions(options.canReauthenticate),
      }
    case 'management-key-rejected':
      return {
        status: 'authentication-required',
        body: '管理密钥未通过验证，请检查后重新认证。',
        actions: authenticationActions(options.canReauthenticate),
      }
    case 'authentication-required':
      return {
        status: 'authentication-required',
        body: '此客户端的设备会话已经失效，请重新认证。',
        actions: authenticationActions(options.canReauthenticate),
      }
    case 'unreachable':
      return { status: 'offline', body: '无法连接服务器，请检查地址、端口和网络状态。', actions: retryActions }
    case 'incompatible-instance':
      return {
        status: 'incompatible',
        body: '服务实例与当前 Desktop 的协议版本不兼容，请升级版本较旧的一端。',
        actions: [instancesAction],
      }
    case 'transport-mismatch':
      return {
        status: 'incompatible',
        body: '服务器声明的传输方式与保存地址不一致，请检查服务入口配置。',
        actions: retryActions,
      }
    case 'instance-identity-changed':
      return {
        status: 'incompatible',
        body: '该地址现在指向另一个服务实例，请从实例列表重新添加。',
        actions: [instancesAction],
      }
    case 'tls-identity-changed':
      return {
        status: 'authentication-required',
        body: '服务器 TLS 身份已经变化，请确认服务器后重新认证。',
        actions: authenticationActions(options.canReauthenticate),
      }
    case 'unsafe-redirect':
      return {
        status: 'offline',
        body: '服务器尝试跳转到其他地址，已停止连接。请检查服务入口配置。',
        actions: retryActions,
      }
    case 'insecure-http-confirmation-required':
      return {
        status: 'offline',
        body: '未确认未加密 HTTP 连接风险，已停止连接。请从实例列表重新操作。',
        actions: [instancesAction],
      }
    case 'operation-failed':
      return { status: 'offline', body: '无法完成实例连接，请稍后重试。', actions: retryActions }
    default:
      return assertNever(code)
  }
}

export const trustedFallbackForError = (
  cause: unknown,
  options: { readonly canReauthenticate: boolean; readonly canReturnLocal?: boolean },
): TrustedFallbackPresentation => {
  const presentation = baseTrustedFallbackForError(cause, options)
  return options.canReturnLocal === true
    ? { ...presentation, actions: [localAction, ...presentation.actions] }
    : presentation
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/gu, (character) => {
    const escaped: Readonly<Record<string, string>> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    }
    return escaped[character] ?? character
  })

export interface TrustedFallbackRenderInput {
  readonly title: string
  readonly body: string
  readonly actions: readonly TrustedFallbackAction[]
  readonly platform: NodeJS.Platform
  readonly theme?: 'light' | 'dark'
  readonly instance: {
    readonly displayName: string
    readonly addressLabel: string
    readonly status: InstanceStatus
  }
}

const statusText = (status: InstanceStatus): string =>
  ({
    connecting: '正在连接',
    ready: '运行正常',
    unstable: '连接不稳定',
    offline: '无法连接',
    'authentication-required': '需要重新认证',
    incompatible: '版本不兼容',
  })[status]

export const renderTrustedFallbackHtml = (input: TrustedFallbackRenderInput): string => {
  const buttons = input.actions
    .map(
      ({ label, href }, index) =>
        `<a class="${index === 0 ? 'primary' : ''}" href="${escapeHtml(href)}"${href === 'nxt-desktop://instances' ? ' data-instance-sheet-trigger="instances"' : href === 'nxt-desktop://reauthenticate' ? ' data-instance-sheet-trigger="reauthenticate"' : ''}>${escapeHtml(label)}</a>`,
    )
    .join('')
  const safeLeft = input.platform === 'darwin' ? '84px' : '20px'
  const safeRight = input.platform === 'darwin' ? '20px' : '138px'
  const connecting = input.actions.length === 0
  const phaseLabel = connecting ? '正在切换' : '连接处理'
  return `<!doctype html><html lang="zh-CN" data-theme="${input.theme ?? 'light'}" data-visibility="open"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  *{box-sizing:border-box}:root{color-scheme:light dark;font-family:Inter,system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;background:#f5f2ee;color:#172a45;--surface:#fffdf9;--subtle:#edeff4;--border:#cdd3dd;--muted:#5a6679;--accent:#466394;--accent-fg:#fff;--focus:#0b73b4;--danger:#b83a3a;--safe-left:${safeLeft};--safe-right:${safeRight}}body{min-block-size:100vh;min-inline-size:0;margin:0;overflow:hidden;background:linear-gradient(145deg,#f5f2ee 0%,#f5f2ee 58%,#edf1f6 100%);opacity:1;transition:opacity 180ms cubic-bezier(.4,0,1,1)}:root[data-visibility="closing"] body{pointer-events:none;opacity:0}.titlebar{display:flex;block-size:48px;align-items:center;padding:0 var(--safe-right) 0 var(--safe-left);border-bottom:1px solid color-mix(in srgb,var(--border) 72%,transparent);background:color-mix(in srgb,var(--surface) 88%,transparent);-webkit-app-region:drag}.identity{display:flex;min-inline-size:0;align-items:center;gap:10px}.mark{display:grid;inline-size:28px;block-size:28px;flex:none;place-items:center;border:1px solid color-mix(in srgb,var(--accent) 52%,var(--border));border-radius:50%;color:var(--accent);background:var(--surface);box-shadow:inset 0 0 0 3px color-mix(in srgb,var(--accent) 9%,transparent)}.mark svg{inline-size:17px;block-size:17px}.brand{display:grid;gap:0}.brand strong{font-size:14px;line-height:18px}.brand span{color:var(--muted);font-size:10px;line-height:13px;letter-spacing:.08em}.workspace{display:grid;min-block-size:calc(100vh - 48px);grid-template-columns:minmax(220px,300px) minmax(0,1fr);align-items:center;gap:clamp(44px,7vw,96px);inline-size:min(100%,1120px);margin:auto;padding:clamp(44px,8vh,84px) clamp(44px,7vw,92px)}.instance{align-self:stretch;display:flex;min-inline-size:0;flex-direction:column;justify-content:center;padding-inline-end:clamp(28px,4vw,56px);border-right:1px solid var(--border)}.eyebrow{margin:0 0 18px;color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.instance h2{margin:0 0 7px;font-size:22px;line-height:29px;overflow-wrap:anywhere}.address{margin:0;color:var(--muted);font-size:13px;line-height:20px;overflow-wrap:anywhere}.status{--status:var(--danger);display:inline-flex;inline-size:max-content;align-items:center;gap:8px;margin-top:24px;padding:5px 9px;border:1px solid color-mix(in srgb,var(--status) 36%,var(--border));border-radius:999px;color:var(--status);background:color-mix(in srgb,var(--status) 7%,var(--surface));font-size:12px;font-weight:650}.status.connecting{--status:#0b73b4}.status.ready{--status:#2f855a}.status.unstable,.status.authentication-required{--status:#a76b10}.status.incompatible{--status:#6a6f7e}.status::before{inline-size:7px;block-size:7px;border-radius:50%;background:currentColor;content:""}.status.connecting::before{animation:status-pulse 1.2s ease-in-out infinite}@keyframes status-pulse{50%{opacity:.35;transform:scale(.75)}}.reason{min-inline-size:0;max-inline-size:620px}.reason .eyebrow{color:var(--accent)}h1{max-inline-size:18ch;margin:0 0 14px;font-size:clamp(25px,3.2vw,36px);line-height:1.18;letter-spacing:-.025em;overflow-wrap:anywhere}.reason p{max-inline-size:58ch;margin:0;color:var(--muted);font-size:14px;line-height:1.7;overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap;align-items:stretch;gap:8px;margin-top:30px}a{display:inline-flex;min-block-size:36px;min-inline-size:120px;align-items:center;justify-content:center;padding:8px 14px;border:1px solid transparent;border-radius:8px;color:inherit;text-align:center;text-decoration:none;overflow-wrap:anywhere;background:#e8ecf3}a:hover{background:#dce3ee}a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}.primary{color:var(--accent-fg);background:var(--accent)}.primary:hover{background:#375079}@media(max-width:760px){body{overflow:auto}.workspace{min-block-size:calc(100vh - 48px);grid-template-columns:1fr;align-content:center;gap:32px;padding:36px 28px}.instance{align-self:auto;padding:0 0 28px;border-right:0;border-bottom:1px solid var(--border)}.actions a{flex:1 1 150px}}:root[data-theme="dark"]{color:#f2f4f7;background:#0f1a2c;--surface:#182d4a;--subtle:#12233a;--border:#3d5878;--muted:#a9b4c4;--accent:#96afd8;--accent-fg:#0a121f;--focus:#6bc3f4;--danger:#ff8f8f}:root[data-theme="dark"] body{background:linear-gradient(145deg,#0f1a2c 0%,#0f1a2c 58%,#12233a 100%)}:root[data-theme="dark"] .status.connecting{--status:#6bc3f4}:root[data-theme="dark"] .status.ready{--status:#72d49a}:root[data-theme="dark"] .status.unstable,:root[data-theme="dark"] .status.authentication-required{--status:#e7b75f}:root[data-theme="dark"] .status.incompatible{--status:#a9b4c4}:root[data-theme="dark"] a{background:#2c4666}:root[data-theme="dark"] a:hover{background:#365473}:root[data-theme="dark"] .primary{background:var(--accent)}:root[data-theme="dark"] .primary:hover{background:#bdcfec}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition-duration:1ms!important}}</style></head><body><header class="titlebar"><div class="identity"><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.7"/><path d="M7.5 14.5c2.2-5.2 6.2-7.1 9.6-5.2M9 17.2c3.8.9 7-.9 8.4-3.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="16.9" cy="8.9" r="1.6" fill="#d0a66c"/></svg></span><span class="brand"><strong>NekroNXT</strong><span>服务实例</span></span></div></header><main class="workspace"><aside class="instance" aria-label="当前服务实例"><p class="eyebrow">当前服务实例</p><h2>${escapeHtml(input.instance.displayName)}</h2><p class="address">${escapeHtml(input.instance.addressLabel)}</p><span class="status ${escapeHtml(input.instance.status)}">${escapeHtml(statusText(input.instance.status))}</span></aside><section class="reason"><p class="eyebrow">${phaseLabel}</p><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.body)}</p><nav class="actions" aria-label="连接操作">${buttons}</nav></section></main></body></html>`
}
