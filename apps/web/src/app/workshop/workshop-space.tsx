import { useGo } from '../model/nav.js'
import { Hammer, LayoutPanelLeft, PanelsTopLeft, Plug, Upload, Wrench } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import { useProductRuntime, useProductStore } from '../../product-runtime.js'
import {
  AgentAvatar,
  Button,
  EmptyState,
  ExtensionIcon,
  FileChooser,
  IconButton,
  ListPane,
  MainContent,
  Pressable,
  SearchField,
  SelectionList,
  StatusDot,
  WorkbenchPage,
  toast,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { agentHue } from '../model/identity.js'
import { useCrumb } from '../shell/crumb.js'
import { ImportDialog } from './import-dialog.js'
import { ExtensionView } from './extension-view.js'
import { McpServerDialog } from './mcp-dialog.js'
import { TaskView } from './task-view.js'
import {
  EXTENSION_GROUPS,
  TASK_GROUP_LABEL,
  extensionUsage,
  isTaskOpen,
  sortTasks,
  taskGroup,
  taskStatus,
  type TaskGroup,
} from './workshop-model.js'
import styles from './workshop.module.css'

type Inspection = HostApiResponse<'inspectExtensionImport'>

type Route = { readonly kind: 'task' | 'extension'; readonly id: string }

const parse = (path: string): Route | undefined => {
  // 社区扩展已移到一级「社区」入口；旧地址跳转过去。
  const match = /^\/workshop\/(tasks|extensions)\/([^/]+)/u.exec(path)
  return match
    ? { kind: match[1] === 'tasks' ? 'task' : 'extension', id: decodeURIComponent(match[2] ?? '') }
    : undefined
}

const matches = (needle: string, ...values: readonly (string | undefined)[]): boolean =>
  !needle || values.some((value) => value?.toLowerCase().includes(needle))

export default function WorkshopSpace() {
  const { pathname } = useLocation()
  const navigate = useGo()
  const hostStatus = useProductStore((state) => state.host.status)
  const allTasks = useProductStore((state) => state.authoringTasks)
  const tasks = useMemo(() => sortTasks(allTasks), [allTasks])
  const extensions = useProductStore((state) => state.extensions)
  const agents = useProductStore((state) => state.agents)
  const requested = parse(pathname)
  // Opening the space without an item shows the first open task (or extension) in this same frame; the address
  // follows afterwards. A <Navigate> here would render an empty canvas for a frame first.
  const fallback: Route | undefined =
    requested || hostStatus === 'initializing'
      ? undefined
      : (() => {
          const first = tasks.find(isTaskOpen) ?? tasks[0]
          if (first) return { kind: 'task', id: first.id }
          return extensions[0] ? { kind: 'extension', id: extensions[0].id } : undefined
        })()
  const route = requested ?? fallback
  useEffect(() => {
    if (fallback)
      navigate(`/workshop/${fallback.kind === 'task' ? 'tasks' : 'extensions'}/${fallback.id}`, { replace: true })
  }, [navigate, fallback?.kind, fallback?.id])
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  const [dropped, setDropped] = useState<File>()
  const [addingMcp, setAddingMcp] = useState(false)
  const importer = useRef<HTMLInputElement>(null)
  const task = route?.kind === 'task' ? tasks.find((item) => item.id === route.id) : undefined
  const extension = route?.kind === 'extension' ? extensions.find((item) => item.id === route.id) : undefined
  useCrumb('工坊', task?.title ?? extension?.name)

  if (pathname.startsWith('/workshop/community')) return <Navigate to="/community" replace />
  if (route && !task && !extension && hostStatus === 'ready') return <Navigate to="/workshop" replace />

  const selected = task ? `task:${task.id}` : extension ? `extension:${extension.id}` : undefined
  const agentOf = (id: string) => agents.find((item) => item.id === id)
  const needle = query.trim().toLowerCase()
  const visibleTasks = tasks.filter((item) => matches(needle, item.title, agentOf(item.agentId)?.name))
  const visibleExtensions = extensions.filter((item) => matches(needle, item.name, item.description))
  const taskGroups = (['attention', 'active', 'ended'] as const satisfies readonly TaskGroup[])
    .map((group) => ({ group, items: visibleTasks.filter((item) => taskGroup(item) === group) }))
    .filter((entry) => entry.items.length > 0)

  const list = (
    <ListPane
      title="工坊"
      label="工坊"
      actions={
        <>
          <IconButton label="添加 MCP 服务" size="small" onClick={() => setAddingMcp(true)}>
            <Plug size={15} />
          </IconButton>
          <IconButton label="导入扩展" size="small" onClick={() => importer.current?.click()}>
            <Upload size={15} />
          </IconButton>
        </>
      }
      toolbar={<SearchField value={query} onChange={setQuery} label="搜索任务和扩展" placeholder="搜索任务和扩展" />}
    >
      <div
        className={styles.dropZone}
        data-extension-drop-zone=""
        data-dragging={dragging || undefined}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDragging(true)
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
          setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer.files[0]
          if (file) setDropped(file)
        }}
      >
        <SelectionList selectedKey={selected}>
          <h3 className={styles.group}>创造任务</h3>
          {tasks.length === 0 ? <p className={styles.groupEmpty}>还没有创造任务</p> : null}
          {taskGroups.map(({ group, items }) => (
            <TaskGroupRows key={group} label={tasks.length > 3 ? TASK_GROUP_LABEL[group] : undefined}>
              {items.map((item) => {
                const status = taskStatus(item)
                const agent = agentOf(item.agentId)
                const key = `task:${item.id}`
                return (
                  <Link
                    key={key}
                    to={`/workshop/tasks/${item.id}`}
                    className={styles.row}
                    data-selected={key === selected}
                    aria-current={key === selected ? 'page' : undefined}
                  >
                    {agent ? (
                      <AgentAvatar
                        name={agent.name}
                        hue={agentHue(agent)}
                        size="sm"
                        live={isTaskOpen(item) && status.tone === 'accent'}
                      />
                    ) : (
                      <span className={styles.rowGlyph}>
                        <Hammer size={14} />
                      </span>
                    )}
                    <span className={styles.rowName}>{item.title}</span>
                    <span className={styles.rowState}>
                      <StatusDot tone={status.tone} />
                    </span>
                    <span className={styles.rowSub}>
                      {status.label} · {relativeTime(item.updatedAt)}
                    </span>
                  </Link>
                )
              })}
            </TaskGroupRows>
          ))}

          <h3 className={styles.group}>扩展库</h3>
          {extensions.length === 0 ? (
            <p className={styles.groupEmpty}>
              还没有扩展。可以
              <Pressable className={styles.inlineLink} onClick={() => importer.current?.click()}>
                导入
              </Pressable>
              一个，或把文件拖到这里。
            </p>
          ) : null}
          {EXTENSION_GROUPS.map(({ scope, label }) => {
            const items = visibleExtensions.filter((item) => item.scope === scope)
            if (items.length === 0) return null
            return (
              <TaskGroupRows key={scope} label={label}>
                {items.map((item) => {
                  const usage = extensionUsage(item)
                  const key = `extension:${item.id}`
                  const latest = item.revisions.at(-1)
                  return (
                    <Link
                      key={key}
                      to={`/workshop/extensions/${item.id}`}
                      className={styles.row}
                      data-selected={key === selected}
                      aria-current={key === selected ? 'page' : undefined}
                    >
                      <ExtensionIcon id={item.id} name={item.name} iconUrl={item.iconUrl} size="md" />
                      <span className={styles.rowName}>{item.name}</span>
                      <span className={styles.rowState}>
                        <StatusDot tone={usage.tone} />
                      </span>
                      <span className={styles.rowSub}>
                        {usage.label}
                        {latest ? ` · ${relativeTime(latest.createdAt)}保存` : ''}
                      </span>
                    </Link>
                  )
                })}
              </TaskGroupRows>
            )
          })}
          {needle && visibleTasks.length === 0 && visibleExtensions.length === 0 ? (
            <p className={styles.groupEmpty}>没有匹配“{query.trim()}”的任务或扩展</p>
          ) : null}
        </SelectionList>
      </div>
    </ListPane>
  )

  return (
    <WorkbenchPage list={list}>
      <ImportFlow input={importer} dropped={dropped} onImported={(id) => navigate(`/workshop/extensions/${id}`)} />
      <McpServerDialog
        open={addingMcp}
        onOpenChange={setAddingMcp}
        onCreated={(id) => navigate(`/workshop/extensions/${id}`)}
      />
      {task ? (
        <TaskView key={task.id} task={task} />
      ) : extension ? (
        <ExtensionView key={extension.id} extension={extension} />
      ) : hostStatus === 'initializing' ? null : (
        <Start onImport={() => importer.current?.click()} onAddMcp={() => setAddingMcp(true)} />
      )}
    </WorkbenchPage>
  )
}

