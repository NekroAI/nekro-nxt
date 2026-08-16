import * as Tabs from '@radix-ui/react-tabs'
import {
  Activity,
  ArrowRight,
  Bot,
  Boxes,
  Cable,
  CircleStop,
  File,
  FlaskConical,
  Image,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Send,
  Settings,
  Sparkles,
  UsersRound,
} from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import styles from './app.module.css'
import {
  useProductStore,
  type AgentRuntimeState,
  type ConnectionState,
  type DeliveryState,
  type ThemeChoice,
} from './product-store.js'
import {
  Button,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  Panel,
  SelectField,
  StatusBadge,
  SwitchField,
  Textarea,
  Tooltip,
  type StatusTone,
} from './ui-kit/index.js'

const navItems = [
  { to: '/agents', label: '智能体', icon: Bot },
  { to: '/connections', label: '频道与连接', icon: Cable },
  { to: '/extensions', label: '本地扩展', icon: Boxes },
  { to: '/creator', label: '创造工作台', icon: Sparkles },
  { to: '/runtime', label: '运行与诊断', icon: Activity },
  { to: '/settings', label: '设置', icon: Settings },
] as const

const agentTone = (state: AgentRuntimeState): StatusTone => {
  if (state === '空闲') return 'success'
  if (state === '思考中' || state === '使用工具') return 'info'
  if (state === '等待输入') return 'warning'
  if (state === '不可用') return 'error'
  return 'neutral'
}

const deliveryTone = (state: DeliveryState): StatusTone => {
  if (state === '已发送') return 'success'
  if (state === '发送中') return 'info'
  if (state === '部分发送') return 'warning'
  if (state === '失败') return 'error'
  return 'unknown'
}

const connectionTone = (state: ConnectionState): StatusTone => {
  if (state === '已连接') return 'success'
  if (state === '正在连接') return 'info'
  if (state === '认证过期') return 'warning'
  if (state === '异常') return 'error'
  return 'neutral'
}

function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly actions?: ReactNode
}) {
  return (
    <header className={styles.pageHeader}>
      <div>
        <div className={styles.eyebrow}>{eyebrow}</div>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.subtitle}>{description}</p>
      </div>
      {actions ? <div className={styles.headerActions}>{actions}</div> : null}
    </header>
  )
}

