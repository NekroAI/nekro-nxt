const icons = {
  work: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  connect:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9a5 5 0 0 1 8-1l2 2"/><path d="M20 15a5 5 0 0 1-8 1l-2-2"/><path d="M8 12h8"/></svg>',
  boxes:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/></svg>',
  settings:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 1v2.5M12 20.5V23M4.2 4.2l1.8 1.8M18 18l1.8 1.8M1 12h2.5M20.5 12H23M4.2 19.8 6 18M18 6l1.8-1.8"/></svg>',
}

const triggerLabels = {
  'mentioned-or-replied': '被提及或回复时',
  always: '每条消息',
  command: '收到命令时',
  'observe-only': '仅观察',
}

const state = {
  mode: 'work',
  focus: 'channel',
  agentId: 'maple',
  channelId: 'library',
  connectionId: 'qq',
  extensionId: 'summary',
  settingsId: 'models',
  inspectorOpen: true,
  theme: 'light',
  draft: '',
  bindOpen: false,
  createOpen: false,
  createStep: 0,
  createName: '',
  createPersona: '',
  saveDirty: false,
  persona: '冷静、可靠，在群里把事情说清楚，不替用户做没被要求的决定。',
  model: 'deepseek-v4-flash',
  caps: {
    subagents: true,
    webSearch: true,
    dynamicCreation: true,
    fileTools: true,
    developmentShell: true,
    unrestrictedFileAccess: false,
  },
  extensionOn: true,
  bindAgentId: 'maple',
  bindChannelId: 'library',
  bindTrigger: 'mentioned-or-replied',
}

const agents = {
  maple: { id: 'maple', name: '浅枫', letter: '浅', status: '使用工具' },
  safe: { id: 'safe', name: '浅枫安全版', letter: '安', status: '空闲' },
  probe: { id: 'probe', name: '真实对话测试', letter: '真', status: '空闲' },
}

const channels = {
  web: {
    id: 'web',
    agentId: 'maple',
    name: 'Web 控制台',
    source: '网页聊天',
    kind: 'web',
    trigger: 'always',
    phase: '空闲',
  },
  library: {
    id: 'library',
    agentId: 'maple',
    name: 'NekroAI(伪)大图书馆',
    source: 'QQ 机器人账号',
    kind: 'qq-group',
    trigger: 'mentioned-or-replied',
    phase: '使用工具',
  },
  game: {
    id: 'game',
    agentId: 'maple',
    name: 'NekroGame研究所！',
    source: 'QQ 机器人账号',
    kind: 'qq-group',
    trigger: 'mentioned-or-replied',
    phase: '空闲',
  },
  lab: {
    id: 'lab',
    agentId: 'safe',
    name: 'NekroAI(伪)智能研究所',
    source: 'QQ 机器人账号',
    kind: 'qq-group',
    trigger: 'always',
    phase: '空闲',
  },
}

const connections = {
  web: { id: 'web', name: '网页聊天', adapter: '网页聊天', state: '已连接', channels: 1, tests: '无需测试' },
  qq: {
    id: 'qq',
    name: 'QQ 机器人账号',
    adapter: 'QQ 官方机器人',
    state: '已连接',
    channels: 3,
    receive: '通过',
    send: '通过',
  },
}

const messages = {
  web: [
    { role: 'member', author: '你', time: '11:02', body: '先确认一下网页频道还能不能回。' },
    { role: 'agent', author: '浅枫', time: '11:02', body: '可以。这条是通过通信工具发到网页频道的。', delivery: '已发送' },
  ],
  library: [
    { role: 'member', author: '米栗', time: '18:41', body: '@浅枫 帮看一下今晚活动公告该怎么改。' },
    { role: 'member', author: '阿和', time: '18:42', body: '顺便把时间改到 20:00。' },
    {
      role: 'agent',
      author: '浅枫',
      time: '18:42',
      body: '收到。我先核对群文件里的上一版公告，再给你一版可直接发的修改稿。',
      delivery: '已发送',
    },
    { role: 'system', body: '2 条新消息已收录，将在安全间隙进入后续处理。' },
  ],
  game: [{ role: 'member', author: '值班', time: '09:10', body: '今日构建已绿。' }],
  lab: [{ role: 'member', author: '观察员', time: '16:08', body: '安全版只观察，不主动回。' }],
}

