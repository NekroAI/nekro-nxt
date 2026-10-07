import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { useProductStore } from '../../product-runtime.js'
import { AgentAvatar, IconButton, ListPane, SearchField, SelectionList, WorkbenchPage } from '../../ui-kit/index.js'
import { agentAccent, agentHue, agentPhase, isAgentWorking } from '../model/identity.js'
import { useGo } from '../model/nav.js'
import { useCrumb } from '../shell/crumb.js'
import { AgentCreate } from './agent-create.js'
import { AgentProfile } from './agent-profile.js'
import styles from './agents.module.css'

export default function AgentsSpace() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useGo()
  const agents = useProductStore((state) => state.agents)
  const hostStatus = useProductStore((state) => state.host.status)
  const [query, setQuery] = useState('')
  const creating = agentId === 'new'
  const agent = creating ? undefined : agents.find((item) => item.id === agentId)
  useCrumb('智能体', creating ? '新建' : agent?.name)

  if (!agentId && hostStatus !== 'initializing') {
    return <Navigate to={agents[0] ? `/agents/${agents[0].id}` : '/agents/new'} replace />
  }
  if (agentId && !creating && !agent && hostStatus === 'ready') return <Navigate to="/agents" replace />

  const needle = query.trim().toLowerCase()
  const visible = needle ? agents.filter((item) => item.name.toLowerCase().includes(needle)) : agents

  return (
    <WorkbenchPage
      list={
        <ListPane
          title="智能体"
          label="智能体"
          actions={
            <IconButton label="新建智能体" size="small" onClick={() => navigate('/agents/new')}>
              <Plus size={16} />
            </IconButton>
          }
          toolbar={<SearchField value={query} onChange={setQuery} label="搜索智能体" placeholder="搜索智能体" />}
        >
          <SelectionList selectedKey={agent?.id} accent={agent ? agentAccent(agent) : undefined}>
            {visible.map((item) => (
              <Link
                key={item.id}
                to={`/agents/${item.id}`}
                className={styles.row}
                data-selected={item.id === agent?.id}
                aria-current={item.id === agent?.id ? 'page' : undefined}
              >
                <AgentAvatar
                  name={item.name}
                  hue={agentHue(item)}
                  size="md"
                  live={isAgentWorking(item)}
                  {...(item.appearance?.avatarUrl ? { imageUrl: item.appearance.avatarUrl } : {})}
                />
                <span className={styles.rowName}>{item.name}</span>
                <span className={styles.rowState}>{agentPhase[item.state].label}</span>
                <span className={styles.rowSub}>{item.channels.length} 个频道</span>
              </Link>
            ))}
          </SelectionList>
          {needle && visible.length === 0 ? (
            <p className={styles.listEmpty}>没有名称包含“{query.trim()}”的智能体</p>
          ) : null}
        </ListPane>
      }
    >
      {creating ? <AgentCreate /> : agent ? <AgentProfile key={agent.id} agent={agent} /> : null}
    </WorkbenchPage>
  )
}