function AppShell() {
  const location = useLocation()
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.mark} aria-hidden="true" />
          <div>
            <div className={styles.brandName}>NekroNxt</div>
            <div className={styles.brandMeta}>Local Node</div>
          </div>
        </div>
        <nav className={styles.nav} aria-label="主导航">
          {navItems.map(({ to, label, icon: Icon }, index) => (
            <NavLink
              to={to}
              className={({ isActive }) =>
                [styles.navLink, isActive ? styles.navLinkActive : '', index === 4 ? styles.navSpacer : '']
                  .filter(Boolean)
                  .join(' ')
              }
              key={to}
            >
              <Icon size={16} strokeWidth={1.8} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          <div className={styles.nodeStatus}>
            <span className={styles.statusPulse} />
            <span>节点正常</span>
            <span>v0.1</span>
          </div>
        </div>
      </aside>
      <main className={styles.main} key={location.pathname.split('/')[1]}>
        <Outlet />
      </main>
    </div>
  )
}

function AgentsPage() {
  const agents = useProductStore((state) => state.agents)
  const navigate = useNavigate()
  const channelCount = useProductStore((state) => state.channels.length)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="智能体集合"
        title="智能体"
        description="创建长期智能体，查看它们的运行状态，并从绑定的频道继续工作。"
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> 创建智能体
          </Button>
        }
      />
      <div className={styles.summaryGrid}>
        <Panel className={styles.summaryItem}>
          <div className={styles.summaryLabel}>智能体</div>
          <div className={styles.summaryValue}>{agents.length}</div>
        </Panel>
        <Panel className={styles.summaryItem}>
          <div className={styles.summaryLabel}>监听中的频道</div>
          <div className={styles.summaryValue}>{channelCount}</div>
        </Panel>
        <Panel className={styles.summaryItem}>
          <div className={styles.summaryLabel}>正在执行</div>
          <div className={styles.summaryValue}>{agents.filter(({ state }) => state === '使用工具').length}</div>
        </Panel>
      </div>
      <h2 className={styles.sectionTitle}>全部智能体</h2>
      <div className={styles.agentList}>
        {agents.map((agent) => (
          <Panel className={styles.agentRow} key={agent.id}>
            <div className={styles.avatar}>{agent.name.slice(0, 1)}</div>
            <div>
              <div className={styles.agentName}>{agent.name}</div>
              <div className={styles.agentDescription}>{agent.description}</div>
            </div>
            <div className={styles.agentMeta}>
              <div>{agent.model}</div>
              <div className={styles.metaText}>
                {agent.channels.length} 个频道 · {agent.extensionCount} 个本地扩展
              </div>
            </div>
            <StatusBadge tone={agentTone(agent.state)}>{agent.state}</StatusBadge>
            <div className={styles.agentActions}>
              <Button
                size="small"
                onClick={() => {
                  void navigate(`/channels/${agent.channels[0] ?? 'web-main'}`)
                }}
              >
                打开
              </Button>
              <Button
                size="small"
                variant="ghost"
                onClick={() => {
                  void navigate(`/agents/${agent.id}`)
                }}
              >
                管理
              </Button>
            </div>
          </Panel>
        ))}
      </div>
      <ConfirmDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="创建智能体"
        description="创建首个不可变配置，并自动建立一个本地 Web 频道。默认不启用动态创造、Shell 或完整文件访问。"
        confirmLabel="创建智能体"
        onConfirm={() => {
          const name = newName.trim()
          if (!name) return
          useProductStore.getState().createAgent({ name, model: 'DeepSeek V4 · 标准' })
          setNewName('')
        }}
      >
        <div className={styles.formStack}>
          <Field label="显示名称">
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} autoFocus />
          </Field>
          <SelectField
            label="模型"
            value="deepseek-v4"
            onValueChange={() => undefined}
            options={[{ value: 'deepseek-v4', label: 'DeepSeek V4 · 标准' }]}
          />
        </div>
      </ConfirmDialog>
    </div>
  )
}

