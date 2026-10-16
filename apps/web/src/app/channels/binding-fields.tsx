import type { ReactNode } from 'react'
import { useProductStore, type ChannelSummary } from '../../product-runtime.js'
import { PropertyRow, Select, toast } from '../../ui-kit/index.js'
import { isTriggerPolicy, triggerLabel, type TriggerPolicy } from '../model/identity.js'
import { useProductApi } from '../model/store.js'
import type { BindIntent } from './bind-dialog.js'

/**
 * Who answers a channel and when (interaction model §1.2). Wiring, the agent page and the channel inspector all edit
 * a binding with these controls, so the choices, words and consequences are the same wherever it is changed.
 */
export const TRIGGERS = ['mentioned-or-replied', 'always', 'command', 'observe-only'] as const

/** What each trigger policy means in practice (packages/channel-runtime shouldTrigger). */
export const triggerHint: Record<TriggerPolicy, string> = {
  always: '频道里的每条消息都会交给它处理',
  'mentioned-or-replied': '有人 @它或回复它的消息时',
  command: '平台上报原生命令事件时（不是这里的聊天命令）',
  'observe-only': '长期只记录消息、不回复；临时停一下请用暂停回应',
}

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

/** The agent answering the channel; choosing another one or none goes through the bind dialog's confirmation. */
export function ResponderSelect({
  channel,
  onIntent,
}: {
  readonly channel: Pick<ChannelSummary, 'id' | 'name' | 'agentId'>
  readonly onIntent: (intent: BindIntent) => void
}) {
  const agents = useProductStore((state) => state.agents)
  const current = agents.find((item) => item.id === channel.agentId)
  return (
    <Select
      aria-label={`${channel.name} 的响应智能体`}
      value={current?.id ?? ''}
      {...(current ? {} : { placeholder: '选择智能体' })}
      options={[
        ...agents.map((item) => ({ value: item.id, label: item.name })),
        ...(current ? [{ value: '', label: '不回复' }] : []),
      ]}
      onValueChange={(value) => {
        if (value === (current?.id ?? '')) return
        if (!value) onIntent({ kind: 'unbind', channelId: channel.id })
        else onIntent({ kind: current ? 'replace' : 'bind', channelId: channel.id, agentId: value })
      }}
    />
  )
}

/** When the bound agent answers; takes effect at once. */
export function TriggerSelect({ channel }: { readonly channel: Pick<ChannelSummary, 'id' | 'name' | 'bindings'> }) {
  const api = useProductApi()
  const binding = channel.bindings[0]
  if (!binding) return null
  return (
    <Select
      aria-label={`${channel.name} 的触发方式`}
      value={binding.triggerPolicy}
      options={TRIGGERS.map((value) => ({ value, label: triggerLabel[value] ?? value }))}
      onValueChange={(value) => {
        if (!isTriggerPolicy(value) || value === binding.triggerPolicy) return
        void api
          .getState()
          .createBinding({ agentId: binding.agentId, channelId: channel.id, triggerPolicy: value })
          .then(() => toast(`何时回复改为“${triggerLabel[value]}”`))
          .catch(failure)
      }}
    />
  )
}

/** The two rows of a binding: the responding agent and when it answers. */
export function BindingRows({
  channel,
  onIntent,
  responderExtra,
  responderDescription,
}: {
  readonly channel: Pick<ChannelSummary, 'id' | 'name' | 'agentId' | 'bindings'>
  readonly onIntent: (intent: BindIntent) => void
  /** Next to the agent select, e.g. a link to the agent's page. */
  readonly responderExtra?: ReactNode
  /** Under the agent's name, e.g. its model; defaults to saying nobody answers yet. */
  readonly responderDescription?: ReactNode
}) {
  const binding = channel.bindings[0]
  const unanswered = !channel.agentId
  return (
    <>
      <PropertyRow
        label="智能体"
        description={responderDescription ?? (unanswered ? '还没有智能体回复这个频道' : undefined)}
      >
        <ResponderSelect channel={channel} onIntent={onIntent} />
        {responderExtra}
      </PropertyRow>
      {channel.agentId && binding ? (
        <PropertyRow label="何时回复" description={triggerHint[binding.triggerPolicy]}>
          <TriggerSelect channel={channel} />
        </PropertyRow>
      ) : null}
    </>
  )
}
