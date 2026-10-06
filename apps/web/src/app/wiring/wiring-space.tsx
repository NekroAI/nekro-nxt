import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { connectionDisplayName, useProductStore } from '../../product-runtime.js'
import {
  Button,
  MainContent,
  PropertyList,
  SearchField,
  Segmented,
  Select,
  Toolbar,
  WorkbenchPage,
} from '../../ui-kit/next/index.js'
import { BindDialog, type BindIntent } from '../channels/bind-dialog.js'
import { useGo } from '../model/nav.js'
import { useCrumb } from '../shell/crumb.js'
import { ConnectionCreate } from './connection-create.js'
import { WiringDetail } from './detail.js'
import { PatchBay, type WiringSelection } from './patch-bay.js'
import styles from './wiring.module.css'

const parseSelection = (rest: string): WiringSelection | undefined => {
  const [segment, id] = rest.split('/')
  if (!id) return undefined
  if (segment === 'connections') return { kind: 'connection', id }
  if (segment === 'channels') return { kind: 'channel', id }
  if (segment === 'agents') return { kind: 'agent', id }
  return undefined
}

/** Narrow windows: the same binding relation as a list with one picker per channel. */
function CompactBindings() {
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const connections = useProductStore((state) => state.connections)
  const [intent, setIntent] = useState<BindIntent | null>(null)
  return (
    <div className={styles.compact}>
      <PropertyList>
        {channels.map((channel) => {
          const connection = connections.find((item) => item.id === channel.connectionId)
          return (
            <div key={channel.id} className={styles.compactRow}>
              <div className={styles.compactText}>
                <span className={styles.listName}>{channel.name}</span>
                <span className={styles.listMeta}>
                  {connection ? connectionDisplayName(connection) : channel.connectionName}
                </span>
              </div>
              <Select
                aria-label={`${channel.name} 的响应智能体`}
                value={channel.agentId}
                options={[
                  { value: '', label: '未接线' },
                  ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
                ]}
                onChange={(event) => {
                  const agentId = event.target.value
                  if (!agentId) setIntent({ kind: 'unbind', channelId: channel.id })
                  else setIntent({ kind: channel.agentId ? 'replace' : 'bind', channelId: channel.id, agentId })
                }}
              />
            </div>
          )
        })}
      </PropertyList>
      <BindDialog intent={intent} onClose={() => setIntent(null)} />
    </div>
  )
}

export default function WiringSpace() {
  const { '*': rest = '' } = useParams()
  const connections = useProductStore((state) => state.connections)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const go = useGo()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'free'>('all')
  const filter = useMemo(() => ({ query, freeOnly: scope === 'free' }), [query, scope])
  const creating = rest === 'new' || rest.startsWith('new/')
  const parsed = parseSelection(rest)
  const fallback = connections.find((connection) => connection.userManaged) ?? connections[0]
  const selected: WiringSelection | undefined =
    parsed ?? (fallback ? { kind: 'connection', id: fallback.id } : undefined)
  const crumb = selected?.kind === 'connection' ? connections.find((item) => item.id === selected.id) : undefined
  useCrumb(
    '接线',
    creating
      ? '添加账号'
      : crumb
        ? connectionDisplayName(crumb)
        : selected?.kind === 'channel'
          ? channels.find((item) => item.id === selected.id)?.name
          : selected?.kind === 'agent'
            ? agents.find((item) => item.id === selected.id)?.name
            : undefined,
  )
  if (creating) return <ConnectionCreate />
  return (
    <WorkbenchPage detail={<WiringDetail selected={selected} />}>
      <MainContent>
        <header className={styles.head}>
          <h1 className={styles.title}>接线</h1>
          <Button size="small" icon={<Plus size={14} />} onClick={() => go('/wiring/new')}>
            添加账号
          </Button>
        </header>
        <Toolbar>
          <div className={styles.search}>
            <SearchField value={query} onChange={setQuery} placeholder="搜索频道、账号或智能体" label="搜索频道" />
          </div>
          <Segmented
            label="频道范围"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: '全部频道' },
              { value: 'free', label: '只看未接线' },
            ]}
          />
        </Toolbar>
        <div className={styles.board}>
          <PatchBay selected={selected} filter={filter} />
          <CompactBindings />
        </div>
      </MainContent>
    </WorkbenchPage>
  )
}