function AgentManagePage() {
  const { agentId = '' } = useParams()
  const agent = useProductStore((state) => state.agents.find(({ id }) => id === agentId))
  if (!agent) return <NotFoundPage />
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="智能体管理"
        title={agent.name}
        description="修改会创建新的不可变配置；兼容变更在安全间隙应用，不兼容变更安排会话交接。"
        actions={
          <>
            <Button variant="ghost">放弃更改</Button>
            <Button variant="primary">
              <Save size={15} /> 保存为新配置
            </Button>
          </>
        }
      />
      <Tabs.Root defaultValue="profile">
        <Tabs.List className={styles.tabsList}>
          {[
            ['profile', '人设与模型'],
            ['channels', '频道'],
            ['capabilities', '能力'],
            ['extensions', '扩展'],
          ].map(([value, label]) => (
            <Tabs.Trigger className={styles.tabTrigger} value={value!} key={value}>
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="profile">
          <div className={styles.connectionLayout}>
            <Panel className={styles.settingSection}>
              <div className={styles.formStack}>
                <Field label="显示名称">
                  <Input defaultValue={agent.name} />
                </Field>
                <Field label="人设" hint="这一内容会进入新配置 Revision。">
                  <Textarea defaultValue="冷静、准确地协助频道成员，并在关键结论中说明证据。" />
                </Field>
                <SelectField
                  label="模型"
                  value="deepseek-v4"
                  onValueChange={() => undefined}
                  options={[{ value: 'deepseek-v4', label: 'DeepSeek V4 · 高推理' }]}
                />
              </div>
            </Panel>
            <Panel className={styles.detailPanel}>
              <h2 className={styles.detailTitle}>配置影响</h2>
              <div className={styles.notice}>
                显示名可在原会话安全切换；人设或模型变化会创建新 Episode 并生成交接摘要。
              </div>
            </Panel>
          </div>
        </Tabs.Content>
        <Tabs.Content value="channels">
          <Panel className={styles.settingSection}>
            <p className={styles.rowDescription}>当前绑定 {agent.channels.length} 个频道。频道事实流彼此隔离。</p>
            <Button variant="secondary">
              <Plus size={14} /> 新增频道绑定
            </Button>
          </Panel>
        </Tabs.Content>
        <Tabs.Content value="capabilities">
          <div className={styles.capabilityList}>
            <div className={styles.capabilityItem}>
              <SwitchField
                label="动态创造"
                description="允许同一智能体定义和运行临时 Tool 与 Client UI。"
                checked={agent.capabilities.dynamicCreation}
                onCheckedChange={(enabled) =>
                  useProductStore.getState().setCapability(agent.id, 'dynamicCreation', enabled)
                }
              />
            </div>
            <div className={styles.capabilityItem}>
              <SwitchField
                label="开发 Shell"
                description="只在明确开发工作区中启用受控命令与文件工具。"
                checked={agent.capabilities.developmentShell}
                onCheckedChange={(enabled) =>
                  useProductStore.getState().setCapability(agent.id, 'developmentShell', enabled)
                }
              />
            </div>
            <div className={styles.capabilityItem}>
              <SwitchField
                label="完整文件访问"
                description="只提升已启用文件能力的策略，不会自动启用 Shell。"
                checked={agent.capabilities.fullFileAccess}
                onCheckedChange={(enabled) =>
                  useProductStore.getState().setCapability(agent.id, 'fullFileAccess', enabled)
                }
              />
            </div>
          </div>
        </Tabs.Content>
        <Tabs.Content value="extensions">
          <Panel className={styles.settingSection}>已激活的本地扩展会在安全间隙切换，不修改运行中的 Tool。</Panel>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

function ChannelConversationPage() {
  const { channelId = 'web-main' } = useParams()
  const channels = useProductStore((state) => state.channels)
  const agents = useProductStore((state) => state.agents)
  const messages = useProductStore((state) => state.messages.filter((message) => message.channelId === channelId))
  const [draft, setDraft] = useState('')
  const channel = channels.find(({ id }) => id === channelId) ?? channels[0]!
  const agent = agents.find(({ id }) => id === channel.agentId)!
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = draft.trim()
    if (!value) return
    useProductStore.getState().sendMessage(channel.id, value)
    setDraft('')
  }
  return (
    <div className={styles.pageWide}>
      <div className={styles.conversation}>
        <aside className={styles.channelRail}>
          <div className={styles.railTitle}>频道</div>
          {channels.map((item) => (
            <Link
              to={`/channels/${item.id}`}
              className={[styles.channelLink, item.id === channel.id ? styles.channelLinkActive : '']
                .filter(Boolean)
                .join(' ')}
              key={item.id}
            >
              {item.kind === 'web' ? <MessageSquare size={14} /> : <UsersRound size={14} />}
              <span>{item.name}</span>
              {item.unread ? <span className={styles.unread}>{item.unread}</span> : null}
            </Link>
          ))}
        </aside>
        <section className={styles.conversationMain}>
          <header className={styles.conversationHeader}>
            <div>
              <div className={styles.conversationTitle}>{channel.name}</div>
              <div className={styles.conversationSubtitle}>
                由“{agent.name}”响应 · {channel.trigger}
              </div>
            </div>
            <div className={styles.headerActions}>
              <StatusBadge tone={agentTone(agent.state)}>{agent.state}</StatusBadge>
              <IconButton label="查看运行详情">
                <Activity size={15} />
              </IconButton>
              <IconButton label="更多频道操作">
                <MoreHorizontal size={16} />
              </IconButton>
            </div>
          </header>
          <div className={styles.messageList} aria-live="polite">
            {messages.map((message) =>
              message.role === 'system' ? (
                <div className={styles.systemMessage} key={message.id}>
                  {message.body}
                </div>
              ) : (
                <article className={styles.message} key={message.id}>
                  <div className={styles.messageAvatar}>{message.author.slice(0, 1)}</div>
                  <div>
                    <div className={styles.messageHeader}>
                      <span className={styles.messageAuthor}>{message.author}</span>
                      <span className={styles.messageTime}>{message.time}</span>
                      {message.delivery ? (
                        <StatusBadge tone={deliveryTone(message.delivery)}>{message.delivery}</StatusBadge>
                      ) : null}
                    </div>
                    <div className={styles.messageBody}>{message.body}</div>
                    {message.attachment ? (
                      <div className={styles.attachment}>
                        {message.attachment.kind === 'image' ? <Image size={16} /> : <File size={16} />}
                        <span>{message.attachment.name}</span>
                      </div>
                    ) : null}
                  </div>
                </article>
              ),
            )}
          </div>
          <form className={styles.composer} onSubmit={submit}>
            <div className={styles.composerTarget}>
              {channel.kind === 'web'
                ? `发送给：${agent.name}`
                : `发送到：${channel.name}（通过 ${channel.connectionName}）`}
            </div>
            <div className={styles.composerBox}>
              <textarea
                className={styles.composerInput}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="输入消息；智能体可见回复仍只由通信工具产生"
                aria-label="消息内容"
              />
              <div className={styles.headerActions}>
                <IconButton label="添加附件" type="button">
                  <Paperclip size={16} />
                </IconButton>
                <Button variant="primary" type="submit" disabled={!draft.trim()}>
                  <Send size={15} /> 发送
                </Button>
              </div>
            </div>
          </form>
        </section>
        <aside className={styles.inspector}>
          <div className={styles.inspectorSection}>
            <h2 className={styles.inspectorTitle}>当前绑定</h2>
            <dl className={styles.definitionList}>
              <dt>智能体</dt>
              <dd>{agent.name}</dd>
              <dt>触发</dt>
              <dd>{channel.trigger}</dd>
              <dt>连接</dt>
              <dd>{channel.connectionName}</dd>
              <dt>频道隔离</dt>
              <dd>已启用</dd>
            </dl>
          </div>
          <div className={styles.inspectorSection}>
            <h2 className={styles.inspectorTitle}>运行状态</h2>
            <div className={styles.notice}>当前 Tool 正在执行。新消息会可靠入库，并在安全间隙纳入下一步思考。</div>
          </div>
          <div className={styles.inspectorSection}>
            <Button variant="danger" size="small">
              <CircleStop size={14} /> 停止当前任务
            </Button>
          </div>
        </aside>
      </div>
    </div>
  )
}

function ConnectionsPage() {
  const connections = useProductStore((state) => state.connections)
  const [selectedId, setSelectedId] = useState(connections[0]?.id ?? '')
  const [createOpen, setCreateOpen] = useState(false)
  const [connectionName, setConnectionName] = useState('QQ 机器人账号')
  const [connectionAppId, setConnectionAppId] = useState('')
  const [connectionCredential, setConnectionCredential] = useState('credential:qq-')
  const selected = connections.find(({ id }) => id === selectedId) ?? connections[0]
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="频道与连接"
        title="连接账号"
        description="每个 Connection 拥有自己的账号、凭据引用、频道目录和运行状态。"
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> 添加连接
          </Button>
        }
      />
      <div className={styles.connectionLayout}>
        <div className={styles.connectionList}>
          {connections.map((connection) => (
            <Panel className={styles.connectionRow} key={connection.id}>
              <div className={styles.rowHeader}>
                <div>
                  <div className={styles.rowTitle}>{connection.name}</div>
                  <div className={styles.rowDescription}>{connection.adapter}</div>
                </div>
                <StatusBadge tone={connectionTone(connection.state)}>{connection.state}</StatusBadge>
              </div>
              <div className={styles.rowMeta}>
                <span>{connection.channels} 个频道</span>
                <span>最近事件：{connection.lastEvent}</span>
                <button className={styles.channelLink} onClick={() => setSelectedId(connection.id)}>
                  配置与诊断 <ArrowRight size={13} />
                </button>
              </div>
            </Panel>
          ))}
        </div>
        {selected ? (
          <Panel className={styles.detailPanel}>
            <h2 className={styles.detailTitle}>{selected.name}</h2>
            <div className={styles.formStack}>
              <Field label="App ID">
                <Input
                  value={selected.appId}
                  onChange={(event) =>
                    useProductStore.getState().updateConnection(selected.id, { appId: event.target.value })
                  }
                />
              </Field>
              <Field label="Client Secret" hint="Secret 只保存到凭据存储；普通配置中只记录引用。">
                <Input
                  value={selected.credentialRef}
                  onChange={(event) =>
                    useProductStore.getState().updateConnection(selected.id, { credentialRef: event.target.value })
                  }
                />
              </Field>
              <SwitchField
                label="允许主动发送"
                description="被动回复额度不可用时，允许使用平台主动发送能力。"
                checked={selected.proactiveSend}
                onCheckedChange={(enabled) =>
                  useProductStore.getState().updateConnection(selected.id, { proactiveSend: enabled })
                }
              />
              <div className={styles.formDivider} />
              <div className={styles.testGrid}>
                <div className={styles.testBox}>
                  <div className={styles.testLabel}>接收测试</div>
                  <div className={styles.testResult}>{selected.receiveTest}</div>
                  <Button
                    size="small"
                    onClick={() => useProductStore.getState().runConnectionTest(selected.id, 'receive')}
                  >
                    <Radio size={13} /> 测试接收
                  </Button>
                </div>
                <div className={styles.testBox}>
                  <div className={styles.testLabel}>发送测试</div>
                  <div className={styles.testResult}>{selected.sendTest}</div>
                  <Button
                    size="small"
                    onClick={() => useProductStore.getState().runConnectionTest(selected.id, 'send')}
                  >
                    <Send size={13} /> 发送测试消息
                  </Button>
                </div>
              </div>
              <Button variant="primary">
                <Save size={14} /> 保存连接配置
              </Button>
            </div>
          </Panel>
        ) : null}
      </div>
      <ConfirmDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="添加 QQ Connection"
        description="一个 Connection 对应一个机器人账号；Secret 本身不会进入普通配置。"
        confirmLabel="创建连接"
        onConfirm={() => {
          if (!connectionName.trim() || !connectionAppId.trim() || !connectionCredential.trim()) return
          useProductStore.getState().createConnection({
            name: connectionName.trim(),
            appId: connectionAppId.trim(),
            credentialRef: connectionCredential.trim(),
          })
          setConnectionAppId('')
        }}
      >
        <div className={styles.formStack}>
          <Field label="连接名称">
            <Input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} />
          </Field>
          <Field label="App ID">
            <Input value={connectionAppId} onChange={(event) => setConnectionAppId(event.target.value)} />
          </Field>
          <Field label="凭据引用" hint="实际 Client Secret 由 Host 的凭据存储管理。">
            <Input value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} />
          </Field>
        </div>
      </ConfirmDialog>
    </div>
  )
}

