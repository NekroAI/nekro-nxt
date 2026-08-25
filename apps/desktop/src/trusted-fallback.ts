import { InstanceOperationError } from './instance-operation-error.js'
import type { InstanceStatus } from './instance-profiles.js'

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
const instancesAction = { label: '打开实例列表', href: 'nxt-desktop://instances' } as const

const retryActions = [retryAction, instancesAction] as const
const authenticationActions = (canReauthenticate: boolean): readonly TrustedFallbackAction[] =>
  canReauthenticate ? [reauthenticateAction, retryAction, instancesAction] : retryActions

const assertNever = (value: never): never => {
  throw new Error(`未处理的实例错误码：${String(value)}`)
}

export const trustedFallbackForError = (
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

export const renderTrustedFallbackHtml = (
  title: string,
  body: string,
  actions: readonly TrustedFallbackAction[],
): string => {
  const buttons = actions
    .map(
      ({ label, href }, index) =>
        `<a class="${index === 0 ? 'primary' : ''}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`,
    )
    .join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  *{box-sizing:border-box}:root{color-scheme:light dark;font-family:Inter,system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;background:#f5f2ee;color:#172a45}body{display:grid;min-block-size:100vh;min-inline-size:0;margin:0;padding:24px;place-items:center}.card{inline-size:min(520px,100%);max-inline-size:100%;min-inline-size:0;padding:clamp(20px,7vw,30px);border:1px solid #cdd3dd;border-radius:12px;background:#fffdf9;box-shadow:0 20px 60px rgb(3 14 22/18%)}h1{margin:0 0 12px;font-size:20px;overflow-wrap:anywhere}p{margin:0;color:#5a6679;line-height:1.7;overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap;align-items:stretch;gap:8px;margin-top:24px}a{display:inline-flex;min-inline-size:0;flex:1 1 auto;align-items:center;justify-content:center;padding:8px 13px;border-radius:8px;color:inherit;text-align:center;text-decoration:none;overflow-wrap:anywhere;background:#e8ecf3}.primary{color:#fff;background:#466394}@media(prefers-color-scheme:dark){:root{background:#0f1a2c;color:#f2f4f7}.card{border-color:#3d5878;background:#182d4a}p{color:#a9b4c4}a{background:#2c4666}.primary{color:#0a121f;background:#96afd8}}</style></head><body><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><div class="actions">${buttons}</div></main></body></html>`
}
