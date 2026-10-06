import { useState, useSyncExternalStore } from 'react'
import { HostApiContracts, type HostUpgradeSummary, type RuntimeCompatibilityDiagnostic } from '@nekro-nxt/contracts'
import { saveChannelDraftRecovery } from '../../channel-draft-recovery.js'
import { callHostApi } from '../../host-api-client.js'
import { hostReleaseGuard } from '../../host-release-guard.js'
import { useProductRuntime, useProductStore } from '../../product-runtime.js'
import { hasUnsavedFormDrafts } from '../../unsaved-drafts.js'
import { Banner, Button, ConfirmDialog, toast } from '../../ui-kit/index.js'
import { useGo } from '../model/nav.js'
import styles from './system.module.css'

export interface CompatibilityFilter {
  readonly agentId?: string | undefined
  readonly providerId?: string | undefined
  readonly extensionId?: string | undefined
}

/** Extension diagnostics retain their activation owner in the public revision identity. */
const activationAgentId = (diagnostic: RuntimeCompatibilityDiagnostic): string | undefined => {
  if (diagnostic.objectKind !== 'extension') return undefined
  try {
    const revision: unknown = JSON.parse(diagnostic.configurationRevision)
    return Array.isArray(revision) && typeof revision[0] === 'string' ? revision[0] : undefined
  } catch {
    return undefined
  }
}

export const retryUpgradeDiagnostic = async (
  diagnostic: RuntimeCompatibilityDiagnostic,
  refreshSnapshot: () => Promise<void>,
): Promise<readonly RuntimeCompatibilityDiagnostic[]> => {
  const result = await callHostApi(
    HostApiContracts.retryRuntimeCompatibility,
    {},
    {
      objectKind: diagnostic.objectKind,
      objectId: diagnostic.objectId,
    },
  )
  await refreshSnapshot()
  return result.diagnostics
}

export const selectUpgradeDiagnostics = (
  summary: HostUpgradeSummary | undefined,
  filter: CompatibilityFilter,
): readonly RuntimeCompatibilityDiagnostic[] =>
  (summary?.diagnostics ?? []).filter((diagnostic) => {
    if (diagnostic.status !== 'isolated') return false
    if (filter.agentId) {
      return (
        (diagnostic.objectKind === 'agent' && diagnostic.objectId === filter.agentId) ||
        (diagnostic.objectKind === 'model-provider' && diagnostic.objectId === filter.providerId) ||
        activationAgentId(diagnostic) === filter.agentId
      )
    }
    if (filter.extensionId) {
      return ['extension', 'client-page'].includes(diagnostic.objectKind) && diagnostic.objectId === filter.extensionId
    }
    return true
  })

const repairPath = (diagnostic: RuntimeCompatibilityDiagnostic): string => {
  switch (diagnostic.objectKind) {
    case 'agent':
      return `/agents/${encodeURIComponent(diagnostic.objectId)}`
    case 'model-provider':
      return '/settings/models'
    case 'extension':
    case 'client-page':
      return `/workshop/extensions/${encodeURIComponent(diagnostic.objectId)}`
    case 'adapter':
      return '/settings/adapters'
    case 'dsh-plugin':
      return '/settings/dsh'
  }
}

const kindLabel: Record<RuntimeCompatibilityDiagnostic['objectKind'], string> = {
  agent: '智能体',
  'model-provider': '模型供应商',
  extension: '扩展',
  'dsh-plugin': 'DSH 插件',
  adapter: '适配器',
  'client-page': '扩展页面',
}

/**
 * After an engine upgrade: the archived-context notice and every object isolated by the compatibility check,
 * each with a way to repair or re-check it. Renders nothing when there is nothing to report.
 */
