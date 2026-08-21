const icons = {
  work: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  connect:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9a5 5 0 0 1 8-1l2 2"/><path d="M20 15a5 5 0 0 1-8 1l-2-2"/><path d="M8 12h8"/></svg>',
  boxes:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/></svg>',
  settings:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 1v2.5M12 20.5V23M4.2 4.2l1.8 1.8M18 18l1.8 1.8M1 12h2.5M20.5 12H23M4.2 19.8 6 18M18 6l1.8-1.8"/></svg>',
  bubble:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  users:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  pack:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/></svg>',
  key: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="15" r="4"/><path d="M10.8 13.2 21 3"/><path d="M17 3h4v4"/></svg>',
  puzzle:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2v4a2 2 0 1 0 4 0V2h4v6h-2a2 2 0 1 0 0 4h2v6h-6v-2a2 2 0 1 0-4 0v2H4v-6h2a2 2 0 1 0 0-4H4V2z"/></svg>',
  sun: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  check:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 12 5 5L20 7"/></svg>',
}

const triggers = [
  { id: 'mention', label: '被提及或回复时' },
  { id: 'always', label: '每条消息' },
  { id: 'command', label: '收到命令时' },
  { id: 'watch', label: '仅观察' },
]

const capabilities = [
  { id: 'subagents', label: '子智能体', risk: '低风险', riskTone: 'info', description: '允许在后台委派独立任务，主智能体可同时继续处理频道消息。' },
  { id: 'webSearch', label: '网页搜索', risk: '外部服务', riskTone: 'warn', description: '通过已配置的 DeepSeek Web Provider 搜索外部信息；搜索内容不可信且会产生额外费用。' },
  { id: 'dynamicCreation', label: '动态创造', risk: '中风险', riskTone: 'warn', description: '允许这个智能体创建并试运行临时扩展。' },
  { id: 'fileTools', label: '文件工具', risk: '高风险', riskTone: 'warn', description: '允许读取文件，并在智能体开发工作区中写入文件；读取范围取决于宿主进程权限。' },
  { id: 'developmentShell', label: '开发命令', risk: '高风险', riskTone: 'warn', description: '允许在明确授权的开发工作区中运行命令。' },
  { id: 'unrestrictedFileAccess', label: '完整文件访问', risk: '极高风险', riskTone: 'danger', description: '扩大已授权文件能力的可访问范围，不会自动开启开发命令。' },
]

const agents = {
  maple: {
    id: 'maple',
    name: '小奈',
    glyph: '奈',
    tone: 'a',
    persona: '群里的值班编辑。先核对事实，再给一版能直接发出去的稿。',
    model: 'deepseek',
    modelLabel: 'DeepSeek · V3',
    caps: {
      subagents: true,
      webSearch: true,
      dynamicCreation: true,
      fileTools: true,
      developmentShell: false,
      unrestrictedFileAccess: false,
    },
  },
  safe: {
    id: 'safe',
    name: '小奈安全版',
    glyph: '安',
    tone: 'b',
    persona: '只做核对，不改群公告，不跑命令。',
    model: 'deepseek',
    modelLabel: 'DeepSeek · V3',
    caps: {
      subagents: true,
      webSearch: false,
      dynamicCreation: false,
      fileTools: false,
      developmentShell: false,
      unrestrictedFileAccess: false,
    },
  },
}

const models = [
  { id: 'deepseek', label: 'DeepSeek · V3' },
  { id: 'qwen', label: '通义千问 · Plus' },
]

const channels = {
  web: { id: 'web', agentId: 'maple', name: 'Web 控制台', connectionName: '网页聊天', kind: 'web', trigger: 'always', unread: 0 },
  library: { id: 'library', agentId: 'maple', name: 'NekroAI(伪)大图书馆', connectionName: '公司机器人', kind: 'qq', trigger: 'mention', unread: 2 },
  game: { id: 'game', agentId: 'maple', name: 'NekroGame研究所！', connectionName: '公司机器人', kind: 'qq', trigger: 'mention', unread: 0 },
  lab: { id: 'lab', agentId: 'safe', name: 'NekroAI(伪)智能研究所', connectionName: '公司机器人', kind: 'qq', trigger: 'always', unread: 0 },
  ops: { id: 'ops', agentId: '', name: '运营群', connectionName: '公司机器人', kind: 'qq', trigger: 'mention', unread: 0 },
}

const connections = {
  web: {
    id: 'web',
    name: '网页聊天',
    adapter: '网页聊天',
    kind: 'web',
    state: '已连接',
    lastEvent: '18:21',
    channels: 1,
    channelIds: ['web'],
    receiveTest: '通过',
    sendTest: '通过',
  },
  qq: {
    id: 'qq',
    name: '公司机器人',
    adapter: '官方机器人',
    kind: 'qq',
    state: '已连接',
    lastEvent: '18:42',
    channels: 4,
    appId: '尾号 3816',
    credential: '已保存',
    proactive: '允许',
    channelIds: ['library', 'game', 'lab', 'ops'],
    receiveTest: '通过',
    sendTest: '通过',
    testTarget: 'library',
  },
}

const extensions = {
  summary: {
    id: 'summary',
    name: '网页摘要',
    description: '读取网页并输出带引用的摘要。',
    revision: 3,
    targetAgent: '小奈',
    agentId: 'maple',
    activation: '已启用',
    contributions: ['网页读取', '摘要'],
  },
}

const think = {
  id: 't3-think',
  time: '18:41:03',
  name: '内部输出',
  kind: 'think',
  summary: '先核上一版公告，再确认时间和场地。',
  body: '先核群文件里的上一版公告，再确认时间和地点有没有被改过。\n群回复只要一版能直接发出去的修改稿，分析过程留在这里。',
  duration: '1.2s',
  state: 'ok',
}

const turn3 = [
  {
    id: 't3-glob',
    time: '18:41:08',
    name: '查找文件',
    kind: 'glob',
    summary: '**/*公告*',
    input: '{\n  "pattern": "**/*公告*"\n}',
    output: '群文件/活动公告-v3.docx\n群文件/活动公告-v2.docx',
    duration: '0.41s',
    state: 'ok',
  },
  {
    id: 't3-read-1',
    time: '18:41:12',
    name: '读取文件',
    kind: 'read',
    summary: '活动公告-v3.docx',
    path: '群文件/活动公告-v3.docx',
    input: '{\n  "path": "群文件/活动公告-v3.docx"\n}',
    lines: [
      ['1', '【今晚活动】'],
      ['2', '时间：19:30'],
      ['3', '地点：活动室 B'],
      ['4', '请携带工牌入场'],
    ],
    output: '【今晚活动】\n时间：19:30\n地点：活动室 B\n请携带工牌入场',
    duration: '0.82s',
    state: 'ok',
  },
  {
    id: 't3-read-2',
    time: '18:41:21',
    name: '读取文件',
    kind: 'read',
    summary: '活动公告-v2.docx',
    path: '群文件/活动公告-v2.docx',
    input: '{\n  "path": "群文件/活动公告-v2.docx"\n}',
    lines: [
      ['1', '时间：20:00'],
      ['2', '地点：活动室 B'],
    ],
    output: '时间：20:00\n地点：活动室 B',
    duration: '0.61s',
    state: 'ok',
  },
  {
    id: 't3-grep',
    time: '18:41:28',
    name: '搜索文件',
    kind: 'grep',
    summary: '19:30|20:00',
    input: '{\n  "pattern": "19:30|20:00"\n}',
    hits: [
      ['12', '活动公告-v3.docx: 今晚 19:30'],
      ['3', '活动公告-v2.docx: 时间：20:00'],
    ],
    output: '活动公告-v3.docx:12:今晚 19:30\n活动公告-v2.docx:3:时间：20:00',
    duration: '0.28s',
    state: 'ok',
  },
  {
    id: 't3-web-1',
    time: '18:41:36',
    name: '网页搜索',
    kind: 'web',
    summary: '活动室 B 开放时间',
    input: '{\n  "query": "活动室 B 今晚开放时间"\n}',
    results: [
      { title: '场地日历', text: '工作日 18:00–22:00 开放' },
      { title: '预约须知', text: '改期需提前 2 小时' },
    ],
    output: '工作日 18:00–22:00 开放。改期需提前 2 小时。',
    duration: '1.94s',
    state: 'ok',
  },
  {
    id: 't3-bash',
    time: '18:41:48',
    name: '运行命令',
    kind: 'shell',
    summary: 'date "+%H:%M"',
    input: '{\n  "command": "date \\"+%H:%M\\""\n}',
    output: '18:41',
    duration: '0.18s',
    state: 'ok',
  },
  {
    id: 't3-read-3',
    time: '18:41:52',
    name: '读取文件',
    kind: 'read',
    summary: '值班手册.md',
    path: '群文件/值班手册.md',
    input: '{\n  "path": "群文件/值班手册.md"\n}',
    lines: [['18', '改期需在群内确认后更新公告。']],
    output: '改期需在群内确认后更新公告。',
    duration: '0.47s',
    state: 'ok',
  },
  {
    id: 't3-web-2',
    time: '18:42:04',
    name: '网页搜索',
    kind: 'web',
    summary: '活动室预约改期',
    input: '{\n  "query": "活动室 B 预约改期规则"\n}',
    results: [{ title: '改期规则', text: '当前仍可改到 20:00' }],
    output: '改期需提前 2 小时。当前仍可改到 20:00。',
    duration: '1.10s',
    state: 'run',
  },
  {
    id: 't3-read-4',
    time: '18:42:20',
    name: '读取文件',
    kind: 'read',
    summary: '上次修改稿.txt',
    path: '草稿/上次修改稿.txt',
    input: '{\n  "path": "草稿/上次修改稿.txt"\n}',
    lines: [['1', '可复用开场句，不要复用旧时间。']],
    output: '可复用开场句，不要复用旧时间。',
    duration: '0.36s',
    state: 'ok',
  },
  {
    id: 't3-fail',
    time: '18:42:26',
    name: '读取文件',
    kind: 'read',
    summary: '场地锁定.xlsx',
    path: '群文件/场地锁定.xlsx',
    input: '{\n  "path": "群文件/场地锁定.xlsx"\n}',
    output: '文件不存在',
    duration: '0.12s',
    state: 'fail',
  },
  {
    id: 't3-send',
    time: '18:42:41',
    name: '发送频道消息',
    kind: 'send',
    summary: '今晚改到 20:00…',
    input: '{\n  "target": { "type": "current" },\n  "parts": [{ "type": "text", "text": "收到。今晚改到 20:00，我按上一版结构给一版可直接发的修改稿。" }]\n}',
    output: '{\n  "status": "sent"\n}',
    duration: '0.31s',
    state: 'ok',
    sent: true,
    body: '收到。今晚改到 20:00，我按上一版结构给一版可直接发的修改稿。',
  },
]

