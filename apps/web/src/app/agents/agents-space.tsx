import { useGo } from '../model/nav.js'
import { Plus } from 'lucide-react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { useProductStore } from '../../product-runtime.js'
import { AgentAvatar, IconButton, SelectionList } from '../../ui-kit/next/index.js'
import { agentAccent, agentHue, agentPhase, isAgentWorking } from '../model/identity.js'
import { useCrumb } from '../shell/crumb.js'
import { AgentCreate } from './agent-create.js'
import { AgentProfile } from './agent-profile.js'
import styles from './agents.module.css'

export default function AgentsSpace() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useGo()
  const agents = useProductStore((state) => state.agents)
  const hostStatus = useProductStore((state) => state.host.status)
  const creating = agentId === 'new'
  const agent = creating ? undefined : agents.find((item) => item.id === agentId)
  useCrumb('智能体', creating ? '新建' : agent?.name)

  if (!agentId && hostStatus !== 'initializing') {
    return <Navigate to={agents[0] ? `/agents/${agents[0].id}` : '/agents/new'} replace />
  }
  if (agentId && !creating && !agent && hostStatus === 'ready') return <Navigate to="/agents" replace />

  return (
    <div className={styles.space}>
      <aside className={styles.list} aria-label="智能体">
        <div className={styles.listHead}>
          <h2>智能体</h2>
          <IconButton label="新建智能体" size="small" onClick={() => navigate('/agents/new')}>
            <Plus size={16} />
          </IconButton>
        </div>
        <div className={styles.listBody}>
          <SelectionList selectedKey={agent?.id} accent={agent ? agentAccent(agent) : undefined}>
            {agents.map((item) => (
              <Link
                key={item.id}
                to={`/agents/${item.id}`}
                className={styles.row}
                data-selected={item.id === agent?.id}
                aria-current={item.id === agent?.id ? 'page' : undefined}
              >
                <AgentAvatar name={item.name} hue={agentHue(item)} size="md" live={isAgentWorking(item)} />
                <span className={styles.rowName}>{item.name}</span>
                <span className={styles.rowState}>{agentPhase[item.state].label}</span>
                <span className={styles.rowSub}>{item.channels.length} 个频道</span>
              </Link>
            ))}
          </SelectionList>
        </div>
      </aside>
      {creating ? <AgentCreate /> : agent ? <AgentProfile agent={agent} /> : <div />}
    </div>
  )
}