const railEl = document.querySelector('#rail')
const treeEl = document.querySelector('#tree')
const canvasEl = document.querySelector('#canvas')
const inspectorEl = document.querySelector('#inspector')
const shellEl = document.querySelector('#shell')
const modalRoot = document.querySelector('#modalRoot')
const sceneSelect = document.querySelector('#sceneSelect')
const themeToggle = document.querySelector('#themeToggle')

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function toast(title, detail = '') {
  const region = document.querySelector('#toastRegion')
  const item = document.createElement('div')
  item.className = 'toast'
  item.innerHTML = `<strong>${esc(title)}</strong>${detail ? `<small>${esc(detail)}</small>` : ''}`
  region.appendChild(item)
  setTimeout(() => item.remove(), 2800)
}

function channelsOf(agentId) {
  return Object.values(channels).filter((channel) => channel.agentId === agentId)
}

function currentAgent() {
  return agents[state.agentId]
}

function currentChannel() {
  return channels[state.channelId]
}

function applyScene(scene) {
  if (scene === 'channel') {
    state.mode = 'work'
    state.focus = 'channel'
    state.agentId = 'maple'
    state.channelId = 'library'
    state.inspectorOpen = true
  } else if (scene === 'agent') {
    state.mode = 'work'
    state.focus = 'agent'
    state.agentId = 'maple'
    state.inspectorOpen = true
  } else if (scene === 'connect') {
    state.mode = 'connect'
    state.connectionId = 'qq'
    state.inspectorOpen = true
  } else if (scene === 'extensions') {
    state.mode = 'extensions'
    state.extensionId = 'summary'
    state.inspectorOpen = true
  } else if (scene === 'settings') {
    state.mode = 'settings'
    state.settingsId = 'models'
    state.inspectorOpen = false
  } else if (scene === 'creator') {
    state.mode = 'work'
    state.focus = 'creator'
    state.agentId = 'maple'
    state.inspectorOpen = true
  } else if (scene === 'empty') {
    state.mode = 'work'
    state.focus = 'empty'
    state.inspectorOpen = false
    state.createOpen = true
    state.createStep = 0
  }
  render()
}

function syncSceneSelect() {
  if (state.focus === 'empty' || state.createOpen && state.focus === 'empty') sceneSelect.value = 'empty'
  else if (state.mode === 'connect') sceneSelect.value = 'connect'
  else if (state.mode === 'extensions') sceneSelect.value = 'extensions'
  else if (state.mode === 'settings') sceneSelect.value = 'settings'
  else if (state.focus === 'creator') sceneSelect.value = 'creator'
  else if (state.focus === 'agent') sceneSelect.value = 'agent'
  else sceneSelect.value = 'channel'
}

function renderRail() {
  const modes = [
    ['work', '工作', icons.work],
    ['connect', '连接', icons.connect],
    ['extensions', '扩展', icons.boxes],
    ['settings', '设置', icons.settings],
  ]
  railEl.innerHTML = `
    <div class="rail-mark" aria-hidden="true">N</div>
    ${modes
      .map(
        ([id, label, icon]) => `
      <button class="rail-btn ${state.mode === id ? 'active' : ''}" data-action="mode" data-mode="${id}" title="${label}" aria-label="${label}" aria-current="${state.mode === id ? 'page' : 'false'}">${icon}</button>`,
      )
      .join('')}
    <div class="rail-spacer"></div>
    <span class="rail-host" title="运行正常"></span>`
}