const turn2 = [
  {
    id: 't2-read',
    time: '16:08:11',
    name: '读取文件',
    kind: 'read',
    summary: '值班表.csv',
    path: '值班表.csv',
    input: '{\n  "path": "值班表.csv"\n}',
    lines: [['4', '今日值班：小奈']],
    output: '今日值班：小奈',
    duration: '0.33s',
    state: 'ok',
  },
  {
    id: 't2-send',
    time: '16:08:18',
    name: '发送频道消息',
    kind: 'send',
    summary: '今日值班已核对。',
    input: '{\n  "parts": [{ "type": "text", "text": "今日值班已核对。" }]\n}',
    output: '{\n  "status": "sent"\n}',
    duration: '0.21s',
    state: 'ok',
    sent: true,
    body: '今日值班已核对。',
  },
]

const railEl = document.querySelector('#rail')
const treeEl = document.querySelector('#tree')
const canvasEl = document.querySelector('#canvas')
const inspectorEl = document.querySelector('#inspector')
const overlayEl = document.querySelector('#overlay')
const sceneSelect = document.querySelector('#sceneSelect')
const themeToggle = document.querySelector('#themeToggle')
const shellEl = document.querySelector('#shell')

const state = {
  scene: 'running',
  mode: 'work',
  surface: 'channel',
  view: 'chat',
  phase: 'running',
  channelId: 'library',
  agentId: 'maple',
  connectionId: 'qq',
  extensionId: 'summary',
  selectedId: 't3-web-2',
  thinkOpen: false,
  toolsOpen: false,
  search: '',
  theme: 'light',
  overlay: '',
  bindChannelId: 'ops',
  bindAgentId: 'maple',
  bindTrigger: 'mention',
  dirty: false,
  personaDraft: '',
  createStep: 0,
  createName: '',
  createPersona: '',
  createModel: 'deepseek',
  createCaps: { subagents: true, webSearch: true, dynamicCreation: false, fileTools: false, developmentShell: false, unrestrictedFileAccess: false },
  creatorSaved: false,
  emptyRoster: false,
  creatorEmpty: false,
  reducedMotion: false,
}

const esc = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const toast = (title) => {
  const region = document.querySelector('#toastRegion')
  const item = document.createElement('div')
  item.className = 'toast'
  item.textContent = title
  region.replaceChildren(item)
  window.setTimeout(() => item.remove(), 1800)
}

const channel = () => channels[state.channelId]
const agentOf = (id) => agents[id]
const boundAgent = (item) => (item?.agentId ? agents[item.agentId] : undefined)
const triggerLabel = (id) => triggers.find((item) => item.id === id)?.label ?? id
const running = () => state.phase === 'running' && state.channelId === 'library'
const mapleLive = () => running()

const liveTools = () => {
  if (running()) return turn3.filter((tool) => !['t3-read-4', 't3-fail', 't3-send'].includes(tool.id))
  return turn3.map((tool) => (tool.id === 't3-web-2' ? { ...tool, state: 'ok', duration: '1.10s' } : tool))
}

const mark = ({ kind, tone = '', glyph = '', icon = '', size = '' }) => {
  const inner = icon ? icons[icon] : esc(glyph)
  return `<span class="mark ${kind} ${tone} ${size}" aria-hidden="true">${inner}</span>`
}

const agentMark = (agent, extra = {}) => {
  const live = extra.live ?? (mapleLive() && agent.id === 'maple')
  return `<span class="mark-wrap" ${live ? 'data-live' : ''}>${mark({ kind: `agent ${agent.tone}`, glyph: agent.glyph, size: extra.size ?? '' })}</span>`
}

const channelMark = (item) =>
  mark({ kind: item.kind === 'web' ? 'channel' : 'channel qq', icon: item.kind === 'web' ? 'bubble' : 'users' })

const applyScene = (scene) => {
  state.scene = scene
  state.search = ''
  state.overlay = ''
  state.emptyRoster = false
  state.creatorEmpty = false
  state.dirty = false
  state.createStep = 0
  if (scene === 'first') {
    state.mode = 'work'
    state.surface = 'channel'
    state.emptyRoster = true
    return
  }
  if (scene === 'create') {
    state.mode = 'work'
    state.surface = 'channel'
    state.channelId = 'web'
    state.view = 'chat'
    state.phase = 'done'
    state.overlay = 'create'
    state.createName = ''
    state.createPersona = ''
    return
  }
  if (scene === 'workbench') {
    state.mode = 'work'
    state.surface = 'agent'
    state.agentId = 'maple'
    state.personaDraft = agents.maple.persona
    return
  }
  if (scene === 'connect') {
    state.mode = 'connect'
    state.connectionId = 'qq'
    return
  }
  if (scene === 'bind') {
    state.mode = 'work'
    state.surface = 'channel'
    state.channelId = 'ops'
    state.view = 'chat'
    state.phase = 'done'
    state.overlay = 'bind'
    state.bindChannelId = 'ops'
    state.bindAgentId = 'maple'
    state.bindTrigger = 'mention'
    return
  }
  if (scene === 'unbound') {
    state.mode = 'work'
    state.surface = 'channel'
    state.channelId = 'ops'
    state.view = 'chat'
    state.phase = 'done'
    return
  }
  if (scene === 'creator' || scene === 'creator-empty') {
    state.mode = 'creator'
    state.surface = 'agent'
    state.channelId = 'library'
    state.creatorEmpty = scene === 'creator-empty'
    state.creatorSaved = false
    return
  }
  if (scene === 'extension') {
    state.mode = 'extensions'
    return
  }
  if (scene === 'settings') {
    state.mode = 'settings'
    return
  }
  if (scene === 'work') {
    state.mode = 'work'
    state.surface = 'channel'
    state.view = 'work'
    state.phase = 'running'
    state.channelId = 'library'
    state.selectedId = 't3-web-2'
    return
  }
  if (scene === 'web') {
    state.mode = 'work'
    state.surface = 'channel'
    state.view = 'chat'
    state.phase = 'done'
    state.channelId = 'web'
    return
  }
  state.mode = 'work'
  state.surface = 'channel'
  state.view = 'chat'
  state.phase = scene === 'running' ? 'running' : 'done'
  state.channelId = 'library'
  state.selectedId = scene === 'running' ? 't3-web-2' : 't3-send'
  state.toolsOpen = false
}

