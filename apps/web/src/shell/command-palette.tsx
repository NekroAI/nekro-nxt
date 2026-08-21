import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import styles from '../app.module.css'
import { useProductStore } from '../product-store.js'
import { Button, Dialog, Input } from '../ui-kit/index.js'
import { useNxtNavigate } from './nxt-link.js'

interface CommandItem {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly to: string
  readonly keywords: string
}

const fixedCommands: readonly CommandItem[] = [
  { id: 'work', label: '打开工作区', description: '返回频道与智能体', to: '/work', keywords: '工作 频道 智能体' },
  {
    id: 'new-agent',
    label: '创建智能体',
    description: '新建智能体草稿',
    to: '/work/agents/new',
    keywords: '新建 创建 智能体',
  },
  {
    id: 'creator',
    label: '打开创造工作台',
    description: '与智能体协作创造',
    to: '/work/creator',
    keywords: '创造 扩展 动态',
  },
  {
    id: 'connections',
    label: '管理平台连接',
    description: '查看平台账号',
    to: '/connections',
    keywords: '连接 平台 账号',
  },
  {
    id: 'extensions',
    label: '管理本地扩展',
    description: '查看扩展版本和启用关系',
    to: '/extensions',
    keywords: '扩展 版本 启用',
  },
  { id: 'settings', label: '打开设置', description: '模型、扩展与外观', to: '/settings', keywords: '设置 模型 外观' },
]

export function CommandPalette() {
  const navigate = useNxtNavigate()
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([])

  const commands = useMemo<readonly CommandItem[]>(
    () => [
      ...fixedCommands,
      ...channels.map((channel) => ({
        id: `channel:${channel.id}`,
        label: channel.name,
        description: `打开频道 · ${channel.connectionName}`,
        to: `/work/channels/${encodeURIComponent(channel.id)}`,
        keywords: `频道 ${channel.name} ${channel.connectionName}`,
      })),
      ...agents.map((agent) => ({
        id: `agent:${agent.id}`,
        label: agent.name,
        description: '管理智能体',
        to: `/work/agents/${encodeURIComponent(agent.id)}`,
        keywords: `智能体 ${agent.name}`,
      })),
    ],
    [agents, channels],
  )

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    if (!normalized) return commands
    return commands.filter((command) =>
      `${command.label} ${command.description} ${command.keywords}`.toLocaleLowerCase('zh-CN').includes(normalized),
    )
  }, [commands, query])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase('en-US') === 'k') {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const run = (command: CommandItem): void => {
    setOpen(false)
    setQuery('')
    navigate(command.to)
  }

  const focusResult = (index: number): void => {
    const bounded = (index + results.length) % results.length
    resultRefs.current[bounded]?.focus()
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault()
      focusResult(0)
    } else if (event.key === 'Enter' && results[0]) {
      event.preventDefault()
      run(results[0])
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
      className={styles.commandPalette}
      title="命令面板"
      description="搜索页面、频道和智能体。"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-command-search]')?.focus())
      }}
    >
      <div className={styles.commandSearch}>
        <Search size={16} aria-hidden="true" />
        <Input
          data-command-search=""
          aria-label="搜索命令"
          placeholder="输入命令或名称"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <kbd>Esc</kbd>
      </div>
      <div className={styles.commandResults} aria-label="命令结果">
        {results.length > 0 ? (
          results.map((command, index) => (
            <Button
              className={styles.commandResult}
              key={command.id}
              ref={(node) => {
                resultRefs.current[index] = node
              }}
              onClick={() => run(command)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  focusResult(index + 1)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  if (index === 0) document.querySelector<HTMLInputElement>('[data-command-search]')?.focus()
                  else focusResult(index - 1)
                }
              }}
            >
              <span>{command.label}</span>
              <small>{command.description}</small>
            </Button>
          ))
        ) : (
          <p className={styles.commandEmpty}>没有匹配的命令。</p>
        )}
      </div>
    </Dialog>
  )
}