function renderTree() {
  if (state.mode === 'work') {
    if (state.focus === 'empty') {
      treeEl.innerHTML = `
        <div class="tree-head"><span>智能体</span>
          <button class="btn ghost small" data-action="open-create">+</button></div>
        <div class="tree-body"><p class="note">还没有智能体。创建后会自动出现网页频道。</p></div>`
      return
    }
    treeEl.innerHTML = `
      <div class="tree-head"><span>工作</span>
        <button class="btn ghost small" data-action="open-create" title="创建智能体">+</button></div>
      <div class="tree-body">
        ${renderAgentGroup('maple')}
        ${renderAgentGroup('safe')}
        <div class="tree-group">
          <button class="tree-agent ${state.agentId === 'probe' && state.focus === 'agent' ? 'active' : ''}" data-action="select-agent" data-id="probe">
            <span class="avatar">${agents.probe.letter}</span>
            <span><strong>${agents.probe.name}</strong><small>还没有绑定频道</small></span>
          </button>
        </div>
      </div>`
    return
  }
  if (state.mode === 'connect') {
    treeEl.innerHTML = `
      <div class="tree-head"><span>连接</span></div>
      <div class="tree-body">
        ${Object.values(connections)
          .map(
            (item) => `
          <button class="tree-agent ${state.connectionId === item.id ? 'active' : ''}" data-action="select-connection" data-id="${item.id}">
            <span class="avatar">${item.name.slice(0, 1)}</span>
            <span><strong>${item.name}</strong><small>${item.state} · ${item.channels} 个频道</small></span>
          </button>`,
          )
          .join('')}
      </div>`
    return
  }
  if (state.mode === 'extensions') {
    treeEl.innerHTML = `
      <div class="tree-head"><span>扩展</span></div>
      <div class="tree-body">
        <button class="tree-agent active" data-action="select-extension" data-id="summary">
          <span class="avatar">摘</span>
          <span><strong>网页摘要</strong><small>版本 3 · ${state.extensionOn ? '已启用给浅枫' : '未启用'}</small></span>
        </button>
      </div>`
    return
  }
  treeEl.innerHTML = `
    <div class="tree-head"><span>设置</span></div>
    <div class="tree-body">
      ${[
        ['models', '模型供应商'],
        ['dsh', 'DSH 扩展'],
        ['appearance', '外观'],
      ]
        .map(
          ([id, label]) => `
        <button class="tree-agent ${state.settingsId === id ? 'active' : ''}" data-action="select-settings" data-id="${id}">
          <span class="avatar">${label.slice(0, 1)}</span>
          <span><strong>${label}</strong><small>宿主级配置</small></span>
        </button>`,
        )
        .join('')}
    </div>`
}

function renderAgentGroup(agentId) {
  const agent = agents[agentId]
  const list = channelsOf(agentId)
  const selected = state.agentId === agentId && state.focus === 'agent'
  return `
    <div class="tree-group">
      <button class="tree-agent ${selected ? 'active' : ''}" data-action="select-agent" data-id="${agent.id}">
        <span class="avatar">${agent.letter}</span>
        <span><strong>${agent.name}</strong><small>${list.length} 个频道</small></span>
        ${agent.status !== '空闲' ? `<span class="badge info">${agent.status}</span>` : ''}
      </button>
      ${list
        .map((channel) => {
          const on = state.focus === 'channel' && state.channelId === channel.id
          return `
        <button class="tree-channel ${on ? 'active' : ''}" data-action="select-channel" data-id="${channel.id}">
          <span class="dot ${channel.phase !== '空闲' ? 'live' : ''}"></span>
          <span><strong>${channel.name}</strong><small>${channel.source}</small></span>
          ${channel.phase !== '空闲' ? `<span class="badge info">${channel.phase}</span>` : ''}
        </button>`
        })
        .join('')}
    </div>`
}

function renderCanvas() {
  if (state.mode === 'work' && state.focus === 'channel') renderConversation()
  else if (state.mode === 'work' && state.focus === 'agent') renderAgentWorkbench()
  else if (state.mode === 'work' && state.focus === 'creator') renderCreator()
  else if (state.mode === 'work' && state.focus === 'empty') renderEmptyCanvas()
  else if (state.mode === 'connect') renderConnection()
  else if (state.mode === 'extensions') renderExtension()
  else renderSettings()
}

function renderConversation() {
  const channel = currentChannel()
  const agent = agents[channel.agentId]
  const list = messages[channel.id] || []
  canvasEl.innerHTML = `
    <header class="canvas-head">
      <div>
        <h1>${esc(channel.name)}</h1>
        <p>由“${esc(agent.name)}”响应 · ${esc(triggerLabels[channel.trigger])}</p>
      </div>
      <div class="head-actions">
        ${channel.phase !== '空闲' ? `<span class="badge info">${channel.phase}</span>` : ''}
        ${state.inspectorOpen ? '' : '<button class="btn ghost small" data-action="toggle-inspector">展开检查器</button>'}
        <button class="btn ghost small" data-action="select-agent" data-id="${agent.id}">管理智能体</button>
      </div>
    </header>
    <div class="messages">
      ${list
        .map((message) =>
          message.role === 'system'
            ? `<div class="system-line">${esc(message.body)}</div>`
            : `<article class="message">
                <div class="avatar">${esc(message.author.slice(0, 1))}</div>
                <div>
                  <div class="message-meta"><strong>${esc(message.author)}</strong><time>${esc(message.time || '')}</time>${message.delivery ? `<span class="badge success">${message.delivery}</span>` : ''}</div>
                  <div class="message-body">${esc(message.body)}</div>
                </div>
              </article>`,
        )
        .join('')}
      ${
        channel.phase !== '空闲'
          ? `<div class="runtime-tail">浅枫正在读取群文件 · 新消息不会打断当前工具</div>`
          : ''
      }
    </div>
    <form class="composer" data-action="send">
      <div class="composer-target">${channel.kind === 'web' ? `发送给：${agent.name}` : `发送到：${channel.name}（通过 QQ 机器人账号）`}</div>
      <div class="composer-row">
        <textarea name="body" placeholder="输入消息">${esc(state.draft)}</textarea>
        <button class="btn primary" type="submit">发送</button>
      </div>
    </form>`
}