const inspectorOff = () =>
  state.mode === 'connect' ||
  state.mode === 'extensions' ||
  state.mode === 'creator' ||
  state.mode === 'settings' ||
  state.emptyRoster

const render = () => {
  document.documentElement.dataset.theme = state.theme
  themeToggle.textContent = state.theme === 'dark' ? '浅色' : '深色'
  sceneSelect.value = state.scene
  shellEl.dataset.inspector = inspectorOff() ? 'off' : 'on'
  renderRail()
  renderTree()
  renderCanvas()
  renderInspector()
  renderOverlay()
}

function renderRail() {
  const railMode = state.mode === 'creator' ? 'work' : state.mode
  railEl.innerHTML = `
    <div class="rail-mark" aria-hidden="true"></div>
    <button class="rail-btn" data-action="mode" data-mode="work" ${railMode === 'work' ? 'data-active' : ''} title="工作">${icons.work}</button>
    <button class="rail-btn" data-action="mode" data-mode="connect" ${railMode === 'connect' ? 'data-active' : ''} title="连接">${icons.connect}</button>
    <button class="rail-btn" data-action="mode" data-mode="extensions" ${railMode === 'extensions' ? 'data-active' : ''} title="扩展">${icons.boxes}</button>
    <button class="rail-btn" data-action="mode" data-mode="settings" ${railMode === 'settings' ? 'data-active' : ''} title="设置">${icons.settings}</button>
    <div class="rail-spacer"></div>
    <span class="rail-dot" title="运行正常"></span>`
}

function renderTree() {
  if (state.mode === 'connect') {
    treeEl.innerHTML = `
      <div class="tree-head"><span>连接</span><button class="tree-add" data-action="toast" data-toast="添加连接" type="button" aria-label="添加连接">+</button></div>
      <div class="tree-body">${Object.values(connections)
        .map((item) => {
          const count = item.channelIds.length
          return `
        <button class="tree-item" data-action="open-connection" data-id="${item.id}" ${state.connectionId === item.id ? 'data-active' : ''} type="button">
          ${mark({ kind: item.kind === 'web' ? 'channel' : 'channel qq', icon: item.kind === 'web' ? 'bubble' : 'users', glyph: item.name.slice(0, 1) })}
          <span><strong>${esc(item.name)}</strong><small>${esc(item.state)} · ${count} 个频道</small></span>
        </button>`
        })
        .join('')}</div>`
    return
  }
  if (state.mode === 'extensions') {
    const item = extensions.summary
    treeEl.innerHTML = `
      <div class="tree-head"><span>扩展</span></div>
      <div class="tree-body">
        <button class="tree-item" data-action="open-extension" data-id="summary" data-active type="button">
          ${mark({ kind: 'extension', icon: 'pack' })}
          <span><strong>${esc(item.name)}</strong><small>版本 ${item.revision} · ${item.activation}</small></span>
        </button>
      </div>`
    return
  }
  if (state.mode === 'settings') {
    const items = [
      { id: 'models', label: '模型供应商', hint: '密钥与可用模型', icon: 'key' },
      { id: 'dsh', label: 'DSH 扩展', hint: '能力插件配置', icon: 'puzzle' },
      { id: 'appearance', label: '外观', hint: '主题与动效', icon: 'sun' },
    ]
    treeEl.innerHTML = `
      <div class="tree-head"><span>设置</span></div>
      <div class="tree-body">${items
        .map(
          (item) => `
        <button class="tree-item" type="button" ${item.id === 'appearance' ? 'data-active' : ''}>
          ${mark({ kind: 'nav', icon: item.icon })}
          <span><strong>${item.label}</strong><small>${item.hint}</small></span>
        </button>`,
        )
        .join('')}</div>`
    return
  }

  const unbound = Object.values(channels).filter((item) => !item.agentId)
  treeEl.innerHTML = `
    <div class="tree-head"><span>工作</span><button class="tree-add" data-action="overlay" data-overlay="create" type="button" aria-label="创建智能体">+</button></div>
    <div class="tree-body">${
      state.emptyRoster
        ? '<div class="tree-empty">还没有智能体</div>'
        : `${[agents.maple, agents.safe].map((agent) => renderAgentGroup(agent)).join('')}
          ${
            unbound.length
              ? `<section class="group">
                  <div class="group-head">
                    ${mark({ kind: 'nav', glyph: '?' })}
                    <span><strong>未绑定频道</strong><small>${unbound.length} 个频道</small></span>
                  </div>
                  ${unbound.map((item) => channelBtn(item.id)).join('')}
                </section>`
              : ''
          }`
    }</div>`
}

function renderAgentGroup(agent) {
  const items = Object.values(channels).filter((item) => item.agentId === agent.id)
  const active = state.mode === 'work' && state.surface === 'agent' && state.agentId === agent.id
  const live = mapleLive() && agent.id === 'maple'
  return `
    <section class="group">
      <button class="group-head" data-action="open-agent" data-id="${agent.id}" ${active ? 'data-active' : ''} type="button">
        ${agentMark(agent)}
        <span><strong>${esc(agent.name)}</strong><small>${items.length} 个频道</small></span>
        ${live ? '<span class="badge info">使用工具</span>' : ''}
      </button>
      ${items.map((item) => channelBtn(item.id)).join('')}
    </section>`
}

function channelBtn(id) {
  const item = channels[id]
  const active = state.mode === 'work' && state.surface === 'channel' && state.channelId === id
  const unread = item.unread && running() && id === 'library'
  return `
    <button class="channel" data-action="open-channel" data-id="${id}" ${active ? 'data-active' : ''} type="button">
      ${channelMark(item)}
      <span><strong>${esc(item.name)}</strong><small>${esc(item.connectionName)}</small></span>
      ${unread ? `<span class="unread">${item.unread}</span>` : ''}
    </button>`
}

function renderCanvas() {
  if (state.emptyRoster && state.mode === 'work' && state.overlay !== 'create') {
    canvasEl.innerHTML = `
      <div class="page is-empty">
        <div class="empty-state">
          <strong>还没有智能体</strong>
          <p>创建一个智能体并选择模型，随后可在网页频道中开始对话。</p>
          <button class="btn primary" data-action="overlay" data-overlay="create" type="button">创建第一个智能体</button>
        </div>
      </div>`
    return
  }
  if (state.mode === 'connect') {
    canvasEl.innerHTML = renderConnection()
    return
  }
  if (state.mode === 'extensions') {
    canvasEl.innerHTML = renderExtension()
    return
  }
  if (state.mode === 'creator') {
    canvasEl.innerHTML = renderCreator()
    return
  }
  if (state.mode === 'settings') {
    canvasEl.innerHTML = renderSettings()
    return
  }
  if (state.surface === 'agent') {
    canvasEl.innerHTML = renderWorkbench()
    return
  }
  canvasEl.innerHTML = renderConversation()
}

