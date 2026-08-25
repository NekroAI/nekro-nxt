import { describe, expect, it } from 'vitest'
import {
  InstanceOperationError,
  trustedInstanceErrorCodes,
  type TrustedInstanceErrorCode,
} from '../src/instance-operation-error.ts'
import {
  FALLBACK_MIN_VISIBLE_MS,
  fallbackRemainingVisibleMs,
  renderTrustedFallbackHtml,
  trustedFallbackForError,
  type TrustedFallbackPresentation,
} from '../src/trusted-fallback.ts'

const expected = {
  'invalid-address': {
    status: 'incompatible',
    body: '保存的服务器地址无效，请从实例列表移除后重新添加。',
    action: 'nxt-desktop://instances',
  },
  'unsupported-protocol': {
    status: 'incompatible',
    body: '该实例使用当前 Desktop 不支持的地址协议，请升级 Desktop 或重新添加实例。',
    action: 'nxt-desktop://instances',
  },
  'duplicate-instance': {
    status: 'offline',
    body: '该服务实例已经存在，请从实例列表选择。',
    action: 'nxt-desktop://instances',
  },
  'management-key-required': {
    status: 'authentication-required',
    body: '此服务实例需要管理密钥，请重新认证。',
    action: 'nxt-desktop://reauthenticate',
  },
  'management-key-rejected': {
    status: 'authentication-required',
    body: '管理密钥未通过验证，请检查后重新认证。',
    action: 'nxt-desktop://reauthenticate',
  },
  'authentication-required': {
    status: 'authentication-required',
    body: '此客户端的设备会话已经失效，请重新认证。',
    action: 'nxt-desktop://reauthenticate',
  },
  unreachable: {
    status: 'offline',
    body: '无法连接服务器，请检查地址、端口和网络状态。',
    action: 'nxt-desktop://retry',
  },
  'incompatible-instance': {
    status: 'incompatible',
    body: '服务实例与当前 Desktop 的协议版本不兼容，请升级版本较旧的一端。',
    action: 'nxt-desktop://instances',
  },
  'transport-mismatch': {
    status: 'incompatible',
    body: '服务器声明的传输方式与保存地址不一致，请检查服务入口配置。',
    action: 'nxt-desktop://retry',
  },
  'instance-identity-changed': {
    status: 'incompatible',
    body: '该地址现在指向另一个服务实例，请从实例列表重新添加。',
    action: 'nxt-desktop://instances',
  },
  'tls-identity-changed': {
    status: 'authentication-required',
    body: '服务器 TLS 身份已经变化，请确认服务器后重新认证。',
    action: 'nxt-desktop://reauthenticate',
  },
  'unsafe-redirect': {
    status: 'offline',
    body: '服务器尝试跳转到其他地址，已停止连接。请检查服务入口配置。',
    action: 'nxt-desktop://retry',
  },
  'insecure-http-confirmation-required': {
    status: 'offline',
    body: '未确认未加密 HTTP 连接风险，已停止连接。请从实例列表重新操作。',
    action: 'nxt-desktop://instances',
  },
  'operation-failed': {
    status: 'offline',
    body: '无法完成实例连接，请稍后重试。',
    action: 'nxt-desktop://retry',
  },
} satisfies Readonly<
  Record<
    TrustedInstanceErrorCode,
    {
      readonly status: TrustedFallbackPresentation['status']
      readonly body: string
      readonly action: string
    }
  >
>

describe('Desktop Trusted Fallback behavior', () => {
  it('keeps a fast visible switch on screen for a stable minimum interval', () => {
    expect(FALLBACK_MIN_VISIBLE_MS).toBe(480)
    expect(fallbackRemainingVisibleMs(1_000, 1_000)).toBe(480)
    expect(fallbackRemainingVisibleMs(1_000, 1_180)).toBe(300)
    expect(fallbackRemainingVisibleMs(1_000, 1_480)).toBe(0)
    expect(fallbackRemainingVisibleMs(1_000, 2_000)).toBe(0)
  })

  it('maps every public instance error code to fixed status, copy, and actions', () => {
    for (const code of trustedInstanceErrorCodes) {
      const diagnostic = `internal diagnostic for ${code}`
      const presentation = trustedFallbackForError(new InstanceOperationError(code, diagnostic), {
        canReauthenticate: true,
      })
      expect(presentation.status, code).toBe(expected[code].status)
      expect(presentation.body, code).toBe(expected[code].body)
      expect(presentation.actions[0]?.href, code).toBe(expected[code].action)
      expect(presentation.body, code).not.toContain(diagnostic)
    }
  })

  it('renders actionable authentication fallback without exposing diagnostics', () => {
    const diagnostic = "Error invoking remote method 'nxt:instances:add': Error: private stack"
    const presentation = trustedFallbackForError(new InstanceOperationError('authentication-required', diagnostic), {
      canReauthenticate: true,
    })
    const html = renderTrustedFallbackHtml({
      title: '无法连接「<script>」',
      body: presentation.body,
      actions: presentation.actions,
      platform: 'darwin',
      theme: 'dark',
      instance: { displayName: '<script>', addressLabel: 'secure.example.test', status: presentation.status },
    })
    expect(html).toContain('此客户端的设备会话已经失效，请重新认证。')
    expect(html).toContain('nxt-desktop://reauthenticate')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain(diagnostic)
    expect(html).not.toContain('nxt:instances:add')
    expect(html).not.toContain('Error:')
    expect(html).toContain('data-theme="dark"')
    expect(html).toContain('data-visibility="open"')
    expect(html).toContain(':root[data-theme="dark"]')
    expect(html).toContain(':root[data-visibility="closing"] body')
    expect(html).toContain('<span>服务实例</span>')
    expect(html).toContain('连接处理')
    expect(html).not.toContain('可信恢复')
  })

  it('uses safe generic fallback for unknown errors and omits reauthentication when unavailable', () => {
    const generic = trustedFallbackForError(new Error('private network diagnostic'), { canReauthenticate: true })
    expect(generic).toMatchObject({ status: 'offline', body: '无法完成实例连接，请检查服务器状态和网络后重试。' })
    expect(generic.body).not.toContain('private network diagnostic')

    const localAuthentication = trustedFallbackForError(
      new InstanceOperationError('authentication-required', 'private authentication diagnostic'),
      { canReauthenticate: false },
    )
    expect(localAuthentication.actions.map(({ href }) => href)).not.toContain('nxt-desktop://reauthenticate')
  })

  it('labels a normal instance switch without recovery jargon', () => {
    const html = renderTrustedFallbackHtml({
      title: '正在连接「北辰实例」',
      body: '正在读取该实例的工作区…',
      actions: [],
      platform: 'darwin',
      theme: 'dark',
      instance: {
        displayName: '北辰实例',
        addressLabel: 'remote.example.test:7443',
        status: 'connecting',
      },
    })
    expect(html).toContain('正在切换')
    expect(html).toContain('服务实例')
    expect(html).not.toContain('可信恢复')
    expect(html).not.toContain('连接恢复')
  })

  it('makes returning to the local instance the primary action for a remote failure', () => {
    const remote = trustedFallbackForError(new InstanceOperationError('unreachable', 'private diagnostic'), {
      canReauthenticate: true,
      canReturnLocal: true,
    })
    expect(remote.actions.map(({ href }) => href)).toEqual([
      'nxt-desktop://local',
      'nxt-desktop://retry',
      'nxt-desktop://instances',
    ])
  })
})