function renderAgentWorkbench() {
  const agent = currentAgent()
  canvasEl.innerHTML = `
    <header class="canvas-head">
      <div>
        <h1>${esc(agent.name)}</h1>
        <p>${agent.status} · 人设与模型保存后会创建新配置</p>
      </div>
      <div class="head-actions">
        ${state.inspectorOpen ? '' : '<button class="btn ghost" data-action="toggle-inspector">展开检查器</button>'}
        <button class="btn ghost" data-action="open-channel" data-id="${channelsOf(agent.id)[0]?.id || ''}" ${channelsOf(agent.id).length ? '' : 'disabled'}>打开最近频道</button>
        <button class="btn primary" data-action="save-agent" ${state.saveDirty ? '' : 'disabled'}>保存新配置</button>
      </div>
    </header>
    <div class="doc">
      <section class="doc-section">
        <h2>人设与模型</h2>
        <div class="field"><label>名称</label><input value="${esc(agent.name)}" disabled /></div>
        <div class="field"><label>人设</label><textarea data-action="edit-persona">${esc(state.persona)}</textarea></div>
        <div class="field">
          <label>默认模型</label>
          <select data-action="edit-model">
            <option value="deepseek-v4-flash" ${state.model === 'deepseek-v4-flash' ? 'selected' : ''}>DeepSeek · V4 Flash</option>
            <option value="gpt-5" ${state.model === 'gpt-5' ? 'selected' : ''}>OpenAI · GPT-5</option>
          </select>
        </div>
      </section>
      <section class="doc-section">
        <h2>授权能力</h2>
        ${capabilityRow('subagents', '子智能体', '允许在后台委派独立任务。', '低风险')}
        ${capabilityRow('webSearch', '网页搜索', '通过已配置的 DeepSeek 搜索外部信息。', '外部服务')}
        ${capabilityRow('dynamicCreation', '动态创造', '允许创建并试运行临时扩展。', '中风险')}
        ${capabilityRow('fileTools', '文件工具', '允许在这个智能体的开发工作区读写文件。', '高风险')}
        ${capabilityRow('developmentShell', '开发命令', '允许在独立开发工作区运行命令。', '高风险')}
        ${capabilityRow('unrestrictedFileAccess', '完整文件访问', '扩大文件访问范围，不会自动开启开发命令。', '极高风险')}
      </section>
      <section class="doc-section">
        <h2>扩展</h2>
        <div class="static-row">
          <span><strong>网页摘要</strong><small> 版本 3</small></span>
          <button class="btn ${state.extensionOn ? 'danger' : 'primary'} small" data-action="toggle-extension">${state.extensionOn ? '停用扩展' : '启用给智能体'}</button>
        </div>
      </section>
    </div>`
}

function capabilityRow(key, label, description, risk) {
  return `
    <label class="switch">
      <span><strong>${label} <span class="badge ${risk.includes('高') || risk.includes('极') ? 'warning' : 'neutral'}">${risk}</span></strong><small>${description}</small></span>
      <input type="checkbox" data-action="toggle-cap" data-key="${key}" ${state.caps[key] ? 'checked' : ''} />
    </label>`
}

