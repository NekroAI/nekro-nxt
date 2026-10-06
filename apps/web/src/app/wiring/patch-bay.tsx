import { ChevronRight, Unplug } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  connectionDisplayName,
  useProductStore,
  type AgentSummary,
  type ChannelSummary,
  type ConnectionSummary,
} from '../../product-runtime.js'
import { AgentAvatar, StatusDot, cssVars, Pressable } from '../../ui-kit/next/index.js'
import { BindDialog, type BindIntent } from '../channels/bind-dialog.js'
import { connectionStatus } from '../model/connection-status.js'
import { agentAccent, agentHue, isAgentWorking, triggerLabel } from '../model/identity.js'
import { useGo } from '../model/nav.js'
import styles from './wiring.module.css'

export type WiringSelection = { readonly kind: 'connection' | 'channel' | 'agent'; readonly id: string }

export interface WiringFilter {
  readonly query: string
  readonly freeOnly: boolean
}

/** Groups fold by default once the board holds more channels than fit comfortably on one screen. */
export const FOLD_THRESHOLD = 12

/** DOM key used to measure a node when drawing wires. */
const nodeKey = (kind: 'connection' | 'channel' | 'agent' | 'group', id: string): string => `${kind}:${id}`

interface WireGeometry {
  readonly key: string
  readonly d: string
  readonly kind: 'connection' | 'binding' | 'summary'
  readonly id: string
  readonly channelId?: string
  readonly agent?: AgentSummary
  readonly live: boolean
  readonly draw: boolean
  readonly x1: number
  readonly x2: number
}

