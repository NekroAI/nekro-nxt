import { useGo } from '../model/nav.js'
import { MessagesSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { readLastChannelId, writeLastChannelId } from '../model/last-channel.js'
import { useProductStore } from '../../product-runtime.js'
import { Button, EmptyState } from '../../ui-kit/next/index.js'
import { useCrumb } from '../shell/crumb.js'
import { ChannelList } from './channel-list.js'
import styles from './channels.module.css'
import { Conversation } from './conversation.js'
import { ChannelInspector } from './inspector.js'

const INSPECTOR_KEY = 'nekro-nxt.channel-inspector'
const readInspector = (): boolean => {
  try {
    return window.localStorage.getItem(INSPECTOR_KEY) !== 'false'
  } catch {
    return true
  }
}

export default function ChannelsSpace() {
  const { channelId } = useParams<{ channelId: string }>()
  const navigate = useGo()
  const hostStatus = useProductStore((state) => state.host.status)
  const channels = useProductStore((state) => state.channels)
  const channel = useProductStore((state) =>
    channelId ? state.channels.find((item) => item.id === channelId) : undefined,
  )
  const agent = useProductStore((state) =>
    channel ? state.agents.find((item) => item.id === channel.agentId) : undefined,
  )
  const connection = useProductStore((state) =>
    channel ? state.connections.find((item) => item.id === channel.connectionId) : undefined,
  )
  const [inspectorOpen, setInspectorOpen] = useState(readInspector)
  useCrumb('频道', channel?.name)

  useEffect(() => {
    if (channel) writeLastChannelId(channel.id)
  }, [channel])

  if (!channelId && channels.length) {
    const last = readLastChannelId()
    const target = channels.find((item) => item.id === last) ?? channels[0]
    if (target) return <Navigate to={`/channels/${target.id}`} replace />
  }

  const toggleInspector = () => {
    setInspectorOpen((open) => {
      try {
        window.localStorage.setItem(INSPECTOR_KEY, String(!open))
      } catch {
        // Preference only.
      }
      return !open
    })
  }

  return (
    <div className={styles.space}>
      <ChannelList selectedId={channel?.id} />
      {channel ? (
        <>
          <Conversation
            channel={channel}
            agent={agent}
            connection={connection}
            inspectorOpen={inspectorOpen}
            onToggleInspector={toggleInspector}
          />
          {inspectorOpen ? (
            <ChannelInspector key={channel.id} channel={channel} agent={agent} connection={connection} />
          ) : null}
        </>
      ) : (
        <div className={styles.emptyCanvas}>
          <EmptyState
            icon={<MessagesSquare />}
            title={hostStatus === 'initializing' ? '正在读取频道' : channelId ? '频道已不存在' : '还没有频道'}
            action={
              hostStatus === 'initializing' ? undefined : (
                <Button variant="primary" onClick={() => navigate(channelId ? '/channels' : '/agents/new')}>
                  {channelId ? '回到频道' : '新建智能体'}
                </Button>
              )
            }
          >
            {channelId || hostStatus === 'initializing' ? undefined : '新建智能体会同时创建一个可以直接对话的频道。'}
          </EmptyState>
        </div>
      )}
    </div>
  )
}
