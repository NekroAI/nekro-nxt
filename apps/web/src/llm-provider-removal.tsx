import { isLlmProviderRemoved, removeLlmProviderAndReconcile } from './llm-provider-removal-request.js'
import { useEffect, useRef, useState } from 'react'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from './host-api-client.js'
import { providerDisplayName } from './provider-labels.js'
import { Button, Dialog } from './ui-kit/index.js'
import styles from './llm-settings.module.css'

type RemovalImpact = HostApiResponse<'llmProviderRemovalImpact'>

export function LlmProviderRemovalDialog({
  provider,
  onClose,
  onRemoved,
}: {
  readonly provider: string
  readonly onClose: () => void
  readonly onRemoved: (settings: HostApiResponse<'llmProviders'>) => void
}) {
  const [impact, setImpact] = useState<RemovalImpact | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<'preview' | 'delete' | null>('preview')
  const [refresh, setRefresh] = useState(0)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setPending('preview')
    setImpact(null)
    setError('')
    void callHostApi(HostApiContracts.llmProviders, {}, undefined, { signal: controller.signal })
      .then(async (settings) => {
        if (!active) return
        if (isLlmProviderRemoved(settings, provider)) {
          onRemoved(settings)
          return
        }
        const result = await callHostApi(HostApiContracts.llmProviderRemovalImpact, { provider }, undefined, {
          signal: controller.signal,
        })
        if (active) setImpact(result)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setPending(null)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [provider, refresh])
  const remove = async (): Promise<void> => {
    if (!impact || impact.blockedReason || pending) return
    setPending('delete')
    setError('')
    try {
      const next = await removeLlmProviderAndReconcile(provider, impact.expectedRevision)
      if (mounted.current) onRemoved(next)
    } catch (cause) {
      if (!mounted.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
      // A failed commit requires a fresh preview, never another blind confirmation.
      setImpact(null)
    } finally {
      if (mounted.current) setPending(null)
    }
  }
  const action = impact?.declared ? '删除供应商' : '移除配置'
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title="检查供应商移除影响"
      description="确认前请检查模型、智能体和频道上下文的影响。"
      pending={pending === 'delete'}
      footer={
        <>
          <Button variant="ghost" disabled={pending === 'delete'} onClick={onClose}>
            取消
          </Button>
          <Button disabled={pending !== null} onClick={() => setRefresh((value) => value + 1)}>
            重新检查影响
          </Button>
          <Button
            variant="danger"
            loading={pending === 'delete'}
            loadingLabel="移除中…"
            disabled={!impact || Boolean(impact.blockedReason) || pending !== null}
            onClick={() => void remove()}
          >
            确认{action}
          </Button>
        </>
      }
    >
      <div className={styles.removalImpact}>
        {pending === 'preview' ? <p role="status">正在检查影响…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {impact ? (
          <>
            <p>
              <strong>{providerDisplayName(impact.provider, impact.displayName)}</strong>（{impact.provider}）
            </p>
            <p>
              {impact.declared
                ? '删除此自定义供应商的名称、地址、协议和模型配置。恢复时需要重新添加。'
                : '移除此供应商的已保存配置。内置目录项会保留，之后可从“添加供应商”重新配置。'}
            </p>
            <div>
              <strong>涉及的模型（{impact.models.length}）</strong>
              <div className={styles.modelList}>
                {impact.models.map((model) => (
                  <span key={model}>{model}</span>
                ))}
              </div>
            </div>
            <p>
              API
              密钥保留在本机凭据存储，不会删除，以免影响共用密钥的其他供应商或功能。智能体配置、频道绑定和聊天记录不会删除。
            </p>
            <div>
              <strong>智能体与频道引用（{impact.references.length}）</strong>
              {impact.references.length === 0 ? (
                <p>没有智能体当前配置或活动频道上下文引用此供应商。</p>
              ) : (
                <ul>
                  {impact.references.map((reference, index) => (
                    <li key={`${reference.agentId}:${reference.channelId ?? 'config'}:${reference.role}:${index}`}>
                      <strong>{reference.displayName}</strong> ·{' '}
                      {reference.role === 'primary' ? '主模型' : '辅助视觉模型'} · {reference.model}
                      <br />
                      {reference.scope === 'configuration'
                        ? '智能体当前配置'
                        : `频道“${reference.channelName}”的${reference.episodeStatus === 'opening' ? '建立中' : '活动'}上下文（可能仍使用旧配置）`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {impact.blockedReason ? (
              <p role="alert">{impact.blockedReason}</p>
            ) : (
              <p>确认后，此供应商及其模型将退出可用列表。</p>
            )}
          </>
        ) : null}
      </div>
    </Dialog>
  )
}
