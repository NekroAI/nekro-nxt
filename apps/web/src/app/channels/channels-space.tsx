import { useGo } from '../model/nav.js'
import { MessagesSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { readLastChannelId, writeLastChannelId } from '../model/last-channel.js'
import { useProductStore } from '../../product-runtime.js'
import { Button, EmptyState, WorkbenchPage, usePhone } from '../../ui-kit/index.js'
import { agentPhase } from '../model/identity.js'
import { useCrumb, usePageBar } from '../shell/crumb.js'
import { ChannelList } from './channel-list.js'
import { useChannelSorting } from './channel-sort.js'
import styles from './channels.module.css'
import { Conversation, SubConversationView } from './conversation.js'
import { ChannelInspector } from './inspector.js'
import { subConversationStatus } from './sub-conversation-rows.js'

const INSPECTOR_KEY = 'nekro-nxt.channel-inspector'
const readInspector = (): boolean => {
  try {
    const stored = window.localStorage.getItem(INSPECTOR_KEY)
    // Without a saved choice the inspector starts open only where it fits beside the conversation.
    return stored === null ? window.innerWidth >= 1100 : stored !== 'false'
  } catch {
    return true
  }
}

export default function ChannelsSpace() {
  const { channelId, conversationId } = useParams<{ channelId: string; conversationId: string }>()
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
  const runtimePhase = useProductStore((state) => (channelId ? state.channelRuntimes[channelId]?.phase : undefined))
  const subConversation = useProductStore((state) =>
    conversationId ? state.subConversations.find((item) => item.id === conversationId) : undefined,
  )
  const [inspectorOpen, setInspectorOpen] = useState(readInspector)
  const phone = usePhone()
  useCrumb('频道', channel?.name)
  // On a phone a conversation is the second level above the channel list (05 §6.2): its name and state head the
  // top bar, the way back leads to the list, and it takes the whole height.
  const phaseKey = agent ? (runtimePhase ?? channel?.runtimePhase ?? agent.state) : undefined
  // Sort mode titles the bar 排序 and the list puts 完成 in it; the system's back step leaves the mode as well.
  const { sorting } = useChannelSorting()
  usePageBar(
    channelId === undefined
      ? sorting
        ? { title: '排序', mode: true }
        : undefined
      : {
          title: (conversationId === undefined ? channel?.name : subConversation?.title) ?? '频道',
          back: { to: '/channels', label: '返回频道列表' },
          immersive: true,
          ...(conversationId !== undefined
            ? subConversation
              ? {
                  status: {
                    label: subConversationStatus(subConversation),
                    tone: subConversation.status === 'open' ? ('accent' as const) : ('neutral' as const),
                    ...(channel ? { detail: channel.name } : {}),
                  },
                }
              : {}
            : channel
              ? {
                  status: phaseKey
                    ? {
                        label: agentPhase[phaseKey].label,
                        tone: agentPhase[phaseKey].tone,
                        ...(agent ? { detail: agent.name } : {}),
                      }
                    : { label: '未接线', tone: 'neutral' as const },
                }
              : {}),
        },
  )

  useEffect(() => {
    if (channel) writeLastChannelId(channel.id)
  }, [channel])

  // A computer opens the last channel straight away; a phone stays on the list, its first level.
  if (!channelId && channels.length && !phone) {
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

  const empty = (
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
  )

  return (
    <WorkbenchPage
      listLabel="全部频道"
      phonePane={channelId ? 'main' : 'list'}
      list={<ChannelList selectedId={channel?.id} selectedConversationId={conversationId} />}
      detail={
        channel && inspectorOpen && conversationId === undefined ? (
          <ChannelInspector
            key={channel.id}
            channel={channel}
            agent={agent}
            connection={connection}
            onClose={toggleInspector}
          />
        ) : undefined
      }
    >
      {channel && conversationId !== undefined ? (
        <SubConversationView key={conversationId} channel={channel} agent={agent} conversationId={conversationId} />
      ) : channel ? (
        <Conversation
          channel={channel}
          agent={agent}
          connection={connection}
          inspectorOpen={inspectorOpen}
          onToggleInspector={toggleInspector}
        />
      ) : (
        empty
      )}
    </WorkbenchPage>
  )
}