function renderCreator() {
  const agent = currentAgent()
  canvasEl.innerHTML = `
    <header class="canvas-head">
      <div>
        <h1>与${esc(agent.name)}协作创造</h1>
        <p>当前仍是临时动态运行。保存、启用是两个独立动作。</p>
      </div>
    </header>
    <div class="doc">
      <ol class="progress">
        <li data-done>描述需求</li>
        <li data-done>动态运行</li>
        <li data-done>验证结果</li>
        <li>保存版本</li>
        <li>启用给智能体</li>
      </ol>
      <div class="note">需求在频道里描述。这里只展示真实运行结果，不另建创造智能体。</div>
      <div class="static-row"><span><strong>即时界面</strong><small> 动态 Client 预览会显示在这里</small></span><span class="badge info">运行中</span></div>
      <div class="row-actions" style="margin-top:16px">
        <button class="btn primary" data-action="save-extension">保存为本地扩展</button>
        <button class="btn ghost" data-action="open-channel" data-id="library">回到频道</button>
      </div>
    </div>`
}

function renderEmptyCanvas() {
  canvasEl.innerHTML = `
    <div class="empty">
      <h2>还没有智能体</h2>
      <p>创建后会自动建立网页聊天频道，并进入工作台。</p>
      <button class="btn primary" data-action="open-create">创建智能体</button>
    </div>`
}

function renderConnection() {
  const item = connections[state.connectionId]
  canvasEl.innerHTML = `
    <header class="canvas-head">
      <div>
        <h1>${esc(item.name)}</h1>
        <p>${esc(item.adapter)} · ${esc(item.state)}</p>
      </div>
      <span class="badge success">${esc(item.state)}</span>
    </header>
    <div class="doc">
      ${
        item.id === 'web'
          ? `<div class="note">网页聊天由当前设备管理，不需要配置账号凭据。</div>`
          : `
        <ol class="progress">
          <li data-done>连接账号</li>
          <li data-done>发现频道</li>
          <li data-done>测试接收</li>
          <li data-done>测试发送</li>
          <li data-done>绑定智能体</li>
        </ol>
        <div class="static-row"><span><strong>接收消息</strong><small> ${item.receive}</small></span><button class="btn small" data-action="test-receive">测试接收</button></div>
        <div class="static-row"><span><strong>发送消息</strong><small> ${item.send}</small></span><button class="btn small" data-action="test-send">发送测试消息</button></div>
        <div class="row-actions" style="margin-top:16px">
          <button class="btn primary" data-action="open-bind">绑定智能体</button>
          <button class="btn ghost" data-action="select-channel" data-id="library">打开已绑定频道</button>
        </div>`
      }
    </div>`
}

function renderExtension() {
  canvasEl.innerHTML = `
    <header class="canvas-head">
      <div>
        <h1>网页摘要</h1>
        <p>保存不会自动扩大作用范围。启用与停用是独立操作。</p>
      </div>
      <span class="badge ${state.extensionOn ? 'success' : 'neutral'}">${state.extensionOn ? '已启用' : '未启用'}</span>
    </header>
    <div class="doc">
      <div class="facts">
        <dt>当前版本</dt><dd>版本 3</dd>
        <dt>目标智能体</dt><dd>浅枫</dd>
        <dt>贡献</dt><dd>工具 · 摘要</dd>
      </div>
      <button class="btn ${state.extensionOn ? 'danger' : 'primary'}" data-action="toggle-extension">${state.extensionOn ? '停用扩展' : '启用给智能体'}</button>
    </div>`
}

function renderSettings() {
  const titles = { models: '模型供应商', dsh: 'DSH 扩展', appearance: '外观' }
  canvasEl.innerHTML = `
    <header class="canvas-head">
      <div>
        <h1>${titles[state.settingsId]}</h1>
        <p>宿主级配置，作用于整个实例，不是某一个智能体。</p>
      </div>
    </header>
    <div class="doc">
      ${
        state.settingsId === 'appearance'
          ? `<div class="field"><label>主题</label>
              <select data-action="set-theme">
                <option value="light" ${state.theme === 'light' ? 'selected' : ''}>浅色</option>
                <option value="dark" ${state.theme === 'dark' ? 'selected' : ''}>深色</option>
              </select></div>`
          : state.settingsId === 'dsh'
            ? `<div class="note">DSH 能力插件走通用 Settings 投影。中文覆盖只增强体验，删除后仍可配置。</div>
               <div class="static-row"><span><strong>DeepSeek 网页搜索</strong><small> 已验证支持</small></span><span class="badge success">可用</span></div>`
            : `<div class="static-row"><span><strong>DeepSeek</strong><small> 3 个模型 · 密钥已保存</small></span><span class="badge success">可用</span></div>
               <div class="static-row"><span><strong>OpenAI</strong><small> 尚未保存密钥</small></span><span class="badge warning">待配置</span></div>`
      }
    </div>`
}