function ExtensionsPage() {
  const extensions = useProductStore((state) => state.extensions)
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="本地扩展"
        title="扩展与启用"
        description="动态运行、保存 Revision 和给智能体启用是三个独立动作。"
        actions={<Button variant="primary">导入本地扩展</Button>}
      />
      <div className={styles.extensionList}>
        {extensions.map((extension) => (
          <Panel className={styles.extensionRow} key={extension.id}>
            <div className={styles.rowHeader}>
              <div>
                <div className={styles.rowTitle}>{extension.name}</div>
                <div className={styles.rowDescription}>{extension.description}</div>
              </div>
              <StatusBadge tone={extension.activation === '已激活' ? 'success' : 'warning'}>
                {extension.activation}
              </StatusBadge>
            </div>
            <div className={styles.rowMeta}>
              <span>Revision {extension.revision}</span>
              <span>目标：{extension.targetAgent}</span>
              <span>{extension.contributions.join(' · ')}</span>
              <Button
                size="small"
                variant={extension.activation === '已激活' ? 'danger' : 'secondary'}
                onClick={() =>
                  useProductStore.getState().setExtensionActive(extension.id, extension.activation !== '已激活')
                }
              >
                {extension.activation === '已激活' ? '停用此智能体上的启用' : '启用给小奈'}
              </Button>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  )
}

function CreatorPage() {
  const approval = useProductStore((state) => state.approvals[0])
  const [reviewOpen, setReviewOpen] = useState(false)
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="创造工作台"
        title="为“小奈”创建能力"
        description="同一智能体在获得动态创造授权后表现出的工作状态；不会创建另一个智能体。"
        actions={
          <Button variant="primary">
            <Sparkles size={15} /> 继续修改
          </Button>
        }
      />
      <div className={styles.creatorLayout}>
        <Panel className={styles.creatorRail}>
          <h2 className={styles.detailTitle}>Extension Draft</h2>
          <div className={styles.draftItem}>
            <div className={styles.draftName}>需求描述</div>
            <div className={styles.draftMeta}>已完成</div>
          </div>
          <div className={styles.draftItem}>
            <div className={styles.draftName}>动态 Package draft-4</div>
            <div className={styles.draftMeta}>等待 Client UI 批准</div>
          </div>
          <div className={styles.draftItem}>
            <div className={styles.draftName}>保存为本地扩展</div>
            <div className={styles.draftMeta}>尚未执行</div>
          </div>
        </Panel>
        <div className={styles.formStack}>
          {approval ? (
            <div className={styles.approval}>
              <div className={styles.approvalTitle}>{approval.title}</div>
              <div className={styles.approvalBody}>{approval.purpose}</div>
              <StatusBadge tone={approval.state === '等待批准' ? 'warning' : 'success'}>
                {approval.state}
              </StatusBadge>{' '}
              {approval.state === '等待批准' ? (
                <Button size="small" onClick={() => setReviewOpen(true)}>
                  审查并决定
                </Button>
              ) : null}
            </div>
          ) : null}
          <Panel className={styles.settingSection}>
            <h2 className={styles.detailTitle}>真实验证结果</h2>
            <div className={styles.codePanel}>{`构建            通过
Host Tool       已加载
Client UI       等待批准
停止与卸载      通过
目标智能体       小奈`}</div>
            <div className={styles.headerActions}>
              <Button>
                <FlaskConical size={14} /> 重新验证
              </Button>
              <Button variant="primary" disabled={approval?.state !== '已批准'}>
                保存为本地扩展
              </Button>
            </div>
          </Panel>
        </div>
      </div>
      {approval ? (
        <ConfirmDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          title="批准动态 Client UI"
          description="该 Package 将在当前浏览器中注册预览 Slot。批准只影响本次动态运行，不会自动保存或给其他智能体启用。"
          confirmLabel="批准本次运行"
          onConfirm={() => useProductStore.getState().resolveApproval(approval.id, true)}
        >
          <div className={styles.codePanel}>{approval.packageName}</div>
        </ConfirmDialog>
      ) : null}
    </div>
  )
}

function RuntimePage() {
  const note = useProductStore((state) => state.diagnosticNote)
  const events = [
    ['12:45:08', '通信工具提交逻辑消息', 'PhysicalDelivery 1/2 已发送'],
    ['12:45:05', 'Tool 正在运行', 'workspace-write 文件检查'],
    ['12:44:58', '3 条新消息已收录', '等待安全间隙注入'],
    ['12:44:41', 'QQ Gateway resume', 'session checkpoint 42'],
    ['12:44:39', 'Admission 已写入 Session', 'followup · dsh-message-81'],
  ] as const
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="运行与诊断"
        title="当前运行"
        description="内部模型输出、Tool、通信工具、平台回执和待注入消息在这里分开观察。"
        actions={
          <Button>
            <RefreshCw size={14} /> 刷新状态
          </Button>
        }
      />
      <div className={styles.runtimeGrid}>
        <Panel className={styles.settingSection}>
          <h2 className={styles.detailTitle}>小奈 · Web 控制台</h2>
          <div className={styles.timeline}>
            {events.map(([time, title, detail]) => (
              <div className={styles.timelineItem} key={`${time}-${title}`}>
                <div className={styles.timelineTime}>{time}</div>
                <div className={styles.timelineMarker} />
                <div className={styles.timelineText}>
                  {title}
                  <div className={styles.timelineDetail}>{detail}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <div className={styles.formStack}>
          <Panel className={styles.settingSection}>
            <h2 className={styles.detailTitle}>节点健康</h2>
            <div className={styles.notice}>{note}</div>
            <div className={styles.rowMeta}>
              <StatusBadge tone="success">Core 正常</StatusBadge>
              <StatusBadge tone="success">DSH 正常</StatusBadge>
              <StatusBadge tone="success">Gateway 正常</StatusBadge>
            </div>
          </Panel>
          <Panel className={styles.settingSection}>
            <h2 className={styles.detailTitle}>恢复与备份</h2>
            <p className={styles.rowDescription}>最近备份：今天 12:00 · Core 与 DSH SQLite 均可读</p>
            <Button size="small">创建验证备份</Button>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function SettingsPage() {
  const theme = useProductStore((state) => state.theme)
  const reducedMotion = useProductStore((state) => state.reducedMotion)
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="设置"
        title="界面与运行偏好"
        description="主题切换不重载页面；减少动态后仍保留即时状态反馈。"
      />
      <div className={styles.settingsLayout}>
        <div>
          <Panel className={styles.settingSection}>
            <h2 className={styles.detailTitle}>外观</h2>
            <div className={styles.formStack}>
              <SelectField
                label="主题"
                value={theme}
                onValueChange={(value) => useProductStore.getState().setTheme(value as ThemeChoice)}
                options={[
                  { value: 'system', label: '跟随系统' },
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                ]}
              />
              <SwitchField
                label="减少动态效果"
                description="关闭页面位移和浮层过渡，保留颜色与文字反馈。"
                checked={reducedMotion}
                onCheckedChange={(enabled) => useProductStore.getState().setReducedMotion(enabled)}
              />
            </div>
          </Panel>
          <Panel className={styles.settingSection}>
            <h2 className={styles.detailTitle}>本地数据</h2>
            <p className={styles.rowDescription}>Desktop 与 Server 使用同一数据格式；升级前会先创建可验证备份。</p>
            <Button>打开备份与恢复</Button>
          </Panel>
        </div>
        <Panel className={styles.detailPanel}>
          <h2 className={styles.detailTitle}>界面原则</h2>
          <div className={styles.notice}>青蓝只用于焦点、选择和运行信号。错误、警告与未知结果保持独立语义色。</div>
        </Panel>
      </div>
    </div>
  )
}

function NotFoundPage() {
  return (
    <div className={styles.page}>
      <div className={styles.empty}>
        <div>
          <h1 className={styles.title}>页面不存在</h1>
          <p className={styles.subtitle}>这个入口尚未建立，或对象已经被移除。</p>
          <Button variant="primary" onClick={() => window.history.back()}>
            返回上一页
          </Button>
        </div>
      </div>
    </div>
  )
}

function ThemeEffects() {
  const theme = useProductStore((state) => state.theme)
  const reducedMotion = useProductStore((state) => state.reducedMotion)
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
    document.documentElement.dataset.reducedMotion = String(reducedMotion)
  }, [theme, reducedMotion])
  return null
}

export function NekroNxtApp() {
  const providerProps = useMemo(() => ({ delayDuration: 450 }), [])
  return (
    <Tooltip.Provider {...providerProps}>
      <ThemeEffects />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/agents" replace />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:agentId" element={<AgentManagePage />} />
          <Route path="channels/:channelId" element={<ChannelConversationPage />} />
          <Route path="connections" element={<ConnectionsPage />} />
          <Route path="extensions" element={<ExtensionsPage />} />
          <Route path="creator" element={<CreatorPage />} />
          <Route path="runtime" element={<RuntimePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Tooltip.Provider>
  )
}