export function CompatibilityNotices(props: CompatibilityFilter & { readonly showContextReset?: boolean }) {
  const summary: HostUpgradeSummary | undefined = useProductStore((state) => state.upgrade)
  const agents = useProductStore((state) => state.agents)
  const extensions = useProductStore((state) => state.extensions)
  const models = useProductStore((state) => state.models)
  const { store } = useProductRuntime()
  const go = useGo()
  const [pending, setPending] = useState('')
  // The last failed re-check per object stays beside it until the next attempt.
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({})
  if (!summary) return null
  const diagnostics = selectUpgradeDiagnostics(summary, props)
  const showReset = summary.resetContexts && props.showContextReset === true
  if (!showReset && diagnostics.length === 0) return null

  const retry = async (diagnostic: RuntimeCompatibilityDiagnostic) => {
    const key = `${diagnostic.objectKind}:${diagnostic.objectId}`
    setPending(key)
    setFailures((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== key)))
    try {
      const remaining = (await retryUpgradeDiagnostic(diagnostic, () => store.getState().refreshHost())).find(
        (item) =>
          item.objectKind === diagnostic.objectKind &&
          item.objectId === diagnostic.objectId &&
          item.status === 'isolated',
      )
      if (remaining) setFailures((current) => ({ ...current, [key]: remaining.reason ?? '仍未通过兼容性检查。' }))
      else toast('已恢复运行')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFailures((current) => ({ ...current, [key]: message }))
    } finally {
      setPending('')
    }
  }

  return (
    <div className={styles.stack} data-compatibility-notices="">
      {showReset ? (
        <Banner tone="info">
          引擎已升级到 {summary.runtimeVersion}。旧上下文已归档，聊天记录保留；下一条消息开始新的上下文。
        </Banner>
      ) : null}
      {diagnostics.map((diagnostic) => {
        const key = `${diagnostic.objectKind}:${diagnostic.objectId}`
        const name =
          diagnostic.objectKind === 'agent'
            ? agents.find((agent) => agent.id === diagnostic.objectId)?.name
            : diagnostic.objectKind === 'model-provider'
              ? models.find((model) => model.provider === diagnostic.objectId)?.providerName
              : extensions.find((extension) => extension.id === diagnostic.objectId)?.name
        return (
          <Banner
            key={`${key}:${diagnostic.objectVersion}:${diagnostic.configurationRevision}`}
            tone="warn"
            action={
              diagnostic.retryable ? (
                <Button
                  size="small"
                  busy={pending === key}
                  disabled={pending !== ''}
                  onClick={() => void retry(diagnostic)}
                >
                  重新检查
                </Button>
              ) : (
                <Button size="small" onClick={() => go(repairPath(diagnostic))}>
                  查看
                </Button>
              )
            }
          >
            <b>{name?.trim() || kindLabel[diagnostic.objectKind]}已暂停</b>{' '}
            {diagnostic.reason ?? '当前版本尚未通过兼容性检查，配置已保留。'}
            {failures[key] ? (
              <span className={styles.failure} data-retry-error="">
                {failures[key]}
              </span>
            ) : null}
          </Banner>
        )
      })}
    </div>
  )
}

/** The Host stopped answering: the page keeps the last synchronized data and offers a reconnect. */
function HostConnectionBanner() {
  const { store } = useProductRuntime()
  const status = useProductStore((state) => state.host.status)
  const [pending, setPending] = useState(false)
  if (status !== 'stale' && status !== 'error') return null
  const reconnect = async () => {
    setPending(true)
    try {
      await store.getState().refreshHost()
    } catch (error) {
      toast(`重新连接失败：${error instanceof Error ? error.message : String(error)}`, { tone: 'bad' })
    } finally {
      setPending(false)
    }
  }
  return (
    <div className={styles.shellNotice} data-host-connection={status}>
      <Banner
        tone={status === 'stale' ? 'warn' : 'bad'}
        action={
          <Button size="small" busy={pending} onClick={() => void reconnect()}>
            重新连接
          </Button>
        }
      >
        <b>{status === 'stale' ? '连接不稳定' : '无法连接'}</b>{' '}
        {status === 'stale' ? '当前显示最近一次同步的数据。' : '当前内容可能为空或不是最新状态。'}
      </Banner>
    </div>
  )
}

/**
 * The shell's notice slot. A Host upgraded under this page comes first (writes are blocked until the page reloads
 * with the new client); otherwise a lost Host connection is shown.
 */
export function ReleaseBanner() {
  const state = useSyncExternalStore(
    hostReleaseGuard.subscribe,
    hostReleaseGuard.getSnapshot,
    hostReleaseGuard.getSnapshot,
  )
  const { uiStore } = useProductRuntime()
  const [confirm, setConfirm] = useState(false)
  if (!state.mismatch) return <HostConnectionBanner />
  const reload = () => {
    if (!saveChannelDraftRecovery(uiStore.getState().channelDrafts)) {
      throw new Error('浏览器无法暂存频道草稿，请先复制内容再刷新。')
    }
    window.location.reload()
  }
  return (
    <div className={styles.shellNotice} data-release-mismatch="">
      <Banner
        tone="warn"
        action={
          <Button
            size="small"
            variant="primary"
            onClick={() => {
              if (hasUnsavedFormDrafts()) setConfirm(true)
              else {
                try {
                  reload()
                } catch (error) {
                  toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
                }
              }
            }}
          >
            刷新
          </Button>
        }
      >
        <b>服务已升级</b> 刷新后继续操作，频道草稿会保留。
      </Banner>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="还有未保存的表单"
        confirmLabel="仍然刷新"
        onConfirm={reload}
      >
        频道草稿会在刷新后恢复；其他表单里未保存的输入会丢失，需要的话请先复制。
      </ConfirmDialog>
    </div>
  )
}
