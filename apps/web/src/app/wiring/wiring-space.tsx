import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { connectionDisplayName, useProductStore } from '../../product-runtime.js'
import {
  Button,
  MainContent,
  Pressable,
  PropertyGroup,
  PropertyList,
  SearchField,
  PageHeader,
  ToggleChip,
  Select,
  WorkbenchPage,
} from '../../ui-kit/index.js'
import { BindDialog, type BindIntent } from '../channels/bind-dialog.js'
import { useGo } from '../model/nav.js'
import { useCrumb } from '../shell/crumb.js'
import { ConnectionCreate } from './connection-create.js'
import { ConnectionEdit } from './connection-edit.js'
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
function CompactBindings({ query, freeOnly }: { readonly query: string; readonly freeOnly: boolean }) {
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const connections = useProductStore((state) => state.connections)
  const [intent, setIntent] = useState<BindIntent | null>(null)
  const go = useGo()
  const needle = query.trim().toLowerCase()
  const matches = (name: string) => name.toLowerCase().includes(needle)
  return (
    <div className={styles.compact}>
      <PropertyGroup title="平台账号">
        <PropertyList>
          {connections
            .filter((connection) => matches(connectionDisplayName(connection)))
            .map((connection) => (
              <Pressable
                className={styles.listRow}
                key={connection.id}
                onClick={() => go(`/wiring/connections/${connection.id}`)}
              >
                {connectionDisplayName(connection)}
              </Pressable>
            ))}
        </PropertyList>
      </PropertyGroup>
      <PropertyGroup title="频道">
        <PropertyList>
          {channels
            .filter((channel) => (!freeOnly || !channel.agentId) && matches(channel.name))
            .map((channel) => {
              const connection = connections.find((item) => item.id === channel.connectionId)
              return (
                <div key={channel.id} className={styles.compactRow}>
                  <Pressable className={styles.compactText} onClick={() => go(`/wiring/channels/${channel.id}`)}>
                    <span className={styles.listName}>{channel.name}</span>
                    <span className={styles.listMeta}>
                      {connection ? connectionDisplayName(connection) : channel.connectionName}
                    </span>
                  </Pressable>
                  <Select
                    aria-label={`${channel.name} 的响应智能体`}
                    value={channel.agentId}
                    options={[
                      { value: '', label: '未接线' },
                      ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
                    ]}
                    onValueChange={(value) => {
                      const agentId = value
                      if (!agentId) setIntent({ kind: 'unbind', channelId: channel.id })
                      else setIntent({ kind: channel.agentId ? 'replace' : 'bind', channelId: channel.id, agentId })
                    }}
                  />
                </div>
              )
            })}
        </PropertyList>
      </PropertyGroup>
      <PropertyGroup title="智能体">
        <PropertyList>
          {agents
            .filter((agent) => matches(agent.name))
            .map((agent) => (
              <Pressable className={styles.listRow} key={agent.id} onClick={() => go(`/wiring/agents/${agent.id}`)}>
                {agent.name}
              </Pressable>
            ))}
        </PropertyList>
      </PropertyGroup>
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
  const selected =
    parsed &&
    (parsed.kind === 'connection'
      ? connections.some((item) => item.id === parsed.id)
      : parsed.kind === 'channel'
        ? channels.some((item) => item.id === parsed.id)
        : agents.some((item) => item.id === parsed.id))
      ? parsed
      : undefined
  const crumb = selected?.kind === 'connection' ? connections.find((item) => item.id === selected.id) : undefined
  useCrumb(
    '接线',
    creating
      ? '添加平台账号'
      : crumb
        ? connectionDisplayName(crumb)
        : selected?.kind === 'channel'
          ? channels.find((item) => item.id === selected.id)?.name
          : selected?.kind === 'agent'
            ? agents.find((item) => item.id === selected.id)?.name
            : undefined,
  )
  if (creating) return <ConnectionCreate />
  if (rest.endsWith('/edit') && crumb?.userManaged) return <ConnectionEdit key={crumb.id} connection={crumb} />
  return (
    <WorkbenchPage
      narrowPane={selected ? 'detail' : 'main'}
      detail={selected ? <WiringDetail selected={selected} onClose={() => go('/wiring')} /> : undefined}
    >
      <MainContent width="full" fill>
        <div className={styles.head}>
          <PageHeader
            title="接线"
            actions={
              <Button size="small" icon={<Plus size={14} />} onClick={() => go('/wiring/new')}>
                添加平台账号
              </Button>
            }
          />
          <div className={styles.toolbar}>
            <div className={styles.search}>
              <SearchField value={query} onChange={setQuery} placeholder="搜索频道、账号或智能体" label="搜索频道" />
            </div>
            <ToggleChip pressed={scope === 'free'} onPressedChange={(free) => setScope(free ? 'free' : 'all')}>
              只看未接线
            </ToggleChip>
          </div>
        </div>
        <div className={styles.board}>
          <PatchBay selected={selected} filter={filter} />
          <CompactBindings query={query} freeOnly={scope === 'free'} />
        </div>
      </MainContent>
    </WorkbenchPage>
  )
}