function renderInspector() {
  shellEl.dataset.inspector = state.inspectorOpen ? 'open' : 'closed'
  if (!state.inspectorOpen) {
    inspectorEl.innerHTML = ''
    return
  }
  if (state.mode === 'work' && state.focus === 'channel') renderChannelInspector()
  else if (state.mode === 'work' && state.focus === 'agent') renderAgentInspector()
  else if (state.mode === 'work' && state.focus === 'creator') renderCreatorInspector()
  else if (state.mode === 'connect') renderConnectionInspector()
  else if (state.mode === 'extensions') renderExtensionInspector()
  else inspectorEl.innerHTML = ''
}

function inspectorToggle() {
  return `<button class="btn ghost small" data-action="toggle-inspector">收起</button>`
}

function renderChannelInspector() {
  const channel = currentChannel()
  const agent = agents[channel.agentId]
  inspectorEl.innerHTML = `
    <section>
      <div class="inspector-head">
        <div><h2>运行轨迹</h2><p>由“${esc(agent.name)}”响应</p></div>
        ${inspectorToggle()}
      </div>
      <span class="badge info">${esc(channel.phase)}</span>
      <p>${channel.phase === '使用工具' ? '正在读取群文件，核对上一版公告。' : '智能体当前空闲。'}</p>
    </section>
    <section>
      <h2>当前轮次</h2>
      ${
        channel.phase === '使用工具'
          ? `<div class="tool-row"><span class="mark"></span><span><strong>读取群文件</strong><small>活动公告-v3.docx</small></span><span class="badge info">进行中</span></div>
             <div class="note">2 条新消息已收录，将在安全间隙进入后续处理。</div>`
          : `<div class="tool-row"><span class="mark done"></span><span><strong>当前没有进行中的工具调用</strong></span></div>`
      }
    </section>
    <section>
      <h2>频道绑定</h2>
      <dl class="facts">
        <dt>智能体</dt><dd>${esc(agent.name)}</dd>
        <dt>来源</dt><dd>${esc(channel.source)}</dd>
      </dl>
      <div class="field">
        <label>响应方式</label>
        <select data-action="set-trigger" data-id="${channel.id}">
          ${Object.entries(triggerLabels)
            .map(
              ([value, label]) =>
                `<option value="${value}" ${channel.trigger === value ? 'selected' : ''}>${label}</option>`,
            )
            .join('')}
        </select>
      </div>
      <div class="stack">
        <button class="btn small" data-action="open-bind">改由其他智能体响应</button>
        <button class="btn ghost small" data-action="select-agent" data-id="${agent.id}">管理智能体</button>
      </div>
    </section>`
}

function renderAgentInspector() {
  const agent = currentAgent()
  const list = channelsOf(agent.id)
  inspectorEl.innerHTML = `
    <section>
      <div class="inspector-head">
        <div><h2>这个智能体</h2><p>${esc(agent.status)}</p></div>
        ${inspectorToggle()}
      </div>
      ${list.length ? '' : '<div class="note warn">还没有绑定频道。</div>'}
      ${agent.id === 'probe' ? '<div class="note warn">还没有绑定频道。可在此打开绑定。</div>' : ''}
      ${state.caps.dynamicCreation ? '<div class="note">动态创造已授权。需求在频道里描述。</div>' : ''}
    </section>
    <section>
      <h2>频道</h2>
      ${
        list.length
          ? list
              .map(
                (channel) => `
        <div class="static-row">
          <button class="btn ghost" data-action="select-channel" data-id="${channel.id}" style="justify-content:flex-start;padding-left:0">
            <span><strong>${esc(channel.name)}</strong><small> ${esc(triggerLabels[channel.trigger])}</small></span>
          </button>
        </div>`,
              )
              .join('')
          : '<p>绑定后才会出现在工作树里。</p>'
      }
      <button class="btn small" data-action="open-bind" style="margin-top:8px">绑定频道</button>
    </section>
    <section>
      <h2>下一步</h2>
      <div class="stack">
        ${
          state.caps.dynamicCreation && list[0]
            ? `<button class="btn primary small" data-action="open-channel" data-id="${list[0].id}">打开频道去描述需求</button>
               <button class="btn ghost small" data-action="open-creator">查看创造运行</button>`
            : ''
        }
      </div>
    </section>`
}

