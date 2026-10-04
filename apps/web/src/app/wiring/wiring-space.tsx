import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { connectionDisplayName, useProductStore } from '../../product-runtime.js'
import { Panel, Select } from '../../ui-kit/next/index.js'
import { BindDialog, type BindIntent } from '../channels/bind-dialog.js'
import { useCrumb } from '../shell/crumb.js'
import { WiringDetail } from './detail.js'
import { PatchBay } from './patch-bay.js'
import styles from './wiring.module.css'

type Selection = { readonly kind: 'connection' | 'channel'; readonly id: string }

const parseSelection = (rest: string): Selection | undefined => {
  const [segment, id] = rest.split('/')
  if (!id) return undefined
  if (segment === 'connections') return { kind: 'connection', id }
  if (segment === 'channels') return { kind: 'channel', id }
  return undefined
}

/** Narrow screens: the same binding relation as a list with one picker per channel. */
function CompactBindings() {
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const connections = useProductStore((state) => state.connections)
  const [intent, setIntent] = useState<BindIntent | null>(null)
  return (
    <div className={styles.compact}>
      <Panel>
        {channels.map((channel) => {
          const connection = connections.find((item) => item.id === channel.connectionId)
          return (
            <div key={channel.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 130px', gap: 10, alignItems: 'center', padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{channel.name}</div>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>{connection ? connectionDisplayName(connection) : channel.connectionName}</div>
              </div>
              <Select
                aria-label={`${channel.name} 的响应智能体`}
                value={channel.agentId}
                options={[{ value: '', label: '未接线' }, ...agents.map((agent) => ({ value: agent.id, label: agent.name }))]}
                onChange={(event) => {
                  const agentId = event.target.value
                  if (!agentId) setIntent({ kind: 'unbind', channelId: channel.id })
                  else setIntent({ kind: channel.agentId ? 'replace' : 'bind', channelId: channel.id, agentId })
                }}
              />
            </div>
          )
        })}
      </Panel>
      <BindDialog intent={intent} onClose={() => setIntent(null)} />
    </div>
  )
}

export default function WiringSpace() {
  const { '*': rest = '' } = useParams()
  const connections = useProductStore((state) => state.connections)
  const channels = useProductStore((state) => state.channels)
  const parsed = parseSelection(rest)
  const fallback = connections.find((connection) => connection.userManaged) ?? connections[0]
  const selected: Selection | undefined = parsed ?? (fallback ? { kind: 'connection', id: fallback.id } : undefined)
  const selectedName =
    selected?.kind === 'connection'
      ? connections.find((item) => item.id === selected.id)
      : undefined
  useCrumb(
    '接线',
    selectedName ? connectionDisplayName(selectedName) : selected?.kind === 'channel' ? channels.find((item) => item.id === selected.id)?.name : undefined,
  )
  return (
    <div className={styles.space}>
      <div className={styles.board}>
        <h1 className={styles.title}>接线</h1>
        <PatchBay selected={selected} />
        <CompactBindings />
      </div>
      <WiringDetail selected={selected} />
    </div>
  )
}
