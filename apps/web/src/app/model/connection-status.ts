import type { Tone } from '../../ui-kit/index.js'
import type { ConnectionSummary } from '../../product-runtime.js'

/**
 * Connection state dictionary (Decision 2026-10-06 §6): the four states users see, with one wording, one tone and a
 * reason. Shared by wiring, the status bar, live and channel views.
 */
export type ConnectionHealth = 'ok' | 'connecting' | 'attention' | 'disabled'

export interface ConnectionStatusView {
  readonly health: ConnectionHealth
  readonly label: '正常' | '正在连接' | '需要处理' | '已停用'
  readonly tone: Tone
  /** Human reason, present when the state is not plainly “normal”. */
  readonly reason?: string
  /** Suggested next step. */
  readonly action?: string
  /** The raw Host or Adapter message, for the diagnostics area only. */
  readonly detail?: string
}

export interface ExplainedMessage {
  readonly reason: string
  readonly action?: string
  /** Machine code found in the message, kept for diagnostics. */
  readonly code?: string
  readonly raw: string
}

interface CodeEntry {
  readonly reason: string
  readonly action?: string
}

/** Known machine codes that Adapters and the Host put into status and test messages. */
const CODES: Readonly<Record<string, CodeEntry>> = {
  'platform-reference-unresolved': {
    reason: '收到的消息引用了一条平台未能提供的原消息',
    action: '不影响收发；频繁出现时检查机器人在平台上的消息读取权限',
  },
  'reference-field-missing': {
    reason: '收到的引用消息缺少原消息信息',
    action: '不影响收发，通常无需处理',
  },
  'not-connected': { reason: '账号尚未连接到平台', action: '检查连接设置，或重新登录' },
  'waiting-for-message': { reason: '还没有收到平台消息', action: '先从平台发一条消息，再重新测试' },
  'needs-channel': { reason: '还没有发现频道', action: '先从平台发一条消息' },
  'needs-target': { reason: '这个账号有多个频道', action: '选择一个频道再测试发送' },
  transient: { reason: '平台暂时不可用', action: '稍后重试' },
  permanent: { reason: '平台拒绝了这次操作', action: '检查账号权限或连接设置' },
  invalid: { reason: '发送目标无效', action: '检查频道是否仍然存在' },
  auth: { reason: '登录已失效', action: '重新登录或更新凭据' },
  unauthorized: { reason: '登录已失效', action: '重新登录或更新凭据' },
  timeout: { reason: '连接平台超时', action: '检查网络后重试' },
}

/** A standalone machine code: lowercase words joined by `-` or `_`. */
const MACHINE_CODE = /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/u
/** An English-only message without any CJK text: shown only in diagnostics. */
const HAS_CJK = /[㐀-鿿]/u

/**
 * Turns a Host or Adapter message into a user-facing reason (Decision 2026-10-06 §6). Chinese prose passes through;
 * machine codes map to a reason and next step; unknown codes and English internals get a generic reason, keeping the
 * original text for diagnostics.
 */
export function explainMessage(message: string | undefined): ExplainedMessage | undefined {
  const raw = message?.trim() ?? ''
  if (!raw) return undefined
  const code = Object.keys(CODES).find((key) => new RegExp(`(?:^|[^a-z0-9-])${key}(?:$|[^a-z0-9-])`, 'u').test(raw))
  if (code) {
    const entry = CODES[code]
    if (entry) return { reason: entry.reason, ...(entry.action ? { action: entry.action } : {}), code, raw }
  }
  const unknown = MACHINE_CODE.exec(raw)?.[0]
  if (!HAS_CJK.test(raw)) {
    return {
      reason: '平台返回了一个未识别的问题',
      action: '展开诊断信息查看原始内容',
      ...(unknown ? { code: unknown } : {}),
      raw,
    }
  }
  if (unknown) {
    // Chinese prose that embeds a code (e.g. “引用未解析：some-code”): keep the prose, drop the code.
    const prose = raw
      .replace(unknown, '')
      .replace(/[：:，,\s]+$/u, '')
      .trim()
    return { reason: prose || '平台返回了一个未识别的问题', code: unknown, raw }
  }
  return { reason: raw, raw }
}

/** The user-facing state of one connection. */
export function connectionStatus(
  connection: Pick<ConnectionSummary, 'runtimeState' | 'lastError' | 'credentialConfigured' | 'userManaged'>,
): ConnectionStatusView {
  const explained = explainMessage(connection.lastError)
  const detail = explained?.raw
  const withDetail = detail ? { detail } : {}
  switch (connection.runtimeState) {
    case 'connected':
      // Connected accounts may still carry a passing notice (e.g. an unresolved quote); it does not change the state.
      return {
        health: 'ok',
        label: '正常',
        tone: 'ok',
        ...(explained ? { reason: explained.reason } : {}),
        ...(explained?.action ? { action: explained.action } : {}),
        ...withDetail,
      }
    case 'connecting':
    case 'reconnecting':
      return {
        health: 'connecting',
        label: '正在连接',
        tone: 'warn',
        reason: connection.runtimeState === 'reconnecting' ? '连接中断，正在重连' : '正在连接平台',
        ...withDetail,
      }
    case 'failed':
      return {
        health: 'attention',
        label: '需要处理',
        tone: 'bad',
        reason: explained?.reason ?? '连接失败',
        action: explained?.action ?? '检查连接设置，或重新登录',
        ...withDetail,
      }
    default:
      // A system-managed account that simply is not running is disabled; one stopped for a reason
      // (for example its adapter is no longer installed) still needs the user's attention.
      if (!connection.userManaged && !explained)
        return { health: 'disabled', label: '已停用', tone: 'neutral', ...withDetail }
      if (connection.userManaged && !connection.credentialConfigured) {
        return {
          health: 'attention',
          label: '需要处理',
          tone: 'bad',
          reason: '还没有保存登录凭据',
          action: '在连接设置中填写凭据，或重新登录',
          ...withDetail,
        }
      }
      return {
        health: 'attention',
        label: '需要处理',
        tone: 'bad',
        reason: explained?.reason ?? '账号没有在运行',
        action: explained?.action ?? '检查连接设置，或重新登录',
        ...withDetail,
      }
  }
}

/** Connection test results (“通过” or a message) shown as a short user-facing outcome. */
export function testOutcome(result: string): { readonly label: string; readonly tone: Tone; readonly detail?: string } {
  if (!result || result === '未测试') return { label: '未测试', tone: 'neutral' }
  if (result === '通过') return { label: '通过', tone: 'ok' }
  const explained = explainMessage(result)
  return {
    label: explained?.action ? `${explained.reason}，${explained.action}` : (explained?.reason ?? result),
    tone: 'bad',
    ...(explained && explained.raw !== explained.reason ? { detail: explained.raw } : {}),
  }
}