function renderCreatorInspector() {
  inspectorEl.innerHTML = `
    <section>
      <div class="inspector-head"><div><h2>创造进度</h2><p>仍是临时运行</p></div>${inspectorToggle()}</div>
      <div class="note">保存后不会自动启用给浅枫。</div>
    </section>`
}

function renderConnectionInspector() {
  const item = connections[state.connectionId]
  inspectorEl.innerHTML = `
    <section>
      <div class="inspector-head"><div><h2>关联</h2><p>${esc(item.name)}</p></div>${inspectorToggle()}</div>
      <div class="static-row"><span>大图书馆</span><small>浅枫</small></div>
      <div class="static-row"><span>研究所</span><small>浅枫</small></div>
    </section>`
}

function renderExtensionInspector() {
  inspectorEl.innerHTML = `
    <section>
      <div class="inspector-head"><div><h2>启用关系</h2><p>按智能体独立</p></div>${inspectorToggle()}</div>
      <div class="static-row"><span>浅枫</span><span class="badge ${state.extensionOn ? 'success' : 'neutral'}">${state.extensionOn ? '已启用' : '未启用'}</span></div>
    </section>`
}

function renderModal() {
  if (state.bindOpen) {
    modalRoot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <h2>绑定智能体</h2>
          <p class="lead">选择响应频道的智能体和触发方式。完成后留在当前模式。</p>
          <div class="field"><label>响应智能体</label>
            <select data-action="bind-agent">
              ${Object.values(agents)
                .map((agent) => `<option value="${agent.id}" ${state.bindAgentId === agent.id ? 'selected' : ''}>${agent.name}</option>`)
                .join('')}
            </select>
          </div>
          <div class="field"><label>频道</label>
            <select data-action="bind-channel">
              ${Object.values(channels)
                .map((channel) => `<option value="${channel.id}" ${state.bindChannelId === channel.id ? 'selected' : ''}>${channel.source} · ${channel.name}</option>`)
                .join('')}
            </select>
          </div>
          <div class="field"><label>响应方式</label>
            <select data-action="bind-trigger">
              ${Object.entries(triggerLabels)
                .map(([value, label]) => `<option value="${value}" ${state.bindTrigger === value ? 'selected' : ''}>${label}</option>`)
                .join('')}
            </select>
          </div>
          <div class="modal-actions">
            <button class="btn ghost" data-action="close-modal">取消</button>
            <button class="btn primary" data-action="confirm-bind">绑定频道</button>
          </div>
        </div>
      </div>`
    return
  }
  if (state.createOpen) {
    const steps = ['身份', '模型', '工作方式', '确认']
    modalRoot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <h2>创建智能体</h2>
          <p class="lead">分步确定身份和模型，最后一次性创建，并打开网页频道。</p>
          <ol class="wizard-steps">${steps.map((step, index) => `<li class="${index === state.createStep ? 'on' : ''}">${index + 1} ${step}</li>`).join('')}</ol>
          ${
            state.createStep === 0
              ? `<div class="field"><label>名称</label><input data-action="create-name" value="${esc(state.createName)}" /></div>
                 <div class="field"><label>人设</label><textarea data-action="create-persona">${esc(state.createPersona)}</textarea></div>`
              : state.createStep === 1
                ? `<div class="field"><label>默认模型</label><select><option>DeepSeek · V4 Flash</option></select></div>`
                : state.createStep === 2
                  ? `<div class="note">默认开启子智能体。文件、创造和开发命令需你明确授权。</div>`
                  : `<div class="note">将创建智能体、首个配置和网页聊天频道。</div>`
          }
          <div class="modal-actions">
            <button class="btn ghost" data-action="close-modal">取消</button>
            ${state.createStep > 0 ? `<button class="btn ghost" data-action="create-back">上一步</button>` : ''}
            <button class="btn primary" data-action="create-next">${state.createStep === 3 ? '创建并打开频道' : '下一步'}</button>
          </div>
        </div>
      </div>`
    return
  }
  modalRoot.innerHTML = ''
}