const curve = (x1: number, y1: number, x2: number, y2: number): string => {
  const dx = Math.max(40, (x2 - x1) / 2)
  return `M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + dx).toFixed(1)},${y1.toFixed(1)} ${(x2 - dx).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
}

const working = (channel: ChannelSummary) =>
  channel.runtimePhase === 'thinking' || channel.runtimePhase === 'using-tool'

const scrollParent = (element: HTMLElement): HTMLElement | Window => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return window
}

interface ChannelGroup {
  readonly connection: ConnectionSummary
  readonly channels: readonly ChannelSummary[]
  readonly total: number
  readonly free: number
}

/** Channels per account after the search and “unwired only” filters. */
export function groupChannels(
  connections: readonly ConnectionSummary[],
  channels: readonly ChannelSummary[],
  agentName: (id: string) => string | undefined,
  filter: WiringFilter,
): readonly ChannelGroup[] {
  const needle = filter.query.trim().toLowerCase()
  return connections.map((connection) => {
    const own = channels.filter((channel) => channel.connectionId === connection.id)
    const visible = own.filter((channel) => {
      if (filter.freeOnly && channel.agentId) return false
      if (!needle) return true
      return [channel.name, connectionDisplayName(connection), connection.adapter, agentName(channel.agentId) ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
    return { connection, channels: visible, total: own.length, free: own.filter((channel) => !channel.agentId).length }
  })
}

export function PatchBay({
  selected,
  filter,
}: {
  readonly selected: WiringSelection | undefined
  readonly filter: WiringFilter
}) {
  const go = useGo()
  const connections = useProductStore((state) => state.connections)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const patch = useRef<HTMLDivElement>(null)
  const [wires, setWires] = useState<readonly WireGeometry[]>([])
  const [intent, setIntent] = useState<BindIntent | null>(null)
  const [menu, setMenu] = useState<{ readonly channelId: string; readonly x: number; readonly y: number } | null>(null)
  const [drag, setDrag] = useState<{
    readonly channelId: string
    readonly x0: number
    readonly y0: number
    readonly x: number
    readonly y: number
  } | null>(null)
  const [dropAgent, setDropAgent] = useState('')
  const [picker, setPicker] = useState<{ readonly channelId: string; readonly x: number; readonly y: number } | null>(
    null,
  )
  /** Explicit open/closed choices; groups without one follow the default rule. */
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map())
  const suppressClick = useRef(false)
  const seenBindings = useRef<Map<string, string> | null>(null)

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const filtering = filter.query.trim() !== '' || filter.freeOnly
  const groups = useMemo(
    () => groupChannels(connections, channels, (id) => agentById.get(id)?.name, filter),
    [connections, channels, agentById, filter],
  )
  const selectedChannel =
    selected?.kind === 'channel' ? channels.find((channel) => channel.id === selected.id) : undefined
  const focusConnection =
    selected?.kind === 'connection' ? selected.id : selectedChannel ? selectedChannel.connectionId : undefined
  const crowded = channels.length > FOLD_THRESHOLD
  const isOpen = useCallback(
    (group: ChannelGroup) => {
      if (filtering) return group.channels.length > 0
      const explicit = folds.get(group.connection.id)
      if (explicit !== undefined) return explicit
      if (!crowded) return true
      if (group.connection.id === focusConnection) return true
      return selected?.kind === 'agent' && group.channels.some((channel) => channel.agentId === selected.id)
    },
    [filtering, folds, crowded, focusConnection, selected],
  )
  const visibleGroups = filtering ? groups.filter((group) => group.channels.length > 0) : groups
  const openKey = visibleGroups.map((group) => `${group.connection.id}:${isOpen(group) ? 1 : 0}`).join('|')
  const shownKey = visibleGroups.flatMap((group) => (isOpen(group) ? group.channels.map((c) => c.id) : [])).join('|')

  const measure = useCallback(() => {
    const root = patch.current
    if (!root) return
    const box = root.getBoundingClientRect()
    const point = (selector: string, side: 'left' | 'right') => {
      const element = root.querySelector<HTMLElement>(selector)
      if (!element) return undefined
      const rect = element.getBoundingClientRect()
      return { x: (side === 'right' ? rect.right : rect.left) - box.left, y: rect.top + rect.height / 2 - box.top }
    }
    const previous = seenBindings.current
    const next: WireGeometry[] = []
    for (const group of visibleGroups) {
      const from = point(`[data-node="${nodeKey('connection', group.connection.id)}"]`, 'right')
      if (!isOpen(group)) {
        const header = point(`[data-node="${nodeKey('group', group.connection.id)}"]`, 'left')
        if (from && header)
          next.push({
            key: `g:${group.connection.id}`,
            d: curve(from.x, from.y, header.x, header.y),
            kind: 'connection',
            id: group.connection.id,
            live: false,
            draw: false,
            x1: from.x,
            x2: header.x,
          })
        // A folded group still shows which agents answer it: one quiet wire per agent.
        const out = point(`[data-node="${nodeKey('group', group.connection.id)}"]`, 'right')
        const answering = [...new Set(group.channels.map((channel) => channel.agentId).filter(Boolean))]
        for (const agentId of answering) {
          const agent = agentById.get(agentId)
          const to = agent ? point(`[data-node="${nodeKey('agent', agent.id)}"]`, 'left') : undefined
          if (!agent || !out || !to) continue
          next.push({
            key: `s:${group.connection.id}:${agent.id}`,
            d: curve(out.x, out.y, to.x, to.y),
            kind: 'summary',
            id: group.connection.id,
            agent,
            live: false,
            draw: false,
            x1: out.x,
            x2: to.x,
          })
        }
        continue
      }
      for (const channel of group.channels) {
        const to = point(`[data-node="${nodeKey('channel', channel.id)}"]`, 'left')
        if (from && to)
          next.push({
            key: `c:${channel.id}`,
            d: curve(from.x, from.y, to.x, to.y),
            kind: 'connection',
            id: channel.id,
            channelId: channel.id,
            live: false,
            draw: previous === null,
            x1: from.x,
            x2: to.x,
          })
        const agent = channel.agentId ? agentById.get(channel.agentId) : undefined
        if (!agent) continue
        const a = point(`[data-node="${nodeKey('channel', channel.id)}"]`, 'right')
        const b = point(`[data-node="${nodeKey('agent', agent.id)}"]`, 'left')
        if (!a || !b) continue
        next.push({
          key: `b:${channel.id}`,
          d: curve(a.x, a.y, b.x, b.y),
          kind: 'binding',
          id: channel.id,
          channelId: channel.id,
          agent,
          live: working(channel),
          draw: previous === null || previous.get(channel.id) !== agent.id,
          x1: a.x,
          x2: b.x,
        })
      }
    }
    seenBindings.current = new Map(channels.map((channel) => [channel.id, channel.agentId]))
    setWires(next)
    // openKey/shownKey capture which nodes exist; visibleGroups and isOpen derive from them.
  }, [channels, agentById, openKey, shownKey])

  useLayoutEffect(() => {
    measure()
    const root = patch.current
    if (!root) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(root)
    // Pinned columns move relative to the board while it scrolls, so the wires follow every scroll frame.
    const scroller = scrollParent(root)
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [measure])

  useEffect(() => {
    if (!menu && !picker) return
    const close = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && event.target instanceof Element && event.target.closest('[data-wire-menu]'))
        return
      setMenu(null)
      setPicker(null)
    }
    window.addEventListener('keydown', close)
    window.addEventListener('mousedown', close)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('mousedown', close)
    }
  }, [menu, picker])

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, channelId: string) => {
    if (event.button !== 0) return
    event.preventDefault()
    const root = patch.current
    if (!root) return
    const box = root.getBoundingClientRect()
    const rect = event.currentTarget.getBoundingClientRect()
    const x0 = rect.left + rect.width / 2 - box.left
    const y0 = rect.top + rect.height / 2 - box.top
    const startX = event.clientX
    const startY = event.clientY
    let moved = false
    const onMove = (move: PointerEvent) => {
      if (!moved && Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return
      if (!moved) document.body.style.userSelect = 'none'
      moved = true
      const current = root.getBoundingClientRect()
      setDrag({
        channelId,
        x0: x0 + box.left - current.left,
        y0: y0 + box.top - current.top,
        x: move.clientX - current.left,
        y: move.clientY - current.top,
      })
      const hit = document.elementFromPoint(move.clientX, move.clientY)?.closest<HTMLElement>('[data-agent-node]')
      setDropAgent(hit?.dataset['agentNode'] ?? '')
    }
    const onUp = (up: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDrag(null)
      setDropAgent('')
      document.body.style.userSelect = ''
      if (!moved) return
      suppressClick.current = true
      window.setTimeout(() => (suppressClick.current = false), 60)
      const hit = document.elementFromPoint(up.clientX, up.clientY)?.closest<HTMLElement>('[data-agent-node]')
      const agentId = hit?.dataset['agentNode']
      const channel = channels.find((item) => item.id === channelId)
      if (agentId && channel && channel.agentId !== agentId)
        setIntent({ kind: channel.agentId ? 'replace' : 'bind', channelId, agentId })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const pickerChannel = picker ? channels.find((channel) => channel.id === picker.channelId) : undefined
  const menuChannel = menu ? channels.find((channel) => channel.id === menu.channelId) : undefined
  const menuAgent = menuChannel ? agentById.get(menuChannel.agentId) : undefined
  const isSelected = (kind: WiringSelection['kind'], id: string) => selected?.kind === kind && selected.id === id
  const select = (kind: WiringSelection['kind'], id: string) => {
    if (suppressClick.current) return
    go(`/wiring/${kind === 'connection' ? 'connections' : kind === 'channel' ? 'channels' : 'agents'}/${id}`)
  }
  const toggle = (group: ChannelGroup) =>
    setFolds((current) => new Map(current).set(group.connection.id, !isOpen(group)))

  return (
    <>
      <div ref={patch} className={[styles.patch, drag ? styles.dragging : ''].join(' ')}>
        <svg className={styles.wires} aria-hidden="true">
          <defs>
            {wires
              .filter((wire) => wire.kind === 'binding' && wire.agent)
              .map((wire) => (
                <linearGradient
                  key={wire.key}
                  id={`wire-${wire.id}`}
                  gradientUnits="userSpaceOnUse"
                  x1={wire.x1}
                  y1="0"
                  x2={wire.x2}
                  y2="0"
                >
                  <stop offset="0" style={{ stopColor: `hsl(${agentHue(wire.agent!)} 74% 77%)` }} />
                  <stop offset="1" style={{ stopColor: agentAccent(wire.agent!) }} />
                </linearGradient>
              ))}
          </defs>
          {wires.map((wire) =>
            wire.kind === 'connection' ? (
              <path
                key={wire.key}
                className={[styles.wireConn, wire.draw ? styles.wireDraw : ''].join(' ')}
                pathLength={1}
                d={wire.d}
              />
            ) : wire.kind === 'summary' ? (
              <path
                key={wire.key}
                className={styles.wireSummary}
                style={{ stroke: agentAccent(wire.agent!) }}
                d={wire.d}
              />
            ) : (
              <g key={wire.key}>
                <path className={styles.wireGlow} style={{ stroke: agentAccent(wire.agent!) }} d={wire.d} />
                <path
                  className={[styles.wireBind, wire.draw ? styles.wireDraw : ''].join(' ')}
                  pathLength={1}
                  style={{ stroke: `url(#wire-${wire.id})` }}
                  d={wire.d}
                />
                {wire.live ? <path className={styles.wireLive} d={wire.d} /> : null}
                <path
                  className={styles.wireHit}
                  d={wire.d}
                  onClick={(event) => {
                    const box = patch.current?.getBoundingClientRect()
                    if (box && wire.channelId)
                      setMenu({ channelId: wire.channelId, x: event.clientX - box.left, y: event.clientY - box.top })
                  }}
                />
              </g>
            ),
          )}
          {drag ? <path className={styles.wireTemp} d={curve(drag.x0, drag.y0, drag.x, drag.y)} /> : null}
        </svg>

        <div className={styles.column}>
          <div className={styles.pinned}>
            <h2 className={styles.columnTitle}>平台账号</h2>
            {connections.map((connection) => {
              const status = connectionStatus(connection)
              return (
                <Pressable
                  key={connection.id}
                  className={styles.node}
                  data-node={nodeKey('connection', connection.id)}
                  data-selected={isSelected('connection', connection.id)}
                  aria-current={isSelected('connection', connection.id) ? 'true' : undefined}
                  onClick={() => select('connection', connection.id)}
                >
                  <span className={styles.nodeName}>
                    <StatusDot tone={status.tone} pulse={status.health === 'connecting'} label={status.label} />
                    <span>{connectionDisplayName(connection)}</span>
                  </span>
                  <span className={styles.nodeSub}>
                    {!connection.userManaged ? '内置' : connection.alias ? connection.adapter : '平台账号'}
                  </span>
                  <span className={[styles.port, styles.portRight].join(' ')} />
                </Pressable>
              )
            })}
          </div>
        </div>

        <div className={styles.column}>
          <h2 className={styles.columnTitle}>频道</h2>
          {visibleGroups.map((group) => {
            const open = isOpen(group)
            return (
              <div key={group.connection.id} className={styles.group}>
                <Pressable
                  className={styles.groupHead}
                  data-node={nodeKey('group', group.connection.id)}
                  aria-expanded={open}
                  disabled={filtering}
                  onClick={() => toggle(group)}
                >
                  <span className={[styles.port, styles.portLeft, styles.portSmall].join(' ')} />
                  <ChevronRight size={14} className={styles.groupChevron} data-open={open} aria-hidden="true" />
                  <span className={styles.groupName}>{connectionDisplayName(group.connection)}</span>
                  <span className={styles.groupCount}>
                    {filtering
                      ? `${group.channels.length} / ${group.total}`
                      : group.free === 0
                        ? group.total
                        : group.free === group.total
                          ? `${group.free} 未接线`
                          : `${group.total} · ${group.free} 未接线`}
                  </span>
                  {open ? null : <span className={[styles.port, styles.portRight, styles.portSmall].join(' ')} />}
                </Pressable>
                {open
                  ? group.channels.map((channel) => {
                      const agent = agentById.get(channel.agentId)
                      const accent = agent ? cssVars({ '--node-accent': agentAccent(agent) }) : undefined
                      const trigger = channel.bindings[0] ? triggerLabel[channel.bindings[0].triggerPolicy] : undefined
                      return (
                        <div key={channel.id} className={styles.channelSlot}>
                          <Pressable
                            className={[styles.node, styles.channelNode, agent ? '' : styles.free].join(' ')}
                            data-node={nodeKey('channel', channel.id)}
                            data-selected={isSelected('channel', channel.id)}
                            aria-current={isSelected('channel', channel.id) ? 'true' : undefined}
                            style={accent}
                            onClick={() => select('channel', channel.id)}
                          >
                            <span className={[styles.port, styles.portLeft].join(' ')} />
                            <span className={styles.nodeName}>
                              <span>{channel.name}</span>
                            </span>
                            <span className={styles.nodeSub}>{agent ? trigger : '未接线'}</span>
                          </Pressable>
                          <Pressable
                            className={[
                              styles.port,
                              styles.portRight,
                              styles.portOut,
                              agent ? styles.portFilled : styles.portOpen,
                            ].join(' ')}
                            style={accent}
                            aria-label={`把「${channel.name}」接到智能体`}
                            aria-haspopup="menu"
                            title="拖到智能体，或点击选择"
                            onPointerDown={(event) => startDrag(event, channel.id)}
                            onClick={(event) => {
                              if (suppressClick.current) return
                              const box = patch.current?.getBoundingClientRect()
                              const rect = event.currentTarget.getBoundingClientRect()
                              if (box)
                                setPicker({
                                  channelId: channel.id,
                                  x: rect.left + rect.width / 2 - box.left,
                                  y: rect.bottom - box.top,
                                })
                            }}
                          />
                        </div>
                      )
                    })
                  : null}
              </div>
            )
          })}
          {filtering && visibleGroups.length === 0 ? <p className={styles.noMatch}>没有符合条件的频道</p> : null}
        </div>

        <div className={styles.column}>
          <div className={styles.pinned}>
            <h2 className={styles.columnTitle}>智能体</h2>
            {agents.map((agent) => (
              <Pressable
                key={agent.id}
                className={[styles.node, styles.agentNode, dropAgent === agent.id ? styles.target : ''].join(' ')}
                data-node={nodeKey('agent', agent.id)}
                data-agent-node={agent.id}
                data-selected={isSelected('agent', agent.id)}
                aria-current={isSelected('agent', agent.id) ? 'true' : undefined}
                style={cssVars({ '--node-accent': agentAccent(agent) })}
                onClick={() => select('agent', agent.id)}
              >
                <span className={[styles.port, styles.portLeft, styles.portFilled].join(' ')} />
                <AgentAvatar name={agent.name} hue={agentHue(agent)} live={isAgentWorking(agent)} />
                <span className={styles.agentText}>
                  <span className={styles.nodeName}>
                    <span>{agent.name}</span>
                  </span>
                  <span className={styles.nodeSub}>{agent.channels.length} 个频道</span>
                </span>
              </Pressable>
            ))}
          </div>
        </div>

        {picker && pickerChannel ? (
          <div
            className={styles.wireMenu}
            style={{ left: picker.x, top: picker.y }}
            data-wire-menu
            role="menu"
            aria-label={`为「${pickerChannel.name}」选择智能体`}
          >
            {agents
              .filter((item) => item.id !== pickerChannel.agentId)
              .map((item, index) => (
                <Pressable
                  key={item.id}
                  role="menuitem"
                  autoFocus={index === 0}
                  onClick={() => {
                    setPicker(null)
                    setIntent({
                      kind: pickerChannel.agentId ? 'replace' : 'bind',
                      channelId: pickerChannel.id,
                      agentId: item.id,
                    })
                  }}
                >
                  <AgentAvatar name={item.name} hue={agentHue(item)} size="xs" />
                  交给{item.name}
                </Pressable>
              ))}
            {pickerChannel.agentId ? (
              <>
                <hr />
                <Pressable
                  role="menuitem"
                  className={styles.danger}
                  onClick={() => {
                    setPicker(null)
                    setIntent({ kind: 'unbind', channelId: pickerChannel.id })
                  }}
                >
                  <Unplug />
                  断开
                </Pressable>
              </>
            ) : null}
          </div>
        ) : null}
        {menu && menuChannel && menuAgent ? (
          <div className={styles.wireMenu} style={{ left: menu.x, top: menu.y }} data-wire-menu role="menu">
            {agents
              .filter((item) => item.id !== menuAgent.id)
              .map((item) => (
                <Pressable
                  key={item.id}
                  role="menuitem"
                  onClick={() => {
                    setMenu(null)
                    setIntent({ kind: 'replace', channelId: menuChannel.id, agentId: item.id })
                  }}
                >
                  <AgentAvatar name={item.name} hue={agentHue(item)} size="xs" />
                  改由{item.name}响应
                </Pressable>
              ))}
            <hr />
            <Pressable
              role="menuitem"
              className={styles.danger}
              onClick={() => {
                setMenu(null)
                setIntent({ kind: 'unbind', channelId: menuChannel.id })
              }}
            >
              <Unplug />
              断开
            </Pressable>
          </div>
        ) : null}
      </div>
      <BindDialog intent={intent} onClose={() => setIntent(null)} />
    </>
  )
}