function TaskGroupRows({ label, children }: { readonly label: string | undefined; readonly children: ReactNode }) {
  return (
    <>
      {label ? <div className={styles.subgroup}>{label}</div> : null}
      {children}
    </>
  )
}

const EXAMPLES = [
  {
    kind: '工具',
    icon: <Wrench size={18} />,
    title: '让智能体多一项本领',
    sample: '查询本周天气并整理成三行摘要',
    request: '帮我做一个工具：查询指定城市本周天气，并整理成三行摘要发到频道里。',
  },
  {
    kind: '面板',
    icon: <LayoutPanelLeft size={18} />,
    title: '在智能体页或频道旁边多一块信息',
    sample: '频道今日话题统计面板',
    request: '帮我做一个面板：在频道检查器里显示今天的话题统计和活跃成员。',
  },
  {
    kind: '页面',
    icon: <PanelsTopLeft size={18} />,
    title: '一个独立的小应用',
    sample: '团队采购清单页面',
    request: '帮我做一个页面：记录团队采购清单，可以勾选已购并统计花费。',
  },
] as const

/**
 * Nothing made yet. Extensions are created by asking an agent in one of its channels; each example opens such a
 * channel with the request already typed.
 */
function Start({ onImport, onAddMcp }: { readonly onImport: () => void; readonly onAddMcp: () => void }) {
  const agents = useProductStore((state) => state.agents)
  const ui = useProductRuntime().uiStore
  const navigate = useGo()
  const creators = agents.filter((agent) => agent.capabilities.dynamicCreation && agent.channels[0] !== undefined)
  const first = creators[0]
  const ask = (request: string, channelId: string | undefined) => {
    if (!channelId) return
    ui.getState().setChannelDraft(channelId, request)
    navigate(`/channels/${channelId}`)
  }
  return (
    <MainContent width="readable">
      <div className={styles.start}>
        <EmptyState icon={<Hammer size={22} />} title="让智能体为你做新能力">
          扩展能让智能体多一项本领、在界面上多一块信息，或者成为一个独立的小应用。在频道里描述需求，智能体会写好、试运行，确认后保存到这里。
        </EmptyState>
        <div className={styles.examples}>
          {EXAMPLES.map((example) => (
            <Pressable
              key={example.kind}
              className={styles.example}
              disabled={!first}
              onClick={() => ask(example.request, first?.channels[0])}
            >
              <span className={styles.exampleIcon}>{example.icon}</span>
              <span className={styles.exampleKind}>{example.kind}</span>
              <b>{example.title}</b>
              <span className={styles.exampleSample}>例如：{example.sample}</span>
            </Pressable>
          ))}
        </div>
        <div className={styles.startFoot}>
          {creators.length > 0 ? (
            <div className={styles.creators}>
              <span className={styles.faint}>可以创造的智能体</span>
              {creators.map((agent) => (
                <Button
                  key={agent.id}
                  size="small"
                  onClick={() => agent.channels[0] && navigate(`/channels/${agent.channels[0]}`)}
                >
                  <AgentAvatar name={agent.name} hue={agentHue(agent)} size="xs" />
                  {agent.name}
                </Button>
              ))}
            </div>
          ) : (
            <div className={styles.creators}>
              <span className={styles.faint}>还没有智能体开启“动态创造”</span>
              <Button size="small" onClick={() => navigate(agents[0] ? `/agents/${agents[0].id}` : '/agents/new')}>
                {agents[0] ? '去开启' : '新建智能体'}
              </Button>
            </div>
          )}
          <span className={styles.startActions}>
            <Button size="small" variant="ghost" icon={<Plug size={14} />} onClick={onAddMcp}>
              添加 MCP 服务
            </Button>
            <Button size="small" variant="ghost" icon={<Upload size={14} />} onClick={onImport}>
              导入扩展文件
            </Button>
          </span>
        </div>
      </div>
    </MainContent>
  )
}

/** Imports a `.nxt-extension` chosen with a button or dropped anywhere on the workshop list. */
function ImportFlow({
  input,
  dropped,
  onImported,
}: {
  readonly input: RefObject<HTMLInputElement>
  readonly dropped: File | undefined
  readonly onImported: (extensionId: string) => void
}) {
  const [inspection, setInspection] = useState<Inspection>()

  const inspect = async (file: File) => {
    try {
      setInspection(
        await callHostApi(
          HostApiContracts.inspectExtensionImport,
          {},
          { bytes: new Uint8Array(await file.arrayBuffer()) },
        ),
      )
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    }
  }
  useEffect(() => {
    if (dropped) void inspect(dropped)
    // A new drop is a new File object; inspect each one once.
  }, [dropped])

  return (
    <>
      <FileChooser ref={input} accept=".nxt-extension,.zip,application/zip" onFile={(file) => void inspect(file)} />
      <ImportDialog
        inspection={inspection}
        note={null}
        onClose={() => setInspection(undefined)}
        onImported={(id) => {
          setInspection(undefined)
          onImported(id)
        }}
      />
    </>
  )
}
