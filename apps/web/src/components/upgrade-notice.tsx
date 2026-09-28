import { useState } from 'react'
import { callHostApi } from '../host-api-client.js'
import { Button } from '../ui-kit/index.js'
import { notify } from './notifications.js'
import { HostApiContracts, type HostUpgradeSummary, type RuntimeCompatibilityDiagnostic } from '@nekro-nxt/contracts'
import { useProductRuntime, useProductStore } from '../product-runtime.js'
import { NxtLink } from '../shell/nxt-link.js'
import { InlineFeedback } from './product-feedback.js'

export interface UpgradeNoticeProps {
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
  filter: UpgradeNoticeProps,
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
  if (diagnostic.objectKind === 'agent') return `/work/agents/${encodeURIComponent(diagnostic.objectId)}`
  if (diagnostic.objectKind === 'model-provider') return '/settings?tab=models'
  if (diagnostic.objectKind === 'extension' || diagnostic.objectKind === 'client-page')
    return `/extensions/${encodeURIComponent(diagnostic.objectId)}`
  if (diagnostic.objectKind === 'adapter') return '/connections'
  return '/settings?tab=dsh-extensions'
}
const kindLabel: Record<RuntimeCompatibilityDiagnostic['objectKind'], string> = {
  agent: '智能体',
  'model-provider': '模型供应商',
  extension: '扩展',
  'dsh-plugin': 'DSH 扩展',
  adapter: '适配器',
  'client-page': '扩展页面',
}

export function UpgradeNotice(props: UpgradeNoticeProps) {
  const summary = useProductStore((state) => state.upgrade)
  const agents = useProductStore((state) => state.agents)
  const extensions = useProductStore((state) => state.extensions)
  const models = useProductStore((state) => state.models)
  const { store } = useProductRuntime()
  const [pending, setPending] = useState<string>()
  const [retryError, setRetryError] = useState<{ key: string; message: string }>()
  const retry = async (diagnostic: RuntimeCompatibilityDiagnostic): Promise<void> => {
    if (pending) return
    const key = `${diagnostic.objectKind}:${diagnostic.objectId}`
    setPending(key)
    setRetryError(undefined)
    try {
      const diagnostics = await retryUpgradeDiagnostic(diagnostic, () => store.getState().refreshHost())
      const remaining = diagnostics.find(
        (item) =>
          item.objectKind === diagnostic.objectKind &&
          item.objectId === diagnostic.objectId &&
          item.status === 'isolated',
      )
      if (remaining) setRetryError({ key, message: remaining.reason ?? '检查完成，当前配置仍未通过兼容性检查。' })
      else notify('兼容性检查完成，已更新运行状态。', 'success', `compatibility:${key}`)
    } catch (cause) {
      setRetryError({ key, message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setPending(undefined)
    }
  }
  if (!summary) return null
  const diagnostics = selectUpgradeDiagnostics(summary, props)
  const showReset = summary.resetContexts && !props.extensionId
  if (!showReset && diagnostics.length === 0) return null
  return (
    <div data-upgrade-notice="">
      {showReset ? (
        <InlineFeedback tone="info">
          引擎已升级到 {summary.runtimeVersion}
          。旧上下文已归档，聊天记录已保留；下一条新消息会开始新的上下文，升级前未完成的运行不会自动继续。
        </InlineFeedback>
      ) : null}
      {diagnostics.map((diagnostic) => {
        const name =
          diagnostic.objectKind === 'agent'
            ? agents.find((agent) => agent.id === diagnostic.objectId)?.name
            : diagnostic.objectKind === 'model-provider'
              ? models.find((model) => model.provider === diagnostic.objectId)?.providerName
              : extensions.find((extension) => extension.id === diagnostic.objectId)?.name
        return (
          <InlineFeedback
            tone="warning"
            key={`${diagnostic.objectKind}:${diagnostic.objectId}:${diagnostic.objectVersion}:${diagnostic.configurationRevision}`}
          >
            <strong>{name?.trim() || kindLabel[diagnostic.objectKind]}已暂停</strong>
            <p>{diagnostic.reason ?? '当前版本尚未通过兼容性检查。安装与配置记录已保留。'}</p>
            <NxtLink to={repairPath(diagnostic)}>
              {diagnostic.objectKind === 'extension' || diagnostic.objectKind === 'client-page'
                ? '查看扩展并重新构建'
                : '查看配置与诊断'}
            </NxtLink>
            {diagnostic.retryable ? (
              <Button
                size="small"
                disabled={pending !== undefined}
                loading={pending === `${diagnostic.objectKind}:${diagnostic.objectId}`}
                loadingLabel="正在检查…"
                onClick={() => void retry(diagnostic)}
              >
                重新检查兼容性
              </Button>
            ) : null}
            {retryError?.key === `${diagnostic.objectKind}:${diagnostic.objectId}` ? (
              <p role="alert">{retryError.message}</p>
            ) : null}
          </InlineFeedback>
        )
      })}
    </div>
  )
}
