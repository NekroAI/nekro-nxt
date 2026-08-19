import { useState } from 'react'
import { notify } from '../components/notifications.js'
import { useProductStore } from '../product-store.js'
import { ConfirmDialog, SelectField } from '../ui-kit/index.js'
import { isTriggerPolicy, TRIGGER_POLICY_OPTIONS, type TriggerPolicy } from './binding-task.js'

export type BindingChangeIntent =
  | { readonly kind: 'bind'; readonly channelId: string; readonly agentId: string }
  | { readonly kind: 'replace'; readonly channelId: string; readonly agentId: string }
  | { readonly kind: 'clear'; readonly channelId: string }

export function BindingChangeDialog({
  intent,
  onClose,
}: {
  readonly intent: BindingChangeIntent | undefined
  readonly onClose: () => void
}) {
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const [triggerPolicy, setTriggerPolicy] = useState<TriggerPolicy>('mentioned-or-replied')
  const channel = channels.find((item) => item.id === intent?.channelId)
  const target = intent && intent.kind !== 'clear' ? agents.find((item) => item.id === intent.agentId) : undefined
  const current = channel ? agents.find((item) => item.id === channel.agentId) : undefined
  const busy = channel?.runtimePhase === '思考中' || channel?.runtimePhase === '使用工具'
  const title =
    intent?.kind === 'bind' ? '交给智能体响应' : intent?.kind === 'replace' ? '改由其他智能体响应' : '解除频道绑定'
  const description =
    intent?.kind === 'bind'
      ? `将「${channel?.name ?? '频道'}」交给「${target?.name ?? '智能体'}」响应。消息记录保留；该智能体将按所选方式回复之后的新消息。`
      : intent?.kind === 'replace'
        ? `将「${channel?.name ?? '频道'}」改由「${target?.name ?? '智能体'}」响应。${busy ? '将中断当前思考和工具。' : '进行中的思考和工具会停止。'}消息记录保留。${target?.name ?? '新智能体'}不会接过上一智能体的工作记忆，将在之后的新消息上重新开始。`
        : `先停止「${current?.name ?? '智能体'}」在「${channel?.name ?? '频道'}」中的当前工作（如果有），再解除绑定。这个频道暂时没有智能体自动回复；消息记录保留。`

  return (
    <ConfirmDialog
      open={intent !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={title}
      description={description}
      confirmLabel={
        intent?.kind === 'clear'
          ? '停止并解除绑定'
          : intent?.kind === 'replace'
            ? '改由该智能体响应'
            : '交给该智能体响应'
      }
      onConfirm={async () => {
        if (!intent) return false
        try {
          if (intent.kind === 'clear') {
            await useProductStore.getState().clearBinding(intent.channelId)
            notify('已解除绑定。', 'success', `binding-clear:${intent.channelId}`)
          } else {
            await useProductStore.getState().createBinding({
              agentId: intent.agentId,
              channelId: intent.channelId,
              triggerPolicy:
                intent.kind === 'bind' ? triggerPolicy : (channel?.bindings[0]?.triggerPolicy ?? triggerPolicy),
            })
            notify(
              intent.kind === 'bind' ? '频道已交给该智能体响应。' : '频道已改由该智能体响应。',
              'success',
              `binding-change:${intent.channelId}`,
            )
          }
          return true
        } catch (error) {
          notify(error instanceof Error ? error.message : String(error), 'error', `binding-change:${intent.channelId}`)
          return false
        }
      }}
    >
      {intent?.kind === 'bind' ? (
        <SelectField
          label="响应方式"
          value={triggerPolicy}
          onValueChange={(value) => {
            if (isTriggerPolicy(value)) setTriggerPolicy(value)
          }}
          options={TRIGGER_POLICY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
        />
      ) : null}
    </ConfirmDialog>
  )
}
