import { useGo } from '../model/nav.js'
import {
  AppWindow,
  Cable,
  MessagesSquare,
  Moon,
  Plus,
  Rows3,
  Search,
  Settings,
  Sparkles,
  Sun,
  UserRound,
  Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HostApiResponse } from '@nekro-nxt/contracts'

import { connectionDisplayName, useProductStore } from '../../product-runtime.js'
import { useProductApi } from '../model/store.js'
import { Kbd, Pressable, Input, Overlay } from '../../ui-kit/index.js'
import { agentPhase } from '../model/identity.js'
import { useDensity } from '../model/density.js'
import { useToggleTheme } from '../model/theme.js'
import { SPACES } from './app-shell.js'
import styles from './palette.module.css'

interface Command {
  readonly id: string
  readonly group: string
  readonly label: string
  readonly hint?: string
  readonly icon: ReactNode
  readonly keywords: string
  readonly run: () => void
}

type Member = HostApiResponse<'listPlatformUsers'>['items'][number]

const RECENT_KEY = 'nekro-nxt.palette-recent'
const RECENT_LIMIT = 5

const readRecent = (): readonly string[] => {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

const rememberRecent = (id: string): void => {
  try {
    const next = [id, ...readRecent().filter((item) => item !== id)].slice(0, RECENT_LIMIT)
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Convenience only.
  }
}

const SETTINGS_SECTIONS = [
  { key: 'models', label: '模型' },
  { key: 'adapters', label: '平台适配器' },
  { key: 'dsh', label: 'DSH 插件' },
  { key: 'notifications', label: '通知' },
  { key: 'appearance', label: '外观' },
  { key: 'about', label: '关于' },
] as const

/** Debounced Host search over platform members; empty input clears the results. */
function useMemberSearch(query: string): readonly Member[] {
  const api = useProductApi()
  const [items, setItems] = useState<readonly Member[]>([])
  useEffect(() => {
    const needle = query.trim()
    if (!needle) {
      setItems([])
      return
    }
    let live = true
    const timer = window.setTimeout(() => {
      void api
        .getState()
        .listPlatformUsers({ query: needle, limit: 8 })
        .then((result) => live && setItems(result.items))
        .catch(() => live && setItems([]))
    }, 200)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [api, query])
  return items
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const navigate = useGo()
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const connections = useProductStore((state) => state.connections)
  const pages = useProductStore((state) => state.hostUi.pages)
  const [query, setQuery] = useState('')
  const members = useMemberSearch(open ? query : '')
  const [index, setIndex] = useState(0)
  const [recentIds, setRecentIds] = useState<readonly string[]>(readRecent)
  const listRef = useRef<HTMLDivElement>(null)

  const toggleTheme = useToggleTheme()
  const [density, setDensity] = useDensity()
  const commands = useMemo<readonly Command[]>(() => {
    const go = (path: string) => () => navigate(path)
    const connectionName = new Map(connections.map((connection) => [connection.id, connection]))
    return [
      ...SPACES.map(({ path, label, icon: Icon }) => ({
        id: `go:${path}`,
        group: '前往',
        label,
        icon: <Icon />,
        keywords: label,
        run: go(path),
      })),
      {
        id: 'go:settings',
        group: '前往',
        label: '设置',
        icon: <Settings />,
        keywords: '设置 settings',
        run: go('/settings'),
      },
      ...channels.map((channel) => {
        const connection = connectionName.get(channel.connectionId)
        const source = connection ? connectionDisplayName(connection) : channel.connectionName
        return {
          id: `channel:${channel.id}`,
          group: '频道',
          label: channel.name,
          hint: source,
          icon: <MessagesSquare />,
          keywords: `${channel.name} ${source}`,
          run: go(`/channels/${channel.id}`),
        }
      }),
      ...agents.map((agent) => ({
        id: `agent:${agent.id}`,
        group: '智能体',
        label: agent.name,
        hint: agentPhase[agent.state].label,
        icon: <Sparkles />,
        keywords: agent.name,
        run: go(`/agents/${agent.id}`),
      })),
      ...pages.map((page) => ({
        id: `page:${page.pageInstanceId}`,
        group: '扩展页面',
        label: page.title,
        ...(page.description ? { hint: page.description } : {}),
        icon: <AppWindow />,
        keywords: `${page.title} ${page.description ?? ''}`,
        run: go(`${page.routeBase}${page.startPath ? `/${page.startPath}` : ''}`),
      })),
      ...SETTINGS_SECTIONS.map((section) => ({
        id: `settings:${section.key}`,
        group: '设置',
        label: `设置 · ${section.label}`,
        icon: <Settings />,
        keywords: `设置 ${section.label}`,
        run: go(`/settings/${section.key}`),
      })),
      {
        id: 'action:add-account',
        group: '操作',
        label: '添加平台账号',
        icon: <Cable />,
        keywords: '添加 账号 连接 接线 平台',
        run: go('/wiring/new'),
      },
      {
        id: 'action:create-extension',
        group: '操作',
        label: '创造扩展',
        icon: <Wrench />,
        keywords: '创造 扩展 工坊 新能力',
        run: go('/workshop'),
      },
      {
        id: 'action:new-agent',
        group: '操作',
        label: '新建智能体',
        icon: <Plus />,
        keywords: '新建 创建 智能体',
        run: go('/agents/new'),
      },
      {
        id: 'action:theme',
        group: '操作',
        label: '切换浅色或深色',
        icon: document.documentElement.dataset['theme'] === 'dark' ? <Sun /> : <Moon />,
        keywords: '主题 外观 深色 浅色 theme',
        run: toggleTheme,
      },
      {
        id: 'action:density',
        group: '操作',
        label: density === 'compact' ? '切换到标准密度' : '切换到紧凑密度',
        icon: <Rows3 />,
        keywords: '密度 紧凑 标准 行高 density',
        run: () => setDensity(density === 'compact' ? 'comfortable' : 'compact'),
      },
    ]
  }, [agents, channels, connections, density, navigate, pages, setDensity, toggleTheme])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) {
      // Recently used commands lead the list; they stay in their own groups further down too.
      const byId = new Map(commands.map((command) => [command.id, command]))
      const recent = recentIds.flatMap((id) => {
        const command = byId.get(id)
        return command ? [{ ...command, id: `recent:${command.id}`, group: '最近使用' }] : []
      })
      return [...recent, ...commands]
    }
    const matched = commands.filter((command) =>
      `${command.label} ${command.keywords} ${command.group}`.toLowerCase().includes(needle),
    )
    // Platform members come from the Host search; each opens the member's first channel or its account.
    return [
      ...matched,
      ...members.map((member) => ({
        id: `member:${member.identityId}`,
        group: '成员',
        label: member.displayName ?? '未命名成员',
        hint: member.connection.displayName,
        icon: <UserRound />,
        keywords: '',
        run: () =>
          navigate(
            member.channelPreview[0]
              ? `/channels/${member.channelPreview[0].id}`
              : `/wiring/connections/${member.connection.id}`,
          ),
      })),
    ]
  }, [commands, members, navigate, query, recentIds])

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      setRecentIds(readRecent())
    }
  }, [open])
  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const run = (command: Command | undefined) => {
    if (!command) return
    if (!command.id.startsWith('member:')) rememberRecent(command.id.replace(/^recent:/u, ''))
    onOpenChange(false)
    command.run()
  }

  let lastGroup = ''
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      label="搜索"
      className={styles.panel}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          setIndex((current) => (visible.length ? (current + step + visible.length) % visible.length : 0))
        } else if (event.key === 'Enter') {
          event.preventDefault()
          run(visible[index])
        }
      }}
    >
      <div className={styles.input}>
        <Search aria-hidden="true" />
        <Input
          bare
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索频道、智能体或操作"
          aria-label="搜索"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-list"
          aria-activedescendant={visible[index] ? `command-${visible[index].id}` : undefined}
        />
      </div>
      <div ref={listRef} className={styles.list} id="command-list" role="listbox">
        {visible.length === 0 ? <div className={styles.empty}>没有找到结果</div> : null}
        {visible.map((command, position) => {
          const heading = command.group !== lastGroup ? command.group : ''
          lastGroup = command.group
          return (
            <div key={command.id}>
              {heading ? <div className={styles.group}>{heading}</div> : null}
              <Pressable
                type="button"
                id={`command-${command.id}`}
                role="option"
                aria-selected={position === index}
                className={styles.item}
                onMouseMove={() => position !== index && setIndex(position)}
                onClick={() => run(command)}
              >
                <span className={styles.icon}>{command.icon}</span>
                <span className={styles.label}>{command.label}</span>
                {command.hint ? <span className={styles.hint}>{command.hint}</span> : null}
              </Pressable>
            </div>
          )
        })}
      </div>
      <div className={styles.foot}>
        <span>
          <Kbd>↑↓</Kbd>选择
        </span>
        <span>
          <Kbd>↵</Kbd>打开
        </span>
        <span>
          <Kbd>esc</Kbd>关闭
        </span>
      </div>
    </Overlay>
  )
}
