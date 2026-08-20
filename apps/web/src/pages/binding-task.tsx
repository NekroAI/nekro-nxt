import { useEffect, useMemo, useState } from 'react'
import { notify } from '../components/notifications.js'
import { InlineFeedback } from '../components/product-feedback.js'
import {
  connectionDisplayName,
  useProductStore,
  type ChannelSummary,
  type ConnectionSummary,
} from '../product-store.js'
import { ConfirmDialog, SelectField } from '../ui-kit/index.js'
import styles from './product-pages.module.css'

export type TriggerPolicy = 'always' | 'mentioned-or-replied' | 'command' | 'observe-only'

export const TRIGGER_POLICY_OPTIONS: readonly { readonly value: TriggerPolicy; readonly label: string }[] = [
  { value: 'mentioned-or-replied', label: '被提及或回复时' },
  { value: 'always', label: '每条消息' },
  { value: 'command', label: '收到命令时' },
  { value: 'observe-only', label: '仅观察' },
]

export const isTriggerPolicy = (value: string): value is TriggerPolicy =>
  TRIGGER_POLICY_OPTIONS.some((option) => option.value === value)

export const bindingChannelLabel = (channel: ChannelSummary): string => `${channel.connectionName} · ${channel.name}`

export const listBindingChannels = (input: {
  readonly channels: readonly ChannelSummary[]
  readonly channelId?: string
  readonly connectionId?: string
  readonly excludeBoundToAgentId?: string
}): ChannelSummary[] => {
  if (input.channelId) {
    const locked = input.channels.find((channel) => channel.id === input.channelId)
    return locked ? [locked] : []
  }
  return input.channels.filter((channel) => {
    if (input.connectionId && channel.connectionId !== input.connectionId) return false
    if (
      input.excludeBoundToAgentId &&
      channel.bindings.some((binding) => binding.agentId === input.excludeBoundToAgentId)
    ) {
      return false
    }
    return true
  })
}

export function BindingTaskDialog({
  open,
  onOpenChange,
  agentId: lockedAgentId,
  channelId: lockedChannelId,
  connectionId,
  excludeBoundToAgentId,
  title,
  description,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly agentId?: string
  readonly channelId?: string
  readonly connectionId?: string
  readonly excludeBoundToAgentId?: string
  readonly title?: string
  readonly description?: string
}) {
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const connections = useProductStore((state) => state.connections)
  const candidates = useMemo(
    () =>
      listBindingChannels({
        channels,
        ...(lockedChannelId === undefined ? {} : { channelId: lockedChannelId }),
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(excludeBoundToAgentId === undefined ? {} : { excludeBoundToAgentId }),
      }),
    [channels, connectionId, excludeBoundToAgentId, lockedChannelId],
  )
  const [agentId, setAgentId] = useState(lockedAgentId ?? agents[0]?.id ?? '')
  const [channelId, setChannelId] = useState(lockedChannelId ?? candidates[0]?.id ?? '')
  const [triggerPolicy, setTriggerPolicy] = useState<TriggerPolicy>('mentioned-or-replied')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const nextAgent = lockedAgentId ?? agents[0]?.id ?? ''
    const nextChannels = listBindingChannels({
      channels,
      ...(lockedChannelId === undefined ? {} : { channelId: lockedChannelId }),
      ...(connectionId === undefined ? {} : { connectionId }),
      ...(excludeBoundToAgentId === undefined ? {} : { excludeBoundToAgentId }),
    })
    setAgentId(nextAgent)
    setChannelId(lockedChannelId ?? nextChannels[0]?.id ?? '')
    setTriggerPolicy('mentioned-or-replied')
    setError('')
  }, [agents, channels, connectionId, excludeBoundToAgentId, lockedAgentId, lockedChannelId, open])

  const selectedConnection = connectionId ? connections.find((connection) => connection.id === connectionId) : undefined
  const undiscovered = undiscoveredExternalConnections(connections, connectionId)
  const agentIsPreset = lockedAgentId !== undefined
  const channelIsPreset = lockedChannelId !== undefined
  const dialogTitle = title ?? (agentIsPreset && !channelIsPreset ? '新增频道绑定' : '绑定智能体')
  const dialogDescription =
    description ??
    (agentIsPreset && !channelIsPreset
      ? '一个智能体可以绑定多个频道；如果所选频道已绑定其他智能体，保存后该频道将改由当前智能体负责。'
      : '选择响应这个频道的智能体和触发方式。保存后不必离开当前页面。')

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={dialogTitle}
      description={dialogDescription}
      confirmLabel="绑定频道"
      onConfirm={async () => {
        if (!agentId) {
          setError('请先创建智能体，再绑定频道。')
          return false
        }
        if (!channelId) {
          setError('当前没有可绑定的频道。')
          return false
        }
        setError('')
        try {
          await useProductStore.getState().createBinding({ agentId, channelId, triggerPolicy })
          notify('频道已绑定。', 'success', `binding:${agentId}:${channelId}`)
          return true
        } catch (cause) {
          notify(cause instanceof Error ? cause.message : String(cause), 'error', `binding:${agentId}:${channelId}`)
          return false
        }
      }}
    >
      <div className={styles.formStack}>
        {lockedAgentId ? null : agents.length > 0 ? (
          <SelectField
            label="响应智能体"
            value={agentId}
            onValueChange={setAgentId}
            options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
          />
        ) : (
          <InlineFeedback tone="warning">请先创建智能体，再绑定频道。</InlineFeedback>
        )}
        {lockedChannelId ? null : candidates.length > 0 ? (
          <SelectField
            label="频道"
            value={channelId}
            onValueChange={setChannelId}
            options={candidates.map((channel) => ({
              value: channel.id,
              label: bindingChannelLabel(channel),
            }))}
          />
        ) : (
          <InlineFeedback tone="warning">
            {selectedConnection
              ? `${connectionDisplayName(selectedConnection)} 还没有可绑定的频道。请先向机器人账号发送一条消息。`
              : '当前没有可绑定的频道。'}
          </InlineFeedback>
        )}
        {agentId && channelId ? (
          <SelectField
            label="响应方式"
            value={triggerPolicy}
            onValueChange={(value) => {
              if (isTriggerPolicy(value)) setTriggerPolicy(value)
            }}
            options={TRIGGER_POLICY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          />
        ) : null}
        {undiscovered.map((connection) => (
          <InlineFeedback key={connection.id} tone="info">
            {connectionDisplayName(connection)} 尚未发现频道。请先向机器人账号发送一条消息。
          </InlineFeedback>
        ))}
        {error ? <InlineFeedback tone="error">{error}</InlineFeedback> : null}
      </div>
    </ConfirmDialog>
  )
}

const undiscoveredExternalConnections = (
  connections: readonly ConnectionSummary[],
  connectionId: string | undefined,
): ConnectionSummary[] =>
  connections.filter(
    (connection) =>
      connection.adapterKey !== 'web' &&
      connection.knownChannels.length === 0 &&
      (connectionId === undefined || connection.id === connectionId),
  )
