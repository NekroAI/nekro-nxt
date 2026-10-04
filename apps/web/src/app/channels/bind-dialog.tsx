import { useEffect, useState, type CSSProperties } from 'react'
import { connectionDisplayName, useProductStore } from '../../product-runtime.js'
import { AgentAvatar, ConfirmDialog, Field, Select, toast } from '../../ui-kit/next/index.js'
import { agentAccent, agentHue, triggerLabel } from '../model/identity.js'
import { useProductApi } from '../model/store.js'
import styles from './channels.module.css'

export type BindIntent =
  | { readonly kind: 'bind' | 'replace'; readonly channelId: string; readonly agentId: string }
  | { readonly kind: 'unbind'; readonly channelId: string }

type TriggerPolicy = 'always' | 'mentioned-or-replied' | 'command' | 'observe-only'
const triggerOptions = (['mentioned-or-replied', 'always', 'command', 'observe-only'] as const).map((value) => ({
  value,
  label: triggerLabel[value] ?? value,
}))

/** Shared confirmation for binding, rebinding and unbinding a channel (drag, inspector and wiring all use it). */
export function BindDialog({ intent, onClose }: { readonly intent: BindIntent | null; readonly onClose: () => void }) {
  const api = useProductApi()
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const connections = useProductStore((state) => state.connections)
  const channel = intent ? channels.find((item) => item.id === intent.channelId) : undefined
  const current = channel?.bindings[0]
  const previousAgent = current ? agents.find((agent) => agent.id === current.agentId) : undefined
  const nextAgent = intent && intent.kind !== 'unbind' ? agents.find((agent) => agent.id === intent.agentId) : undefined
  const connection = channel ? connections.find((item) => item.id === channel.connectionId) : undefined
  const [trigger, setTrigger] = useState<TriggerPolicy>('mentioned-or-replied')
  useEffect(() => {
    setTrigger(current?.triggerPolicy ?? (channel?.kind === 'internal' ? 'always' : 'mentioned-or-replied'))
  }, [intent, current?.triggerPolicy, channel?.kind])

  if (!intent || !channel) return <ConfirmDialog open={false} onOpenChange={onClose} title="" confirmLabel="" onConfirm={() => undefined} />

  if (intent.kind === 'unbind') {
    return (
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={`断开「${channel.name}」${previousAgent ? `与${previousAgent.name}` : ''}？`}
        confirmLabel="断开"
        danger
        onConfirm={async () => {
          await api.getState().clearBinding(channel.id)
          toast(`「${channel.name}」已断开`)
        }}
      >
        <p>{previousAgent ? `${previousAgent.name}会先停止在这里的工作。` : ''}聊天记录会保留。</p>
      </ConfirmDialog>
    )
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`让${nextAgent?.name ?? '智能体'}响应「${channel.name}」`}
      confirmLabel={intent.kind === 'replace' ? '换绑' : '接线'}
      onConfirm={async () => {
        if (!nextAgent) throw new Error('智能体已不存在。')
        await api.getState().createBinding({ agentId: nextAgent.id, channelId: channel.id, triggerPolicy: trigger })
        toast(`「${channel.name}」已交给${nextAgent.name}`)
      }}
    >
      <div className={styles.wirePreview} style={nextAgent ? ({ '--wire-accent': agentAccent(nextAgent) } as CSSProperties) : undefined}>
        <b>{channel.name}</b>
        <span className="muted" style={{ color: 'var(--muted)', fontSize: 12 }}>
          {connection ? connectionDisplayName(connection) : channel.connectionName}
        </span>
        <span className={styles.wireLine} />
        {previousAgent ? <span className={styles.strike}>{previousAgent.name}</span> : null}
        {nextAgent ? <AgentAvatar name={nextAgent.name} hue={agentHue(nextAgent)} size="sm" /> : null}
        <b>{nextAgent?.name}</b>
      </div>
      <Field label="触发">
        <Select value={trigger} options={triggerOptions} onChange={(event) => setTrigger(event.target.value as TriggerPolicy)} />
      </Field>
    </ConfirmDialog>
  )
}