function render() {
  document.documentElement.dataset.theme = state.theme
  themeToggle.textContent = state.theme === 'dark' ? '浅色' : '深色'
  renderRail()
  renderTree()
  renderCanvas()
  renderInspector()
  renderModal()
  syncSceneSelect()
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]')
  if (!target) return
  const action = target.dataset.action
  if (action === 'mode') {
    state.mode = target.dataset.mode
    if (state.mode === 'work') state.focus = 'channel'
    if (state.mode === 'settings') state.inspectorOpen = false
    else state.inspectorOpen = true
  } else if (action === 'select-agent') {
    state.mode = 'work'
    state.focus = 'agent'
    state.agentId = target.dataset.id
    state.inspectorOpen = true
  } else if (action === 'select-channel' || action === 'open-channel') {
    if (!target.dataset.id) return
    state.mode = 'work'
    state.focus = 'channel'
    state.channelId = target.dataset.id
    state.agentId = channels[state.channelId].agentId
    state.inspectorOpen = true
  } else if (action === 'select-connection') state.connectionId = target.dataset.id
  else if (action === 'select-settings') state.settingsId = target.dataset.id
  else if (action === 'toggle-inspector') state.inspectorOpen = !state.inspectorOpen
  else if (action === 'open-bind') {
    state.bindOpen = true
    state.bindAgentId = state.agentId
    state.bindChannelId = state.channelId
  } else if (action === 'close-modal') {
    state.bindOpen = false
    state.createOpen = false
  } else if (action === 'confirm-bind') {
    channels[state.bindChannelId].agentId = state.bindAgentId
    channels[state.bindChannelId].trigger = state.bindTrigger
    state.bindOpen = false
    toast('频道已绑定。', '仍留在当前模式。')
  } else if (action === 'open-create') {
    state.createOpen = true
    state.createStep = 0
  } else if (action === 'create-back') state.createStep = Math.max(0, state.createStep - 1)
  else if (action === 'create-next') {
    if (state.createStep < 3) state.createStep += 1
    else {
      state.createOpen = false
      state.focus = 'channel'
      state.channelId = 'web'
      state.agentId = 'maple'
      toast('智能体已创建。', '已打开网页聊天频道。')
    }
  } else if (action === 'save-agent') {
    state.saveDirty = false
    toast('智能体配置已保存。', '新消息会使用最新配置。')
  } else if (action === 'toggle-extension') {
    state.extensionOn = !state.extensionOn
    toast(state.extensionOn ? '网页摘要已启用。' : '网页摘要已停用。')
  } else if (action === 'open-creator') {
    state.mode = 'work'
    state.focus = 'creator'
  } else if (action === 'save-extension') toast('已保存为本地扩展。', '尚未启用给浅枫。')
  else if (action === 'test-receive') toast('接收测试已完成。')
  else if (action === 'test-send') toast('测试消息已提交。')
  else return
  render()
})

document.addEventListener('change', (event) => {
  const target = event.target.closest('[data-action]')
  if (!target) return
  const action = target.dataset.action
  if (action === 'set-trigger') {
    channels[target.dataset.id].trigger = target.value
    toast('响应方式已更新。')
  } else if (action === 'toggle-cap') {
    state.caps[target.dataset.key] = target.checked
    toast(target.checked ? '已开启此能力。' : '已关闭此能力。')
  } else if (action === 'edit-model') {
    state.model = target.value
    state.saveDirty = true
  } else if (action === 'set-theme') {
    state.theme = target.value
  } else if (action === 'bind-agent') state.bindAgentId = target.value
  else if (action === 'bind-channel') state.bindChannelId = target.value
  else if (action === 'bind-trigger') state.bindTrigger = target.value
  else return
  render()
})

document.addEventListener('input', (event) => {
  const target = event.target.closest('[data-action]')
  if (!target) return
  if (target.dataset.action === 'edit-persona') {
    state.persona = target.value
    state.saveDirty = true
    const save = document.querySelector('[data-action="save-agent"]')
    if (save) save.disabled = false
    return
  }
  if (target.dataset.action === 'create-name') state.createName = target.value
  if (target.dataset.action === 'create-persona') state.createPersona = target.value
})

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-action="send"]')
  if (!form) return
  event.preventDefault()
  const body = String(new FormData(form).get('body') || '').trim()
  if (!body) return
  const channel = currentChannel()
  messages[channel.id] = messages[channel.id] || []
  messages[channel.id].push({
    role: 'member',
    author: channel.kind === 'web' ? '你' : '管理员',
    time: '刚刚',
    body,
  })
  state.draft = ''
  toast(channel.kind === 'web' ? '已交给浅枫。' : '已通过机器人账号提交。')
  render()
})

sceneSelect.addEventListener('change', () => applyScene(sceneSelect.value))
themeToggle.addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark'
  render()
})

render()