function renderConversation() {
  const item = channel()
  const agent = boundAgent(item)
  const live = running()
  return `
    <header class="canvas-head">
      <div class="title-block">
        <h1>${esc(item.name)}</h1>
        <p>${agent ? `由“${esc(agent.name)}”响应 · ${esc(triggerLabel(item.trigger))}` : '尚未绑定智能体'}</p>
      </div>
      <div class="head-actions">
        <div class="switch" role="tablist" aria-label="频道视图">
          <button type="button" data-action="view-chat" ${state.view === 'chat' ? 'data-active' : ''}>会话</button>
          <button type="button" data-action="view-work" ${state.view === 'work' ? 'data-active' : ''}>工作轨迹</button>
        </div>
        ${agent ? `<span class="badge ${live ? 'info' : 'neutral'}">${live ? '使用工具' : '空闲'}</span>` : ''}
        ${
          agent
            ? `<button class="btn ghost small" data-action="open-agent" data-id="${agent.id}" type="button">管理智能体</button>`
            : `<button class="btn primary small" data-action="overlay" data-overlay="bind" data-channel="${item.id}" type="button">绑定智能体</button>`
        }
      </div>
    </header>
    ${state.view === 'chat' ? renderChat() : renderLog()}
    <form class="composer" data-mode="${item.kind === 'web' ? 'web' : 'platform'}">
      <div class="composer-eyebrow">${item.kind === 'web' ? '发给智能体' : '以机器人账号发到频道'}</div>
      <div class="composer-target">${
        item.kind === 'web'
          ? agent
            ? `发送给：${esc(agent.name)}`
            : '当前频道尚未绑定智能体'
          : agent
            ? `群里会看到「${esc(item.connectionName)}」发出的消息。${esc(agent.name)} 会知道这是管理员从网页发出的，不是它自己说的。`
            : `此频道来自「${esc(item.connectionName)}」。绑定智能体后，才能以机器人账号发言。`
      }</div>
      <div class="composer-row">
        <textarea aria-label="消息内容" placeholder="${
          item.kind === 'web'
            ? agent
              ? '输入要发给智能体的消息'
              : '请先绑定智能体'
            : agent
              ? '输入要发到频道的公告或说明'
              : '请先绑定智能体'
        }" ${agent ? '' : 'disabled'}></textarea>
        <button class="btn primary" type="submit" ${agent ? '' : 'disabled'}>${
          item.kind === 'web' ? '发送给智能体' : '发到频道'
        }</button>
      </div>
      ${
        item.kind !== 'web' && agent
          ? `<div><button class="btn ghost small" data-action="open-channel" data-id="web" type="button">去网页频道和智能体对话</button></div>`
          : ''
      }
    </form>
  `
}

function renderChat() {
  if (state.channelId === 'ops' && !channels.ops.agentId) {
    return `<div class="stream"><div class="empty-state"><strong>还没有消息</strong><p>绑定智能体后，这个频道的对话会出现在这里。</p></div></div>`
  }
  if (state.channelId === 'web') {
    return `
      <div class="stream">
        <div class="day">今天</div>
        ${msg('m', '你', '18:20', '先帮我改一版群公告。')}
        ${agentMsg('18:21', '把原稿发我，我按上一版结构改时间和地点。')}
      </div>`
  }
  const tools = liveTools()
  const completed = tools.filter((tool) => tool.state !== 'run' && !tool.sent)
  const current = tools.find((tool) => tool.state === 'run')
  const collapsed = !running() && !state.toolsOpen
  const preview = running() && !state.toolsOpen ? completed.slice(-2) : completed
  return `
    <div class="stream">
      <div class="day">今天</div>
      ${msg('c', '观察员', '16:08', '今日值班表核对过了吗？')}
      ${agentMsg('16:08', '今日值班已核对。')}
      ${msg('m', '成员甲', '18:41', '<span class="mention">@小奈</span> 帮看一下今晚活动公告该怎么改。')}
      ${msg('c', '成员乙', '18:42', '顺便把时间改到 20:00。')}
      ${running() ? '<div class="sys">2 条新消息已收录，将在当前工具结束后进入后续处理。</div>' : ''}
      <div class="work">
        ${renderThink()}
        ${
          collapsed
            ? `<button class="more" data-action="toggle-tools">${completed.length} 个工具</button>`
            : `${
                running() && completed.length > 2 && !state.toolsOpen
                  ? `<button class="more" data-action="toggle-tools">${completed.length - 2} 个工具</button>`
                  : ''
              }
              ${preview.map((tool) => renderTool(tool)).join('')}
              ${current ? renderTool({ ...current, forceOpen: true }) : ''}`
        }
      </div>
      ${
        running()
          ? `<div class="live"><span class="dot run"></span>正在使用网页搜索</div>`
          : agentMsg('18:42', '收到。今晚改到 20:00，我按上一版结构给一版可直接发的修改稿。', 'sent-bubble')
      }
    </div>`
}

function msg(tone, name, time, html) {
  return `
    <article class="msg">
      <span class="face ${tone}">${esc(name.slice(0, 1))}</span>
      <div>
        <div class="msg-meta"><strong>${esc(name)}</strong><time>${time}</time></div>
        <div class="msg-body">${html}</div>
      </div>
    </article>`
}

function agentMsg(time, body, id) {
  return `
    <article class="msg" ${id ? `id="${id}"` : ''}>
      ${agentMark(agents.maple, { live: false, size: 'lg' })}
      <div>
        <div class="msg-meta"><strong>小奈</strong><time>${time}</time><span class="badge success">已发送</span></div>
        <div class="msg-body">${esc(body)}</div>
      </div>
    </article>`
}

function renderThink() {
  const open = state.thinkOpen
  const live = running()
  return `
    <button class="think" data-action="toggle-think">
      <span class="row">
        <span class="dot ${live ? 'run' : 'ok'}"></span>
        <span class="label"><strong>内部输出</strong><em>${open ? '' : esc(think.summary)}</em></span>
      </span>
      ${open ? `<div class="think-body">${esc(think.body)}</div>` : ''}
    </button>`
}

function renderTool(tool) {
  const open = tool.forceOpen || state.selectedId === tool.id
  return `
    <button class="tool" data-action="select" data-id="${tool.id}">
      <span class="row">
        <span class="dot ${tool.state}"></span>
        <span class="label"><strong>${esc(tool.name)}</strong><em>${esc(tool.summary)}</em></span>
        <span class="badge ${tool.state === 'run' ? 'info' : tool.state === 'fail' ? 'danger' : 'neutral'}">${
          tool.state === 'run' ? '进行中' : tool.state === 'fail' ? '失败' : tool.duration
        }</span>
      </span>
      ${open ? renderCard(tool) : ''}
    </button>`
}

function renderCard(tool) {
  if (tool.kind === 'read') {
    return `<div class="card"><div class="card-hd"><span>文件</span><code>${esc(tool.path)}</code></div>${
      tool.lines
        ? `<div class="hits">${tool.lines.map(([n, line]) => `<div class="hit"><b>${n}</b><span>${esc(line)}</span></div>`).join('')}</div>`
        : `<pre>${esc(tool.output)}</pre>`
    }</div>`
  }
  if (tool.kind === 'grep') {
    return `<div class="card"><div class="card-hd">2 处匹配</div><div class="hits">${tool.hits
      .map(([n, line]) => `<div class="hit"><b>${n}</b><span>${esc(line)}</span></div>`)
      .join('')}</div></div>`
  }
  if (tool.kind === 'web') {
    return `<div class="card"><div class="card-hd">${esc(tool.summary)}</div>${tool.results
      .map((item) => `<div class="web-item"><strong>${esc(item.title)}</strong><small>${esc(item.text)}</small></div>`)
      .join('')}</div>`
  }
  if (tool.kind === 'shell') return `<div class="card"><div class="card-hd mono">$ date "+%H:%M"</div><pre>${esc(tool.output)}</pre></div>`
  if (tool.kind === 'glob') return `<div class="card"><pre>${esc(tool.output)}</pre></div>`
  if (tool.kind === 'send') return `<div class="card"><pre>${esc(tool.body)}</pre></div>`
  return `<div class="card"><pre>${esc(tool.output)}</pre></div>`
}

function ledger() {
  const rows = [
    { id: 't2-user', turn: 2, turnStart: true, kind: 'user', kindLabel: 'USER', name: '观察员', text: '今日值班表核对过了吗？', ms: '—' },
    ...turn2.map((tool, index) => ledgerTool(tool, 2, index === 0)),
    { id: 't3-user', turn: 3, turnStart: true, kind: 'user', kindLabel: 'USER', name: '成员甲', text: '@小奈 帮看一下今晚活动公告该怎么改。', ms: '—' },
    { ...think, turn: 3, turnStart: false, kind: 'message', kindLabel: 'MESSAGE', text: think.body.replaceAll('\n', ' '), ms: '1204ms' },
    ...liveTools().map((tool) => ledgerTool(tool, 3, false)),
  ]
  const query = state.search.trim().toLowerCase()
  if (!query) return rows
  return rows.filter((row) => `${row.kindLabel} ${row.text} ${row.name ?? ''} ${row.args ?? ''}`.toLowerCase().includes(query))
}

function ledgerTool(tool, turn, turnStart) {
  return {
    ...tool,
    turn,
    turnStart,
    kind: tool.kind === 'send' ? 'send' : 'tool',
    kindLabel: 'TOOL',
    text: tool.summary,
    args: tool.summary,
    out: tool.output.split('\n')[0],
    ms: tool.state === 'run' ? '—' : `${Math.round(Number.parseFloat(tool.duration) * 1000)}ms`,
  }
}

