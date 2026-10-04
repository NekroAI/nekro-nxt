import { Unplug } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Link } from 'react-router-dom'
import { connectionDisplayName, useProductStore, type AgentSummary, type ChannelSummary } from '../../product-runtime.js'
import { AgentAvatar, StatusDot } from '../../ui-kit/next/index.js'
import { BindDialog, type BindIntent } from '../channels/bind-dialog.js'
import { agentAccent, agentHue, connectionTone, isAgentWorking, triggerLabel } from '../model/identity.js'
import styles from './wiring.module.css'

interface WireGeometry {
  readonly key: string
  readonly d: string
  readonly kind: 'connection' | 'binding'
  readonly channelId: string
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

const working = (channel: ChannelSummary) => channel.runtimePhase === 'thinking' || channel.runtimePhase === 'using-tool'

export function PatchBay({ selected }: { readonly selected: { readonly kind: 'connection' | 'channel' | 'agent'; readonly id: string } | undefined }) {
  const connections = useProductStore((state) => state.connections)
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const patch = useRef<HTMLDivElement>(null)
  const [wires, setWires] = useState<readonly WireGeometry[]>([])
  const [intent, setIntent] = useState<BindIntent | null>(null)
  const [menu, setMenu] = useState<{ readonly channelId: string; readonly x: number; readonly y: number } | null>(null)
  const [drag, setDrag] = useState<{ readonly channelId: string; readonly x0: number; readonly y0: number; readonly x: number; readonly y: number } | null>(null)
  const [dropAgent, setDropAgent] = useState('')
  const [picker, setPicker] = useState<{ readonly channelId: string; readonly x: number; readonly y: number } | null>(null)
  const suppressClick = useRef(false)
  const seenBindings = useRef<Map<string, string> | null>(null)

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const groups = useMemo(
    () => connections.map((connection) => ({ connection, channels: channels.filter((channel) => channel.connectionId === connection.id) })),
    [connections, channels],
  )

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
    for (const channel of channels) {
      const from = point(`[data-node="connection:${channel.connectionId}"]`, 'right')
      const to = point(`[data-node="channel:${channel.id}"]`, 'left')
      if (from && to) next.push({ key: `c:${channel.id}`, d: curve(from.x, from.y, to.x, to.y), kind: 'connection', channelId: channel.id, live: false, draw: previous === null, x1: from.x, x2: to.x })
      const agent = channel.agentId ? agentById.get(channel.agentId) : undefined
      if (!agent) continue
      const a = point(`[data-node="channel:${channel.id}"]`, 'right')
      const b = point(`[data-node="agent:${agent.id}"]`, 'left')
      if (!a || !b) continue
      next.push({
        key: `b:${channel.id}`,
        d: curve(a.x, a.y, b.x, b.y),
        kind: 'binding',
        channelId: channel.id,
        agent,
        live: working(channel),
        draw: previous === null || previous.get(channel.id) !== agent.id,
        x1: a.x,
        x2: b.x,
      })
    }
    seenBindings.current = new Map(channels.map((channel) => [channel.id, channel.agentId]))
    setWires(next)
  }, [channels, agentById])

  useLayoutEffect(() => {
    measure()
    const root = patch.current
    if (!root) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(root)
    return () => observer.disconnect()
  }, [measure])

  useEffect(() => {
    if (!menu && !picker) return
    const close = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && (event.target as Element | null)?.closest('[data-wire-menu]')) return
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
      setDrag({ channelId, x0, y0, x: move.clientX - box.left, y: move.clientY - box.top })
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
      if (agentId && channel && channel.agentId !== agentId) setIntent({ kind: channel.agentId ? 'replace' : 'bind', channelId, agentId })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const pickerChannel = picker ? channels.find((channel) => channel.id === picker.channelId) : undefined
  const menuChannel = menu ? channels.find((channel) => channel.id === menu.channelId) : undefined
  const menuAgent = menuChannel ? agentById.get(menuChannel.agentId) : undefined
  const current = (kind: string, id: string) => (selected?.kind === kind && selected.id === id ? 'page' : undefined)

  return (
    <>
      <div ref={patch} className={[styles.patch, drag ? styles.dragging : ''].join(' ')}>
        <svg className={styles.wires} aria-hidden="true">
          <defs>
            {wires
              .filter((wire) => wire.agent)
              .map((wire) => (
                <linearGradient key={wire.key} id={`wire-${wire.channelId}`} gradientUnits="userSpaceOnUse" x1={wire.x1} y1="0" x2={wire.x2} y2="0">
                  <stop offset="0" style={{ stopColor: `hsl(${agentHue(wire.agent!)} 74% 77%)` }} />
                  <stop offset="1" style={{ stopColor: agentAccent(wire.agent!) }} />
                </linearGradient>
              ))}
          </defs>
          {wires.map((wire) =>
            wire.kind === 'connection' ? (
              <path key={wire.key} className={[styles.wireConn, wire.draw ? styles.wireDraw : ''].join(' ')} pathLength={1} d={wire.d} />
            ) : (
              <g key={wire.key}>
                <path className={styles.wireGlow} style={{ stroke: agentAccent(wire.agent!) }} d={wire.d} />
                <path className={[styles.wireBind, wire.draw ? styles.wireDraw : ''].join(' ')} pathLength={1} style={{ stroke: `url(#wire-${wire.channelId})` }} d={wire.d} />
                {wire.live ? <path className={styles.wireLive} d={wire.d} /> : null}
                <path
                  className={styles.wireHit}
                  d={wire.d}
                  onClick={(event) => {
                    const box = patch.current?.getBoundingClientRect()
                    if (box) setMenu({ channelId: wire.channelId, x: event.clientX - box.left, y: event.clientY - box.top })
                  }}
                />
              </g>
            ),
          )}
          {drag ? <path className={styles.wireTemp} d={curve(drag.x0, drag.y0, drag.x, drag.y)} /> : null}
        </svg>

        <div className={styles.column}>
          <h2 className={styles.columnTitle}>平台账号</h2>
          {connections.map((connection) => (
            <Link
              key={connection.id}
              to={`/wiring/connections/${connection.id}`}
              className={styles.node}
              data-node={`connection:${connection.id}`}
              aria-current={current('connection', connection.id)}
            >
              <span className={styles.nodeName}>
                <StatusDot tone={connectionTone(connection.state)} pulse={connectionTone(connection.state) === 'warn'} />
                <span>{connectionDisplayName(connection)}</span>
              </span>
              <span className={styles.nodeSub}>{connection.userManaged ? connection.adapter : '内置'}</span>
              <span className={[styles.port, styles.portRight].join(' ')} />
            </Link>
          ))}
        </div>

        <div className={styles.column}>
          <h2 className={styles.columnTitle}>频道</h2>
          {groups.map(({ connection, channels: list }) => (
            <div key={connection.id} className={styles.group}>
              {list.map((channel) => {
                const agent = agentById.get(channel.agentId)
                const accent = agent ? ({ '--node-accent': agentAccent(agent) } as CSSProperties) : undefined
                const trigger = channel.bindings[0] ? triggerLabel[channel.bindings[0].triggerPolicy] : undefined
                return (
                  <div key={channel.id} style={{ position: 'relative' }}>
                    <Link
                      to={`/wiring/channels/${channel.id}`}
                      className={[styles.node, styles.channelNode, agent ? '' : styles.free].join(' ')}
                      data-node={`channel:${channel.id}`}
                      aria-current={current('channel', channel.id)}
                      style={accent}
                    >
                      <span className={[styles.port, styles.portLeft].join(' ')} />
                      <span className={styles.nodeName}>
                        <span>{channel.name}</span>
                      </span>
                      <span className={styles.nodeSub}>{agent ? trigger : '未接线'}</span>
                    </Link>
                    <button
                      type="button"
                      className={[styles.port, styles.portRight, styles.portOut, agent ? styles.portFilled : styles.portOpen].join(' ')}
                      style={accent}
                      aria-label={`把「${channel.name}」接到智能体`}
                      aria-haspopup="menu"
                      title="拖到智能体，或点击选择"
                      onPointerDown={(event) => startDrag(event, channel.id)}
                      onClick={(event) => {
                        if (suppressClick.current) return
                        const box = patch.current?.getBoundingClientRect()
                        const rect = event.currentTarget.getBoundingClientRect()
                        if (box) setPicker({ channelId: channel.id, x: rect.left + rect.width / 2 - box.left, y: rect.bottom - box.top })
                      }}
                    />
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className={styles.column}>
          <h2 className={styles.columnTitle}>智能体</h2>
          {agents.map((agent) => (
            <Link
              key={agent.id}
              to={`/agents/${agent.id}`}
              className={[styles.node, styles.agentNode, dropAgent === agent.id ? styles.target : ''].join(' ')}
              data-node={`agent:${agent.id}`}
              data-agent-node={agent.id}
              style={{ '--node-accent': agentAccent(agent) } as CSSProperties}
            >
              <span className={[styles.port, styles.portLeft, styles.portFilled].join(' ')} />
              <AgentAvatar name={agent.name} hue={agentHue(agent)} live={isAgentWorking(agent)} />
              <span className={styles.agentText}>
                <span className={styles.nodeName}>
                  <span>{agent.name}</span>
                </span>
                <span className={styles.nodeSub}>{agent.channels.length} 个频道</span>
              </span>
            </Link>
          ))}
        </div>

        {picker && pickerChannel ? (
          <div className={styles.wireMenu} style={{ left: picker.x, top: picker.y }} data-wire-menu role="menu" aria-label={`为「${pickerChannel.name}」选择智能体`}>
            {agents
              .filter((item) => item.id !== pickerChannel.agentId)
              .map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  autoFocus={index === 0}
                  onClick={() => {
                    setPicker(null)
                    setIntent({ kind: pickerChannel.agentId ? 'replace' : 'bind', channelId: pickerChannel.id, agentId: item.id })
                  }}
                >
                  <AgentAvatar name={item.name} hue={agentHue(item)} size="xs" />
                  交给{item.name}
                </button>
              ))}
            {pickerChannel.agentId ? (
              <>
                <hr />
                <button
                  type="button"
                  role="menuitem"
                  className={styles.danger}
                  onClick={() => {
                    setPicker(null)
                    setIntent({ kind: 'unbind', channelId: pickerChannel.id })
                  }}
                >
                  <Unplug />
                  断开
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {menu && menuChannel && menuAgent ? (
          <div className={styles.wireMenu} style={{ left: menu.x, top: menu.y }} data-wire-menu role="menu">
            {agents
              .filter((item) => item.id !== menuAgent.id)
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(null)
                    setIntent({ kind: 'replace', channelId: menuChannel.id, agentId: item.id })
                  }}
                >
                  <AgentAvatar name={item.name} hue={agentHue(item)} size="xs" />
                  改由{item.name}响应
                </button>
              ))}
            <hr />
            <button
              type="button"
              role="menuitem"
              className={styles.danger}
              onClick={() => {
                setMenu(null)
                setIntent({ kind: 'unbind', channelId: menuChannel.id })
              }}
            >
              <Unplug />
              断开
            </button>
          </div>
        ) : null}
      </div>
      <BindDialog intent={intent} onClose={() => setIntent(null)} />
    </>
  )
}
