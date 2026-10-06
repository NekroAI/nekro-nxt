import { isLlmProviderRemoved, removeLlmProviderAndReconcile } from './llm-provider-removal-request.js'
import { useEffect, useRef, useState } from 'react'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from './host-api-client.js'
import { providerDisplayName } from './provider-labels.js'
import { Banner, Button, Dialog, Spinner } from './ui-kit/index.js'
import styles from './llm-settings.module.css'

type RemovalImpact = HostApiResponse<'llmProviderRemovalImpact'>

/**
 * Removal always starts from a fresh impact preview; a failed commit drops the preview so the next confirmation is
 * never blind.
 */
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
      setImpact(null)
    } finally {
      if (mounted.current) setPending(null)
    }
  }
  const action = impact?.declared ? '删除供应商' : '移除配置'
  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open && pending !== 'delete') onClose()
      }}
      title="检查供应商移除影响"
      actions={
        <>
          <Button variant="ghost" disabled={pending === 'delete'} onClick={onClose}>
            取消
          </Button>
          <Button disabled={pending !== null} onClick={() => setRefresh((value) => value + 1)}>
            重新检查影响
          </Button>
          <Button
            variant="danger-solid"
            busy={pending === 'delete'}
            disabled={!impact || Boolean(impact.blockedReason) || pending !== null}
            onClick={() => void remove()}
          >
            确认{action}
          </Button>
        </>
      }
    >
      <div className={styles.removal}>
        {pending === 'preview' ? (
          <p className={styles.muted} role="status">
            <Spinner /> 正在检查影响…
          </p>
        ) : null}
        {error ? (
          <p className={styles.fieldError} role="alert">
            {error}
          </p>
        ) : null}
        {impact ? (
          <>
            <p>
              <strong>{providerDisplayName(impact.provider, impact.displayName)}</strong>
              {impact.declared
                ? '：删除这个自定义供应商的名称、地址、协议和模型。之后需要重新添加。'
                : '：移除已保存的配置。供应商仍留在目录里，之后可以从“添加供应商”重新配置。'}
            </p>
            <div className={styles.removalBlock}>
              <span className={styles.removalTitle}>涉及的模型（{impact.models.length}）</span>
              <div className={styles.chipList}>
                {impact.models.map((model) => (
                  <span className={styles.tag} key={model}>
                    {model}
                  </span>
                ))}
              </div>
            </div>
            <div className={styles.removalBlock}>
              <span className={styles.removalTitle}>引用它的智能体与频道（{impact.references.length}）</span>
              {impact.references.length === 0 ? (
                <p className={styles.muted}>没有智能体当前配置或活动频道上下文引用此供应商。</p>
              ) : (
                <ul className={styles.referenceList}>
                  {impact.references.map((reference, index) => (
                    <li key={`${reference.agentId}:${reference.channelId ?? 'config'}:${reference.role}:${index}`}>
                      <strong>{reference.displayName}</strong>
                      <span className={styles.muted}>
                        {reference.role === 'primary' ? '主模型' : '看图模型'} · {reference.model}
                      </span>
                      <span className={styles.muted}>
                        {reference.scope === 'configuration'
                          ? '智能体当前配置'
                          : `频道“${reference.channelName}”的${reference.episodeStatus === 'opening' ? '建立中' : '活动'}上下文（可能仍使用旧配置）`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className={styles.muted}>
              API
              密钥保留在本机凭据存储，不会删除，以免影响共用密钥的其他供应商或功能。智能体配置、频道绑定和聊天记录也不会删除。
            </p>
            {impact.blockedReason ? (
              <Banner tone="bad">{impact.blockedReason}</Banner>
            ) : (
              <p>确认后，此供应商及其模型将退出可用列表。</p>
            )}
          </>
        ) : null}
      </div>
    </Dialog>
  )
}