function plotLane(row) {
  if (row.kind === 'message') return 'internal'
  if (row.kind === 'send' || row.kind === 'user') return 'send'
  return 'tool'
}

function renderLog() {
  const rows = ledger()
  const count = Math.max(rows.length, 1)
  return `
    <div class="traj">
      <div class="traj-bar">
        <button class="traj-toggle" type="button" data-active>时长</button>
        <button class="traj-toggle" type="button">回合</button>
        <button class="traj-toggle" type="button">调用</button>
        <input class="traj-search" data-role="search" value="${esc(state.search)}" placeholder="搜索" />
      </div>
      <div class="plot" aria-label="工作轨迹时间轴">
        <div class="plot-labels"><span>内部</span><span>工具</span><span>发送</span></div>
        <div class="plot-track">
          ${rows
            .map((row, index) => {
              const selected = state.selectedId === row.id ? ' selected' : ''
              return `<button class="plot-seg ${plotLane(row)}${selected}" type="button" data-action="select" data-id="${row.id}" style="left:${(index / count) * 100}%;width:${100 / count}%" aria-label="${esc(row.name)} · Turn ${row.turn}"></button>`
            })
            .join('')}
        </div>
      </div>
      <div class="traj-table-wrap">
        <table class="traj-table">
          <thead><tr><th class="event">事件</th><th>内容</th><th class="time">时间</th></tr></thead>
          <tbody>${rows.map((row) => renderLedgerRow(row)).join('')}</tbody>
        </table>
      </div>
    </div>`
}

function renderLedgerRow(row) {
  const selected = state.selectedId === row.id
  const kindClass = row.kind === 'send' ? 'tool' : row.kind
  const content =
    row.kind === 'tool' || row.kind === 'send'
      ? `<div class="tool-line"><span class="name">${esc(row.name)}</span><span class="args">${esc(row.args)}</span>${
          row.out ? `<span class="arrow">→</span><span class="out">${esc(row.out)}</span>` : ''
        }</div>`
      : `<span class="content-line">${esc(row.text)}</span>`
  return `
    <tr data-action="select" data-id="${row.id}" ${selected ? 'data-selected' : ''} ${row.turnStart ? 'data-turn-start' : ''}>
      <td class="event-cell">
        <span class="turn-rail"></span>
        ${selected ? '<span class="sel-rail"></span>' : ''}
        ${row.turnStart ? `<span class="turn-chip">Turn ${row.turn}</span>` : ''}
        <div class="event-inner"><span class="kind ${kindClass}">${row.kindLabel}</span></div>
      </td>
      <td class="content-cell">${content}</td>
      <td class="time-cell">${esc(row.ms)}</td>
    </tr>`
}

function renderDetails(row) {
  const lane = plotLane(row)
  const sent = row.input || row.body || row.text || ''
  const output = row.output || row.body || ''
  const regions = []
  if (lane === 'internal') regions.push(`<section class="td-region"><h2>内部输出</h2><pre class="td-payload">${esc(output || row.text)}</pre></section>`)
  else if (lane === 'send' && row.kind === 'send') {
    regions.push(`<section class="td-region"><h2>发出的内容</h2><pre class="td-payload">${esc(sent)}</pre></section>`)
    if (output && output !== sent) regions.push(`<section class="td-region"><h2>发送结果</h2><pre class="td-payload">${esc(output)}</pre></section>`)
  } else if (row.kind === 'user') {
    regions.push(`<section class="td-region"><h2>频道消息</h2><pre class="td-payload">${esc(row.text)}</pre></section>`)
  } else {
    if (row.input || row.args) regions.push(`<section class="td-region"><h2>输入</h2><pre class="td-payload">${esc(row.input || row.args)}</pre></section>`)
    if (output) regions.push(`<section class="td-region"><h2>输出</h2><pre class="td-payload">${esc(output)}</pre></section>`)
  }
  return `
    <div class="traj-details">
      <div class="td-head">
        <div class="td-title">
          <span class="kind ${row.kind === 'send' ? 'tool' : row.kind}">${row.kindLabel}</span>
          <span class="td-name">${esc(row.name)}</span>
          <span class="td-loc">Turn ${row.turn}</span>
        </div>
        <button class="td-close" type="button" data-action="clear-select" aria-label="关闭">×</button>
      </div>
      <div class="td-body">${regions.join('')}</div>
    </div>`
}

function renderWorkbench() {
  const agent = agentOf(state.agentId) ?? agents.maple
  const persona = state.dirty ? state.personaDraft : agent.persona
  const bound = Object.values(channels).filter((item) => item.agentId === agent.id)
  const live = mapleLive() && agent.id === 'maple'
  return `
    <div class="workbench">
      <header class="canvas-head">
        <div class="title-block">
          <h1>${esc(agent.name)}</h1>
        </div>
        <div class="head-actions">
          <span class="badge ${live ? 'info' : 'neutral'}">${live ? '使用工具' : '空闲'}</span>
          ${bound[0] ? `<button class="btn ghost small" data-action="open-channel" data-id="${bound[0].id}" type="button">打开最近频道</button>` : ''}
          ${state.dirty ? `<button class="btn ghost small" data-action="reset-persona" type="button">放弃更改</button>` : ''}
          <button class="btn primary small" data-action="save-persona" type="button" ${state.dirty ? '' : 'disabled'}>保存新配置</button>
        </div>
      </header>
      <div class="workbench-doc">
        <section class="section">
          <div class="section-title">人设与模型</div>
          <div class="stack" style="margin-top:12px">
            <div class="field"><label>名称</label><input value="${esc(agent.name)}" /></div>
            <div class="field"><label>人设</label><textarea data-role="persona">${esc(persona)}</textarea><span class="hint">描述它的身份、表达方式和工作边界。</span></div>
            <div class="field">
              <label>默认模型</label>
              <select data-role="model">
                ${models.map((item) => `<option value="${item.id}" ${agent.model === item.id ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}
              </select>
            </div>
          </div>
        </section>
        <section class="section">
          <div class="section-head">
            <div>
              <div class="section-title">已绑定频道</div>
              <p class="section-desc">每个频道保留独立的消息记录。</p>
            </div>
            <button class="btn secondary small" data-action="overlay" data-overlay="bind" data-channel="" type="button">绑定频道</button>
          </div>
          ${
            bound.length
              ? bound
                  .map(
                    (item) => `
            <div class="bound-row">
              <button class="bound-name" data-action="open-channel" data-id="${item.id}" type="button">
                <strong>${esc(item.name)}</strong>
                <small>${esc(item.connectionName)}</small>
              </button>
              <div class="field">
                <label>响应方式</label>
                <select data-role="channel-trigger" data-id="${item.id}">
                  ${triggers.map((option) => `<option value="${option.id}" ${item.trigger === option.id ? 'selected' : ''}>${option.label}</option>`).join('')}
                </select>
              </div>
            </div>`,
                  )
                  .join('')
              : `<div class="empty-state"><strong>还没有绑定频道</strong><p>绑定频道后，这个智能体才能接收对应消息。</p></div>`
          }
        </section>
        <section class="section">
          <div class="section-title">授权能力</div>
          <p class="section-desc">每个开关都是一次立即保存的授权变更。</p>
          ${capabilities
            .map((item) => {
              const on = agent.caps[item.id]
              return `
              <div class="switch-row">
                <span>
                  <strong class="risk">${item.label} <span class="badge ${item.riskTone}">${item.risk}</span></strong>
                  <small>${item.description}</small>
                </span>
                <button class="toggle" data-action="cap" data-id="${item.id}" ${on ? 'data-on' : ''} type="button" aria-label="${item.label}"></button>
              </div>`
            })
            .join('')}
          ${
            agent.caps.dynamicCreation
              ? `<div class="action-row">
                  <span><strong>动态创造已授权</strong><small>在这个智能体的频道里描述需求。</small></span>
                  <span style="display:flex;gap:8px">
                    <button class="btn primary small" data-action="open-channel" data-id="${bound[0]?.id ?? 'web'}" type="button">打开频道去描述需求</button>
                    <button class="btn ghost small" data-action="mode" data-mode="creator" type="button">查看创造运行</button>
                  </span>
                </div>`
              : ''
          }
        </section>
        <section class="section">
          <div class="section-title">已关联扩展</div>
          ${
            extensions.summary.agentId === agent.id
              ? `<div class="static-row">
                  <span><strong>${esc(extensions.summary.name)}</strong><small>${esc(extensions.summary.description)}</small></span>
                  <button class="btn danger small" data-action="unpin" type="button">停用扩展</button>
                </div>`
              : `<div class="empty-state"><strong>还没有给这个智能体启用扩展</strong><p>已有保存版本。启用后，这个智能体才能使用对应能力。</p></div>`
          }
        </section>
      </div>
    </div>`
}

function renderConnection() {
  const selected = connections[state.connectionId]
  const boundCount = selected.channelIds.filter((id) => channels[id].agentId).length
  const firstBound = selected.channelIds.find((id) => channels[id].agentId)
  const steps = [
    { label: '连接账号', done: true },
    { label: '发现频道', done: selected.channelIds.length > 0 },
    { label: '测试接收', done: selected.receiveTest === '通过' },
    { label: '测试发送', done: selected.sendTest === '通过' },
    { label: '绑定智能体', done: boundCount > 0 },
  ]
  return `
    <div class="page"><div class="page-inner">
      <div class="page-head">
        <div>
          <h1>连接</h1>
          <div class="page-meta">2 个平台账号</div>
        </div>
        <button class="btn primary" data-action="toast" data-toast="添加连接" type="button">添加连接</button>
      </div>
      <div class="section-head">
        <div>
          <div class="section-title">${esc(selected.name)}</div>
          <p class="section-desc">${esc(selected.adapter)}</p>
        </div>
        <span class="badge success">${esc(selected.state)}</span>
      </div>
      ${
        selected.kind !== 'web'
          ? `<ol class="progress">${steps
              .map(
                (step, index) =>
                  `<li ${step.done ? 'data-done' : ''}><span>${step.done ? icons.check : index + 1}</span><small>${step.label}</small>${index < 4 ? '<i></i>' : ''}</li>`,
              )
              .join('')}</ol>`
          : ''
      }
      <dl class="facts wide">
        <dt>最近收到消息</dt><dd>${esc(selected.lastEvent)}</dd>
        <dt>已发现频道</dt><dd>${selected.channels} 个</dd>
        ${
          selected.kind !== 'web'
            ? `<dt>应用账号</dt><dd>${esc(selected.appId)}</dd>
               <dt>凭据</dt><dd>${esc(selected.credential)}</dd>
               <dt>主动发言</dt><dd>${esc(selected.proactive)}</dd>`
            : ''
        }
      </dl>
      ${
        selected.kind === 'web'
          ? `<p class="section-desc">网页聊天由当前设备管理，不需要配置账号凭据。</p>`
          : `
      <div class="divider"></div>
      <div class="section-title">连接测试</div>
      <div class="field" style="margin:12px 0">
        <label>测试消息发送到</label>
        <select data-role="test-target">
          ${selected.channelIds
            .map((id) => `<option value="${id}" ${selected.testTarget === id ? 'selected' : ''}>${esc(channels[id].name)} · ${channels[id].kind === 'web' ? '网页' : '群聊'}</option>`)
            .join('')}
        </select>
      </div>
      <div class="test-row">
        <span><strong>接收消息</strong><small>${esc(selected.receiveTest)}</small></span>
        <button class="btn secondary small" data-action="test-recv" type="button">测试接收</button>
      </div>
      <div class="test-row">
        <span><strong>发送消息</strong><small>${esc(selected.sendTest)}</small></span>
        <button class="btn secondary small" data-action="test-send" type="button">发送测试消息</button>
      </div>
      <div class="divider"></div>
      <div class="section-head">
        <div>
          <div class="section-title">绑定智能体</div>
          <p class="section-desc">${boundCount > 0 ? `已有 ${boundCount} 个频道绑定。` : '收发确认后，为频道选择响应的智能体。'}</p>
        </div>
        ${boundCount > 0 ? '<span class="badge success">已完成</span>' : ''}
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn primary" data-action="overlay" data-overlay="bind" data-channel="${selected.channelIds.find((id) => !channels[id].agentId) ?? selected.channelIds[0]}" type="button">绑定智能体</button>
        ${firstBound ? `<button class="btn ghost" data-action="open-channel" data-id="${firstBound}" type="button">打开已绑定频道</button>` : ''}
      </div>`
      }
    </div></div>`
}

function renderExtension() {
  const item = extensions.summary
  const enabled = item.activation === '已启用'
  return `
    <div class="page"><div class="page-inner">
      <div class="page-head">
        <div>
          <h1>扩展</h1>
          <div class="page-meta">1 个本地扩展</div>
        </div>
      </div>
      <div class="section-head">
        <div>
          <div class="section-title">${esc(item.name)}</div>
          <p class="section-desc">${esc(item.description)}</p>
        </div>
        <span class="badge ${enabled ? 'success' : 'neutral'}">${item.activation}</span>
      </div>
      <ol class="lifecycle">
        <li data-done><span>${icons.check}</span><small>动态运行</small></li>
        <li data-done><span>${icons.check}</span><small>保存版本</small></li>
        <li ${enabled ? 'data-done' : ''}><span>${enabled ? icons.check : '3'}</span><small>启用给智能体</small></li>
      </ol>
      <dl class="facts wide">
        <dt>当前保存版本</dt><dd>版本 ${item.revision}</dd>
        <dt>目标智能体</dt><dd>${esc(item.targetAgent || '尚未指定')}</dd>
        <dt>启用状态</dt><dd>${item.activation}</dd>
      </dl>
      <div class="divider"></div>
      <div class="section-title">贡献能力</div>
      <div class="tags" style="margin-top:10px">${item.contributions.map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}</div>
      <div class="action-row">
        <span>
          <strong>${enabled ? '这个智能体正在使用该版本' : '保存不会自动扩大作用范围'}</strong>
          <small>启用与停用是独立操作。</small>
        </span>
        <button class="btn ${enabled ? 'danger' : 'primary'}" data-action="${enabled ? 'unpin' : 'pin'}" type="button">${enabled ? '停用扩展' : '启用给智能体'}</button>
      </div>
    </div></div>`
}

function renderCreator() {
  if (state.creatorEmpty) {
    return `
      <div class="page"><div class="page-inner">
        <div class="page-head">
          <div>
            <h1>创造</h1>
            <div class="page-meta">动态运行、保存为本地扩展和启用给智能体是三个独立动作。</div>
          </div>
        </div>
        <div class="section-title">从智能体的频道开始创造</div>
        <p class="section-desc">向已授权动态创造的智能体描述需求。它开始运行后，这里会显示真实状态和保存入口。</p>
        <div class="section">
          <div class="section-title">可开始创造的智能体</div>
          ${[agents.maple]
            .filter((agent) => agent.caps.dynamicCreation)
            .map((agent) => {
              const first = Object.values(channels).find((item) => item.agentId === agent.id)
              return `<div class="static-row">
                <span><strong>${esc(agent.name)}</strong><small>${Object.values(channels).filter((item) => item.agentId === agent.id).length} 个频道可用</small></span>
                <button class="btn secondary small" data-action="open-channel" data-id="${first?.id ?? 'web'}" type="button">打开频道</button>
              </div>`
            })
            .join('')}
        </div>
      </div></div>`
  }
  const agent = agents.maple
  return `
    <div class="page"><div class="page-inner">
      <div class="page-head">
        <div>
          <h1>创造</h1>
          <div class="page-meta">动态运行、保存为本地扩展和启用给智能体是三个独立动作。</div>
        </div>
      </div>
      <div class="section-head">
        <div>
          <div class="section-title">与${esc(agent.name)}协作创造</div>
          <p class="section-desc">当前内容仍是临时动态运行，尚未成为本地扩展。</p>
        </div>
        <span class="badge info">运行中</span>
      </div>
      <div class="evidence">
        <div><span>目标智能体</span><strong>${esc(agent.name)}</strong></div>
        <div><span>当前状态</span><strong>运行中</strong></div>
        <div><span>保存状态</span><strong>${state.creatorSaved ? '已保存版本 1' : '尚未保存'}</strong></div>
      </div>
      <div class="preview-box">
        <div class="section-title">即时界面</div>
        <h3 style="margin-top:10px">场地改期摘要</h3>
        <p>19:30 → 20:00 · 活动室 B 仍开放</p>
      </div>
      <div class="action-row">
        <span>
          <strong>下一步</strong>
          <small>${state.creatorSaved ? '保存后不会自动启用，请到扩展页启用给智能体。' : '确认运行结果后保存为可追踪的本地扩展版本。'}</small>
        </span>
        <button class="btn primary" data-action="save-dynamic" type="button" ${state.creatorSaved ? 'disabled' : ''}>保存为本地扩展</button>
      </div>
    </div></div>`
}

function renderSettings() {
  return `
    <div class="page"><div class="page-inner">
      <div class="page-head"><h1>设置</h1></div>
      <div class="section-title">外观</div>
      <div class="field" style="margin-top:12px;max-width:360px">
        <label>主题</label>
        <select data-role="theme">
          <option value="light" ${state.theme === 'light' ? 'selected' : ''}>浅色</option>
          <option value="dark" ${state.theme === 'dark' ? 'selected' : ''}>深色</option>
        </select>
      </div>
      <div class="switch-row">
        <span>
          <strong>减少动态效果</strong>
          <small>减少页面和浮层过渡，保留必要的状态反馈。</small>
        </span>
        <button class="toggle" data-action="reduced" ${state.reducedMotion ? 'data-on' : ''} type="button" aria-label="减少动态效果"></button>
      </div>
    </div></div>`
}

function renderInspector() {
  if (inspectorOff()) {
    inspectorEl.innerHTML = ''
    return
  }
  if (state.mode === 'work' && state.surface === 'channel' && state.view === 'work') {
    const rows = ledger()
    const current = rows.find((row) => row.id === state.selectedId) ?? rows[0]
    inspectorEl.innerHTML = current ? renderDetails(current) : ''
    return
  }
  if (state.mode === 'work' && state.surface === 'agent') {
    const agent = agentOf(state.agentId)
    const bound = Object.values(channels).filter((item) => item.agentId === agent.id)
    inspectorEl.innerHTML = `
      <section>
        <h2>这个智能体</h2>
        <p><strong>${bound[0] ? `最近频道：${esc(bound[0].name)}` : '还没有最近使用的频道'}</strong></p>
        <p>人设与模型保存后会创建新配置；能力授权每次修改都会独立保存。</p>
      </section>
      <section>
        <h2>频道</h2>
        ${bound.map((item) => `<p><strong>${esc(item.name)}</strong><br /><span style="color:var(--nxt-text-muted)">${esc(triggerLabel(item.trigger))}</span></p>`).join('') || '<p>绑定后才会出现在工作树里。</p>'}
      </section>`
    return
  }
  const item = channel()
  const agent = boundAgent(item)
  const live = running()
  inspectorEl.innerHTML = `
    <section>
      <h2>运行</h2>
      ${agent ? `<span class="badge ${live ? 'info' : 'neutral'}">${live ? '使用工具' : '空闲'}</span>` : ''}
      <p>${live ? '网页搜索 · 活动室预约改期' : agent ? '智能体当前空闲。' : '绑定智能体后才能自动响应消息。'}</p>
      ${live ? '<p>2 条新消息已收录。</p>' : ''}
    </section>
    <section>
      <h2>绑定</h2>
      <dl class="facts">
        <dt>智能体</dt><dd>${agent ? esc(agent.name) : '未绑定'}</dd>
        <dt>来源</dt><dd>${item.kind === 'web' ? '网页聊天' : esc(item.connectionName)}</dd>
      </dl>
      ${
        agent
          ? `<div class="field">
              <label>响应方式</label>
              <select data-role="trigger">
                ${triggers.map((option) => `<option value="${option.id}" ${item.trigger === option.id ? 'selected' : ''}>${option.label}</option>`).join('')}
              </select>
            </div>
            <div class="inspector-actions" style="margin-top:12px">
              <button class="btn secondary small" data-action="overlay" data-overlay="bind" data-channel="${item.id}" type="button">改由其他智能体响应</button>
              <button class="btn ghost small" data-action="open-agent" data-id="${agent.id}" type="button">管理智能体</button>
            </div>`
          : `<p>绑定智能体后才能自动响应这个频道的消息。</p>
             <div class="inspector-actions" style="margin-top:12px">
               <button class="btn primary small" data-action="overlay" data-overlay="bind" data-channel="${item.id}" type="button">绑定智能体</button>
             </div>`
      }
      <details class="channel-details">
        <summary>频道显示名称</summary>
        <div class="field" style="margin-top:8px">
          <label>频道名称</label>
          <input value="${esc(item.name)}" />
          <span class="hint">${item.kind === 'web' ? '用于消息列表显示。' : '平台未提供频道名称时，可在此设置本地名称。'}</span>
        </div>
      </details>
    </section>`
}

function renderOverlay() {
  if (!state.overlay) {
    overlayEl.hidden = true
    overlayEl.innerHTML = ''
    return
  }
  overlayEl.hidden = false
  if (state.overlay === 'create') {
    const steps = ['身份', '模型', '工作方式', '确认']
    const selectedModel = models.find((item) => item.id === state.createModel)
    overlayEl.innerHTML = `
      <div class="sheet" role="dialog" aria-labelledby="create-title">
        <div class="sheet-head">
          <h2 id="create-title">创建智能体</h2>
          <p>分步确定身份、模型和初始工作方式，最后一次性创建。</p>
        </div>
        <div class="sheet-body">
          <ol class="wizard-steps">
            ${steps
              .map(
                (step, index) =>
                  `<li ${index === state.createStep ? 'data-active' : index < state.createStep ? 'data-done' : ''}><span>${index < state.createStep ? icons.check : index + 1}</span>${step}</li>`,
              )
              .join('')}
          </ol>
          ${
            state.createStep === 0
              ? `<div class="stack">
                  <div class="field"><label>名称</label><input data-role="create-name" value="${esc(state.createName)}" autofocus /></div>
                  <div class="field"><label>人设</label><textarea data-role="create-persona">${esc(state.createPersona)}</textarea><span class="hint">描述它的身份、表达方式和工作边界，之后仍可修改。</span></div>
                </div>`
              : ''
          }
          ${
            state.createStep === 1
              ? `<div class="field"><label>默认模型</label>
                  <select data-role="create-model">${models.map((item) => `<option value="${item.id}" ${state.createModel === item.id ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select>
                  <span class="hint">新频道会使用这个模型开始对话。</span>
                </div>`
              : ''
          }
          ${
            state.createStep === 2
              ? capabilities
                  .map((item) => {
                    const on = state.createCaps[item.id]
                    return `<div class="switch-row">
                      <span><strong>${item.label}</strong><small>${item.description}</small></span>
                      <button class="toggle" data-action="create-cap" data-id="${item.id}" ${on ? 'data-on' : ''} type="button" aria-label="${item.label}"></button>
                    </div>`
                  })
                  .join('')
              : ''
          }
          ${
            state.createStep === 3
              ? `<div class="summary-rows">
                  <div><span>智能体</span><strong>${esc(state.createName.trim() || '未命名')}</strong></div>
                  <div><span>人设</span><strong>${esc(state.createPersona.trim() || '稍后设置')}</strong></div>
                  <div><span>模型</span><strong>${esc(selectedModel?.label)}</strong></div>
                  <div><span>初始能力</span><strong>${capabilities.filter((item) => state.createCaps[item.id]).map((item) => item.label).join('、') || '不授予开发能力'}</strong></div>
                </div>
                <p class="section-desc" style="margin-top:12px">创建后会自动建立网页聊天频道，并直接打开它。</p>`
              : ''
          }
        </div>
        <div class="sheet-foot">
          <button class="btn ghost" data-action="close-overlay" type="button">取消</button>
          ${state.createStep > 0 ? `<button class="btn secondary" data-action="create-back" type="button">上一步</button>` : ''}
          <button class="btn primary" data-action="create-next" type="button">${state.createStep === 3 ? '创建并打开频道' : '下一步'}</button>
        </div>
      </div>`
    return
  }
  const lockedChannel = state.bindChannelId ? channels[state.bindChannelId] : undefined
  overlayEl.innerHTML = `
    <div class="sheet" role="dialog" aria-labelledby="bind-title">
      <div class="sheet-head">
        <h2 id="bind-title">${lockedChannel?.agentId ? '更改响应智能体' : '绑定智能体'}</h2>
        <p>${lockedChannel?.agentId ? '这个频道同一时间只由一个智能体响应。保存后，后续消息改由新的智能体处理。' : '选择响应这个频道的智能体和触发方式。'}</p>
      </div>
      <div class="sheet-body stack">
        <div class="field">
          <label>响应智能体</label>
          <select data-role="bind-agent">
            ${Object.values(agents).map((agent) => `<option value="${agent.id}" ${state.bindAgentId === agent.id ? 'selected' : ''}>${esc(agent.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>频道</label>
          <select data-role="bind-channel" ${state.bindChannelId ? '' : ''}>
            ${Object.values(channels)
              .map((item) => `<option value="${item.id}" ${state.bindChannelId === item.id ? 'selected' : ''}>${esc(item.connectionName)} · ${esc(item.name)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field">
          <label>响应方式</label>
          <select data-role="bind-trigger">
            ${triggers.map((item) => `<option value="${item.id}" ${state.bindTrigger === item.id ? 'selected' : ''}>${item.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="sheet-foot">
        <button class="btn ghost" data-action="close-overlay" type="button">取消</button>
        <button class="btn primary" data-action="confirm-bind" type="button">绑定频道</button>
      </div>
    </div>`
}

const handleAction = (action, button) => {
  if (action === 'mode') {
    state.mode = button.dataset.mode
    state.overlay = ''
    state.emptyRoster = false
    if (state.mode === 'work') state.surface = 'channel'
    if (state.mode === 'connect') state.connectionId = 'qq'
    if (state.mode === 'creator') state.creatorEmpty = false
    return true
  }
  if (action === 'open-channel') {
    state.mode = 'work'
    state.surface = 'channel'
    state.channelId = button.dataset.id
    state.view = 'chat'
    state.emptyRoster = false
    state.overlay = ''
    if (button.dataset.id !== 'library') state.phase = 'done'
    return true
  }
  if (action === 'open-agent') {
    state.mode = 'work'
    state.surface = 'agent'
    state.agentId = button.dataset.id
    state.personaDraft = (agentOf(state.agentId) ?? agents.maple).persona
    state.dirty = false
    state.emptyRoster = false
    state.overlay = ''
    return true
  }
  if (action === 'open-connection') {
    state.mode = 'connect'
    state.connectionId = button.dataset.id
    return true
  }
  if (action === 'open-extension') {
    state.mode = 'extensions'
    return true
  }
  if (action === 'view-chat') {
    state.view = 'chat'
    return true
  }
  if (action === 'view-work') {
    state.view = 'work'
    return true
  }
  if (action === 'toggle-think') {
    state.thinkOpen = !state.thinkOpen
    return true
  }
  if (action === 'toggle-tools') {
    state.toolsOpen = !state.toolsOpen
    return true
  }
  if (action === 'clear-select') {
    state.selectedId = ''
    return true
  }
  if (action === 'select') {
    state.selectedId = button.dataset.id
    return true
  }
  if (action === 'overlay') {
    state.overlay = button.dataset.overlay
    if (state.overlay === 'bind') {
      state.bindChannelId = button.dataset.channel || state.channelId || 'ops'
      state.bindAgentId = channels[state.bindChannelId]?.agentId || state.agentId || 'maple'
      state.bindTrigger = channels[state.bindChannelId]?.trigger || 'mention'
    }
    if (state.overlay === 'create') state.createStep = 0
    return true
  }
  if (action === 'close-overlay') {
    state.overlay = ''
    return true
  }
  if (action === 'create-next') {
    if (state.createStep === 0 && !state.createName.trim()) {
      toast('请输入智能体名称。')
      return false
    }
    if (state.createStep < 3) {
      state.createStep += 1
      return true
    }
    state.overlay = ''
    state.emptyRoster = false
    state.mode = 'work'
    state.surface = 'channel'
    state.channelId = 'web'
    state.view = 'chat'
    state.phase = 'done'
    toast('已打开频道')
    return true
  }
  if (action === 'create-back') {
    state.createStep = Math.max(0, state.createStep - 1)
    return true
  }
  if (action === 'create-cap') {
    state.createCaps[button.dataset.id] = !state.createCaps[button.dataset.id]
    return true
  }
  if (action === 'confirm-bind') {
    const target = channels[state.bindChannelId]
    if (target) {
      target.agentId = state.bindAgentId
      target.trigger = state.bindTrigger
    }
    state.overlay = ''
    toast('频道已绑定。')
    return true
  }
  if (action === 'cap') {
    const agent = agentOf(state.agentId)
    if (agent) agent.caps[button.dataset.id] = !agent.caps[button.dataset.id]
    return true
  }
  if (action === 'save-persona') {
    const agent = agentOf(state.agentId)
    if (agent) agent.persona = state.personaDraft
    state.dirty = false
    toast('智能体配置已保存。')
    return true
  }
  if (action === 'reset-persona') {
    state.personaDraft = agentOf(state.agentId)?.persona ?? ''
    state.dirty = false
    return true
  }
  if (action === 'save-dynamic') {
    state.creatorSaved = true
    toast('动态运行已保存为本地扩展。')
    return true
  }
  if (action === 'pin') {
    extensions.summary.agentId = 'maple'
    extensions.summary.targetAgent = '小奈'
    extensions.summary.activation = '已启用'
    toast('网页摘要已启用。')
    return true
  }
  if (action === 'unpin') {
    extensions.summary.agentId = ''
    extensions.summary.targetAgent = ''
    extensions.summary.activation = '未启用'
    toast('网页摘要已停用。')
    return true
  }
  if (action === 'test-recv') {
    connections.qq.receiveTest = '通过'
    toast('接收测试已完成，结果已刷新。')
    return true
  }
  if (action === 'test-send') {
    connections.qq.sendTest = '通过'
    toast('测试消息已提交，结果已刷新。')
    return true
  }
  if (action === 'reduced') {
    state.reducedMotion = !state.reducedMotion
    return true
  }
  if (action === 'toast') {
    toast(button.dataset.toast)
    return false
  }
  return false
}

document.addEventListener('click', (event) => {
  if (event.target === overlayEl) {
    state.overlay = ''
    render()
    return
  }
  const button = event.target.closest('[data-action]')
  if (!button || button.closest('.proto-bar')) return
  if (handleAction(button.dataset.action, button)) render()
})

document.addEventListener('change', (event) => {
  const el = event.target
  if (!(el instanceof HTMLSelectElement)) return
  if (el.matches('[data-role="trigger"]')) {
    const item = channel()
    if (item) item.trigger = el.value
    render()
  }
  if (el.matches('[data-role="channel-trigger"]')) {
    channels[el.dataset.id].trigger = el.value
    toast('响应方式已更新。')
    render()
  }
  if (el.matches('[data-role="model"]')) {
    const agent = agentOf(state.agentId)
    if (agent) {
      agent.model = el.value
      agent.modelLabel = models.find((item) => item.id === el.value)?.label ?? agent.modelLabel
    }
  }
  if (el.matches('[data-role="theme"]')) {
    state.theme = el.value
    render()
  }
  if (el.matches('[data-role="test-target"]')) connections.qq.testTarget = el.value
  if (el.matches('[data-role="bind-agent"]')) state.bindAgentId = el.value
  if (el.matches('[data-role="bind-channel"]')) state.bindChannelId = el.value
  if (el.matches('[data-role="bind-trigger"]')) state.bindTrigger = el.value
  if (el.matches('[data-role="create-model"]')) state.createModel = el.value
})

canvasEl.addEventListener('submit', (event) => {
  event.preventDefault()
  toast('已发送')
})

canvasEl.addEventListener('input', (event) => {
  if (event.target.matches('[data-role="persona"]')) {
    state.personaDraft = event.target.value
    state.dirty = event.target.value !== (agentOf(state.agentId)?.persona ?? '')
    render()
    const next = canvasEl.querySelector('[data-role="persona"]')
    if (next) {
      next.focus()
      next.setSelectionRange(state.personaDraft.length, state.personaDraft.length)
    }
    return
  }
  const search = event.target.closest('[data-role="search"]')
  if (!search) return
  state.search = search.value
  render()
  const next = canvasEl.querySelector('[data-role="search"]')
  if (next) {
    next.focus()
    next.setSelectionRange(search.value.length, search.value.length)
  }
})

overlayEl.addEventListener('input', (event) => {
  if (event.target.matches('[data-role="create-name"]')) state.createName = event.target.value
  if (event.target.matches('[data-role="create-persona"]')) state.createPersona = event.target.value
})

sceneSelect.addEventListener('change', () => {
  applyScene(sceneSelect.value)
  render()
})

themeToggle.addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark'
  render()
})

applyScene('running')
render()
