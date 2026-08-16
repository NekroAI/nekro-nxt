const initialCapabilities = {
  web: true,
  knowledge: true,
  vision: true,
  scheduler: false,
  creation: true,
  shell: false,
  fullFiles: false,
  githubReadonly: true,
};

const state = {
  view: "agents",
  wizardStep: 1,
  wizard: {
    name: "小奈",
    persona: "活泼、可靠，擅长在群聊中提供帮助",
    model: "DeepSeek V4",
    mode: "通用方式",
  },
  agents: [
    { id: "xiaonai", name: "小奈", letter: "奈", status: "tool", channels: 3, extensions: 4, activity: "正在处理：QQ 用户群的天气查询", last: "刚刚" },
    { id: "dev", name: "开发助手", letter: "开", status: "idle", channels: 1, extensions: 6, activity: "最近对话：Web 开发台", last: "12 分钟前" },
    { id: "group", name: "群聊管家", letter: "群", status: "paused", channels: 2, extensions: 3, activity: "不会启动新的回复", last: "昨天" },
  ],
  tool: { status: "running", pendingExpanded: true, elapsed: 88, injected: false },
  channelMessages: [],
  capabilities: { ...initialCapabilities },
  publishedCapabilities: { ...initialCapabilities, creation: false, scheduler: true },
  agentRevision: 12,
  rollover: false,
  binding: {
    step: 5,
    platform: "QQ",
    connection: "NekroNxt（QQ 12345678）",
    channel: "产品交流群（群号 987654）",
    agent: "小奈",
    trigger: "被提及或回复时",
    proactive: true,
    history: "最近 50 条",
    receiveTest: true,
    sendTest: false,
    status: "draft",
  },
  creator: {
    running: true,
    saved: false,
    activated: false,
    revision: null,
    activeTab: "validation",
    validations: [
      { id: "structure", label: "结构检查", status: "pass", detail: "Manifest、Contribution 和入口文件完整" },
      { id: "permission", label: "权限声明", status: "pass", detail: "仅声明 network:read" },
      { id: "tool", label: "工具调用测试（summarize_web）", status: "pass", detail: "3 个正常 URL 均返回摘要与引用" },
      { id: "edge", label: "异常 URL 测试", status: "pending", detail: "需要确认超时后的用户提示是否符合预期" },
    ],
    messages: [],
  },
  extension: {
    selectedRevision: 2,
    defaultRevision: 3,
    deleted: false,
    activations: [
      { id: "xiaonai", name: "小奈", letter: "奈", enabled: true, revision: 3, scope: "所有新 Session" },
      { id: "ops", name: "运营助手", letter: "运", enabled: true, revision: 2, scope: "固定版本" },
      { id: "assist", name: "助理小柒", letter: "柒", enabled: false, revision: null, scope: "—" },
    ],
  },
};

const screen = document.querySelector("#screen");
const titleContext = document.querySelector("#titleContext");
const sidebarContext = document.querySelector("#sidebarContext");
const scenarioSelect = document.querySelector("#scenarioSelect");
const annotationToggle = document.querySelector("#annotationToggle");
const modalRoot = document.querySelector("#modalRoot");

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusTag(status) {
  const map = {
    tool: ["使用工具", "accent"],
    idle: ["空闲", "success"],
    paused: ["已暂停", "warning"],
  };
  const [label, tone] = map[status] || [status, ""];
  return `<span class="tag ${tone}">${label}</span>`;
}

function toast(title, detail = "") {
  const region = document.querySelector("#toastRegion");
  const item = document.createElement("div");
  item.className = "toast";
  item.innerHTML = `<strong>${esc(title)}</strong>${detail ? `<small>${esc(detail)}</small>` : ""}`;
  region.appendChild(item);
  setTimeout(() => item.remove(), 3400);
}

function showModal({ title, body, confirmLabel = "确认", confirmAction = "close-modal", danger = false }) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <div class="modal">
        <h2 id="modalTitle">${esc(title)}</h2>
        <p>${body}</p>
        <div class="modal-actions">
          <button class="btn ghost" data-action="close-modal">取消</button>
          <button class="btn ${danger ? "danger" : "primary"}" data-action="${confirmAction}">${esc(confirmLabel)}</button>
        </div>
      </div>
    </div>`;
}

function closeModal() {
  modalRoot.innerHTML = "";
}

function viewRoot(view) {
  if (["agent-create", "capabilities"].includes(view)) return "agents";
  if (view === "creator") return "extension";
  return view;
}

function updateChrome() {
  document.querySelectorAll(".primary-nav button[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewRoot(state.view));
  });
  const pending = state.tool.status === "running" && !state.tool.injected ? 3 : 0;
  const badge = document.querySelector("#messageBadge");
  badge.textContent = pending;
  badge.style.display = pending ? "inline" : "none";
  scenarioSelect.value = state.view === "settings" ? "agents" : state.view;

  const titles = {
    agents: "<strong>智能体</strong> / 全部智能体",
    "agent-create": "<strong>智能体</strong> / 创建智能体",
    channel: "<strong>消息</strong> / QQ 用户群",
    capabilities: "<strong>智能体</strong> / 小奈 / 能力",
    binding: "<strong>连接</strong> / 绑定消息频道",
    creator: "<strong>创造工作台</strong> / 网页摘要",
    extension: "<strong>扩展</strong> / 网页摘要",
    settings: "<strong>设置</strong> / 本地实例",
  };
  titleContext.innerHTML = titles[state.view] || "NekroNxt";
  sidebarContext.innerHTML = renderSidebarContext();
}

function renderSidebarContext() {
  if (["agents", "agent-create", "capabilities"].includes(state.view)) {
    return `
      <div class="side-section-title"><span>智能体列表</span><button class="icon-button" data-action="navigate" data-view="agent-create">＋</button></div>
      <div class="side-list">
        ${state.agents.map((agent) => `<button class="side-item ${agent.id === "xiaonai" && state.view === "capabilities" ? "active" : ""}" data-action="manage-agent"><span class="avatar mini ${agent.id === "dev" ? "green" : agent.id === "group" ? "gold" : ""}">${agent.letter}</span><span>${agent.name}</span><span class="side-status status-dot ${agent.status === "idle" ? "healthy" : ""}"></span></button>`).join("")}
      </div>
      ${state.view === "capabilities" ? `
        <div class="divider"></div>
        <div class="side-section-title"><span>小奈</span></div>
        <div class="side-list">
          <button class="side-item">⌂ <span>概览</span></button>
          <button class="side-item">◉ <span>身份与模型</span></button>
          <button class="side-item active">✦ <span>能力</span></button>
          <button class="side-item" data-action="navigate" data-view="binding">⌁ <span>频道绑定</span></button>
          <button class="side-item">◷ <span>运行记录</span></button>
        </div>` : ""}`;
  }

  if (state.view === "channel") {
    return `
      <div class="side-section-title"><span>频道</span><button class="icon-button" data-action="navigate" data-view="binding">＋</button></div>
      <div class="side-list">
        <button class="side-item active"><span>●</span><span>QQ 用户群</span><span class="side-status tag accent">${state.tool.status === "running" ? "运行中" : ""}</span></button>
        <button class="side-item"><span>◎</span><span>Web 私聊</span></button>
        <button class="side-item"><span>◈</span><span>Discord #general</span></button>
      </div>
      <div class="info-callout" style="margin-top:16px">每个列表项对应一个独立频道会话，切换不会混合消息。</div>`;
  }

  if (state.view === "binding") {
    return `
      <div class="side-section-title"><span>连接列表</span><button class="icon-button">＋</button></div>
      <div class="side-list">
        <button class="side-item active"><span class="avatar mini gold">Q</span><span>QQ 机器人账号</span><span class="side-status status-dot healthy"></span></button>
        <button class="side-item"><span class="avatar mini green">D</span><span>Discord</span><span class="side-status status-dot healthy"></span></button>
      </div>`;
  }

  if (["extension", "creator"].includes(state.view)) {
    return `
      <div class="side-section-title"><span>本地扩展</span><button class="icon-button">＋</button></div>
      <div class="side-list">
        <button class="side-item ${state.view === "extension" ? "active" : ""}" data-action="navigate" data-view="extension"><span>▧</span><span>网页摘要</span><span class="side-status status-dot healthy"></span></button>
        <button class="side-item"><span>◉</span><span>QQ 适配器</span><span class="side-status status-dot healthy"></span></button>
        <button class="side-item"><span>▣</span><span>图片工具包</span><span class="side-status status-dot healthy"></span></button>
      </div>
      <div class="divider"></div>
      <div class="side-section-title"><span>兼容性筛选</span></div>
      <div class="side-list">
        <button class="side-item active">全部扩展</button>
        <button class="side-item">NekroNxt 扩展</button>
        <button class="side-item">DSH 兼容</button>
      </div>`;
  }

  return `<div class="side-section-title"><span>设置</span></div><div class="side-list"><button class="side-item active">本地实例</button><button class="side-item">模型服务</button><button class="side-item">数据与更新</button></div>`;
}

function render() {
  updateChrome();
  const views = {
    agents: renderAgents,
    "agent-create": renderAgentCreate,
    channel: renderChannel,
    capabilities: renderCapabilities,
    binding: renderBinding,
    creator: renderCreator,
    extension: renderExtension,
    settings: renderSettings,
  };
  screen.innerHTML = (views[state.view] || renderAgents)();
  screen.scrollTop = 0;
  startElapsedClock();
}

function renderAgents() {
  return `
    <section class="view">
      <header class="page-header">
        <div><div class="eyebrow">智能体列表</div><h1>智能体</h1><p>创建和管理你的智能体，从最近使用的频道继续工作。</p></div>
        <button class="btn primary" data-action="navigate" data-view="agent-create" data-note="打开智能体草稿；创建完成前不会写入正式对象">＋ 创建智能体</button>
      </header>
      <div class="agents-layout">
        <div class="agent-grid">
          ${state.agents.map((agent, index) => `
            <article class="card agent-card ${index === 0 ? "featured" : ""}" data-note="状态只表示智能体运行状态，不代表平台连接或节点状态">
              <div class="agent-card-top">
                <span class="avatar large ${agent.id === "dev" ? "green" : agent.id === "group" ? "gold" : ""}">${agent.letter}</span>
                <div class="agent-card-info"><h2>${agent.name}</h2>${statusTag(agent.status)}<p>${agent.activity}</p></div>
              </div>
              <div class="agent-meta"><span>▤ ${agent.channels} 个频道</span><span>✦ ${agent.extensions} 个扩展</span></div>
              <div class="agent-card-actions"><span class="faint">${agent.last}</span><div class="button-row"><button class="btn primary small" data-action="open-agent" data-agent="${agent.id}" data-note="打开最近使用的频道，不进入配置页">打开</button><button class="btn small" data-action="manage-agent" data-agent="${agent.id}" data-note="打开智能体配置，不进入聊天">管理</button></div></div>
            </article>`).join("")}
          <article class="card start-card"><div><strong>从一个智能体开始</strong><p class="muted">创建后自动生成一个网页频道，外部频道稍后绑定。</p></div><button class="btn primary" data-action="navigate" data-view="agent-create">创建智能体</button></article>
        </div>
        <aside class="panel">
          <div class="panel-title"><h2>当前节点</h2><span class="tag success">运行正常</span></div>
          <div class="node-list">
            <div class="node-list-item"><span>智能体</span><strong>3</strong></div>
            <div class="node-list-item"><span>频道</span><strong>6</strong></div>
            <div class="node-list-item"><span>活动任务</span><strong>1</strong></div>
            <div class="node-list-item"><span>连接异常</span><strong>0</strong></div>
          </div>
          <div class="divider"></div>
          <button class="text-button" data-action="navigate" data-view="channel">查看当前运行详情 →</button>
        </aside>
      </div>
    </section>`;
}

function wizardSteps(count = 4) {
  const labels = count === 4 ? ["身份", "模型", "工作方式", "确认"] : ["选择平台", "连接账号", "选择频道", "绑定智能体", "测试并完成"];
  const current = count === 4 ? state.wizardStep : state.binding.step;
  return `<div class="stepper ${count === 5 ? "binding-stepper" : ""}">${labels.map((label, index) => {
    const n = index + 1;
    const status = n < current ? "done" : n === current ? "active" : "";
    return `<button class="step ${status}" ${count === 5 ? `data-action="binding-step" data-step="${n}"` : ""} style="border:0;background:transparent"><span class="step-number">${n < current ? "✓" : n}</span><span>${label}</span></button>`;
  }).join("")}</div>`;
}

function renderAgentCreate() {
  let body = "";
  if (state.wizardStep === 1) {
    body = `<div class="panel"><div class="panel-title"><div><h2>这个智能体是谁？</h2><p>只需要一个名称和一句可理解的人设。</p></div></div><div class="form-grid"><label class="field"><span>智能体名称</span><input data-wizard-field="name" value="${esc(state.wizard.name)}" /></label><label class="field"><span>人设描述</span><textarea data-wizard-field="persona">${esc(state.wizard.persona)}</textarea><small>以后可以用自然语言继续调整，不需要编辑系统提示词。</small></label></div></div>`;
  } else if (state.wizardStep === 2) {
    body = `<div class="panel"><div class="panel-title"><div><h2>选择模型</h2><p>先选择一个可用模型，路由和高级参数以后再配置。</p></div></div><div class="choice-grid">${["DeepSeek V4", "Claude Sonnet", "GPT-5", "自定义 OpenAI 兼容服务"].map((m) => `<button class="choice-card ${state.wizard.model === m ? "active" : ""}" data-action="select-model" data-value="${m}"><strong>${m}</strong><small>${m === "DeepSeek V4" ? "推荐 · 已完成连接测试" : "可稍后配置凭据"}</small></button>`).join("")}</div></div>`;
  } else if (state.wizardStep === 3) {
    body = `<div class="panel"><div class="panel-title"><div><h2>工作方式与初始能力</h2><p>默认保持克制，高权限能力创建后单独授权。</p></div></div><div class="choice-grid">${["通用方式", "群聊伙伴", "效率工作", "自定义 Preset"].map((m) => `<button class="choice-card ${state.wizard.mode === m ? "active" : ""}" data-action="select-mode" data-value="${m}"><strong>${m}</strong><small>${m === "通用方式" ? "对话、检索与图片理解" : "创建后仍可调整"}</small></button>`).join("")}</div><div class="divider"></div><div class="summary-list"><div class="summary-row"><span>网页搜索</span><span class="tag success">开启</span></div><div class="summary-row"><span>图片理解</span><span class="tag success">开启</span></div><div class="summary-row"><span>动态创造</span><span class="tag">关闭</span></div><div class="summary-row"><span>开发 Shell / 完整文件访问</span><span class="tag">关闭</span></div></div></div>`;
  } else {
    body = `<div class="panel"><div class="panel-title"><div><h2>确认智能体</h2><p>点击创建前不会写入任何正式数据。</p></div></div><div class="summary-list"><div class="summary-row"><span>智能体</span><strong>${esc(state.wizard.name)}</strong></div><div class="summary-row"><span>人设</span><span>${esc(state.wizard.persona)}</span></div><div class="summary-row"><span>模型</span><strong>${esc(state.wizard.model)}</strong></div><div class="summary-row"><span>工作方式</span><strong>${esc(state.wizard.mode)}</strong></div><div class="summary-row"><span>高权限能力</span><span>动态创造、开发 Shell、完整文件访问均关闭</span></div></div><div class="info-callout" style="margin-top:14px">创建时会原子生成智能体、首个配置版本、网页频道与默认频道绑定。任何一步失败都不会留下半创建对象。</div></div>`;
  }
  return `
    <section class="view"><div class="wizard-shell"><header class="page-header"><div><h1>创建智能体</h1><p>完成后即可在网页频道中开始对话。</p></div><button class="btn ghost" data-action="navigate" data-view="agents">取消</button></header>${wizardSteps()}
      <div class="wizard-content">${body}<aside class="panel"><div class="panel-title"><h2>创建后将会</h2></div><div class="summary-list"><div class="summary-row"><span>1</span><strong>创建智能体与首个配置版本</strong></div><div class="summary-row"><span>2</span><strong>自动创建网页频道</strong></div><div class="summary-row"><span>3</span><strong>打开 ${esc(state.wizard.name)} 的网页对话</strong></div></div><div class="warning-callout" style="margin-top:16px">外部 QQ、Discord 等平台稍后从“连接”中绑定。</div></aside></div>
      <div class="wizard-footer"><button class="btn" data-action="wizard-back" ${state.wizardStep === 1 ? "disabled" : ""}>上一步</button><div class="button-row"><button class="btn ghost" data-action="navigate" data-view="agents">取消</button>${state.wizardStep < 4 ? `<button class="btn primary" data-action="wizard-next">下一步</button>` : `<button class="btn primary" data-action="create-agent" data-note="一个事务内创建四个关联对象；成功后才离开草稿">创建智能体</button>`}</div></div>
    </div></section>`;
}

function message(author, letter, time, text, tone = "") {
  return `<div class="message"><span class="avatar small ${tone}">${letter}</span><div><div class="message-head"><strong>${author}</strong><time>${time}</time></div><div class="message-body">${text}</div></div></div>`;
}

function renderChannel() {
  const running = state.tool.status === "running";
  const stopped = state.tool.status === "stopped";
  return `
    <section class="view flush"><div class="conversation-layout">
      <div class="conversation-main">
        <header class="conversation-header" data-note="标题属于频道；智能体只作为响应者出现在副标题">
          <div><div class="button-row"><h1>QQ 用户群</h1><span class="tag success">QQ · 已连接</span></div><p>由小奈响应 · 被提及或回复时触发</p></div>
          <div class="button-row"><button class="btn" data-action="runtime-details">查看运行详情</button><button class="btn" data-action="navigate" data-view="binding">编辑绑定</button></div>
        </header>
        <div class="message-list">
          ${message("张三", "张", "10:15", "@小奈 帮我检索一下「NekroNxt 发布说明」和「扩展开发指南」的最新文档。")}
          ${message("李四", "李", "10:15", "辛苦了，记得把关键更新点也整理一下。", "warm")}
          ${message("小奈", "奈", "10:16", "好的，我会检索相关文档并整理重点。")}
          <div class="tool-card card" data-note="工具属于触发它的智能体任务；只有这里的停止按钮可以取消执行">
            <div class="tool-head"><span class="tool-symbol">⌕</span><div class="tool-title"><strong>${running ? "正在运行：检索项目文档" : stopped ? "已停止：检索项目文档" : "已完成：检索项目文档"}</strong><span class="muted">开始时间 10:16:02 · 耗时 <span id="elapsedTime">00:01:28</span></span></div>${running ? `<span class="tag accent">执行中</span><button class="btn danger small" data-action="stop-tool">停止当前任务</button>` : stopped ? `<span class="tag danger">已由用户停止</span><button class="btn small" data-action="restart-tool">重新开始</button>` : `<span class="tag success">已完成</span>`}</div>
            <div class="tool-steps"><div class="tool-step current">正在根据关键词检索相关文档</div><div class="tool-step">读取与解析匹配到的文档内容</div><div class="tool-step">提取关键更新点与权限模型信息</div>${running ? `<button class="text-button" data-action="complete-tool" style="justify-self:start">演示：让工具执行完成</button>` : ""}</div>
          </div>
          ${running && !state.tool.injected ? `<div class="pending-context" data-note="新消息可靠入库但不会中断 Tool；安全间隙才进入下一步思考"><div class="pending-summary"><span>ⓘ 3 条新消息已收录，将在当前工具完成后纳入下一步思考</span><button class="text-button" data-action="toggle-pending">${state.tool.pendingExpanded ? "收起" : "展开查看"}</button></div>${state.tool.pendingExpanded ? `<div class="pending-messages"><div class="pending-message"><strong>赵六</strong><span>能顺便看看插件市场里“数据导出”的最新版本吗？</span></div><div class="pending-message"><strong>孙七</strong><span>我们遇到过权限校验偶发失败，有相关说明吗？</span></div><div class="pending-message"><strong>周八</strong><span>如果有迁移指南也请一起整理，谢谢。</span></div><div class="pending-note">以上消息已作为辅助上下文，不会中断当前工具执行。</div></div>` : ""}</div>` : ""}
          ${state.tool.injected ? `<div class="success-callout" style="margin:0 0 16px 45px">3 条排队消息已在安全间隙注入。小奈已重新规划：补充检索数据导出版本、权限校验和迁移指南。</div>${message("小奈", "奈", "10:18", "我已收到刚才补充的三个问题，正在基于检索结果继续整理。")}` : ""}
          ${stopped ? `<div class="warning-callout" style="margin:0 0 16px 45px">当前任务已停止，但 3 条新消息仍保留在频道记录中。重新开始后会作为新任务的输入。</div>` : ""}
          ${state.channelMessages.map((m) => message("NekroNxt", "N", m.time, esc(m.text), "green")).join("")}
        </div>
        <form class="composer" data-action="send-channel-form" data-note="发送目标始终可见；这里没有脱离消息语境的能力或创造按钮">
          <div class="composer-target">发送到：<strong>QQ 用户群</strong>（通过 QQ 机器人账号）</div>
          <div class="composer-row"><button type="button" class="btn">＋</button><input id="channelInput" placeholder="向该群发送消息…" autocomplete="off" /><button class="btn primary" type="submit">发送</button></div>
        </form>
      </div>
      <aside class="conversation-inspector"><h2 class="inspector-title">会话检查器</h2><div class="inspector-block"><small>响应智能体</small><div class="button-row"><span class="avatar small">奈</span><strong>小奈</strong></div></div><div class="inspector-block"><small>触发方式</small><strong>被提及或回复</strong></div><div class="inspector-block"><small>会话配置版本</small><strong>r${state.agentRevision}</strong></div><div class="inspector-block"><small>排队上下文</small><strong>${running && !state.tool.injected ? "3 条" : "0 条"}</strong></div><button class="text-button" data-action="navigate" data-view="binding">编辑绑定</button></aside>
    </div></section>`;
}

function capabilityRow(id, name, source, description, risk = "") {
  const checked = state.capabilities[id];
  return `<div class="capability-row"><div class="cap-name"><span>✦</span><strong>${name}</strong></div><div class="cap-description"><span class="tag">${source}</span> ${description}</div>${risk ? `<span class="tag ${risk === "极高风险" ? "danger" : risk === "高风险" ? "warning" : "accent"}">${risk}</span>` : "<span></span>"}<label class="switch"><input type="checkbox" data-capability="${id}" ${checked ? "checked" : ""}/><span class="slider"></span></label></div>`;
}

function capabilityDiffs() {
  const labels = { web: "网页检索", knowledge: "知识库读取", vision: "图片理解", scheduler: "定时任务", creation: "动态创造", shell: "开发 Shell", fullFiles: "完整文件访问", githubReadonly: "GitHub 只读" };
  return Object.keys(state.capabilities).filter((key) => state.capabilities[key] !== state.publishedCapabilities[key]).map((key) => `${state.capabilities[key] ? "启用" : "停用"}${labels[key]}`);
}

function renderCapabilities() {
  const diffs = capabilityDiffs();
  return `
    <section class="view"><header class="page-header"><div><div class="eyebrow">智能体 / 小奈 / 能力</div><div class="button-row"><h1>小奈的能力配置</h1>${diffs.length ? `<span class="tag warning">草稿 · 有未保存更改</span>` : `<span class="tag success">已保存</span>`}</div></div><div class="header-actions"><button class="btn" data-action="discard-capabilities" ${!diffs.length ? "disabled" : ""}>放弃更改</button><button class="btn primary" data-action="save-capabilities" ${!diffs.length ? "disabled" : ""} data-note="只发布新配置版本，不替换活动会话">保存为新配置</button><button class="btn primary" data-action="save-rollover" ${!diffs.length ? "disabled" : ""} data-note="发布后先计算兼容性，必要时才在安全间隙滚动会话">应用到当前会话</button></div></header>
      <div class="capability-layout">
        <div class="panel revision-banner"><div class="revision-segment"><small>当前已发布</small><strong>配置版本 r${state.agentRevision} · 使用中</strong></div><div class="revision-segment"><small>正在编辑</small><strong>${diffs.length ? `基于 r${state.agentRevision} 的草稿` : "无草稿"}</strong></div><div class="revision-segment"><small>生效规则</small><span class="muted">保存会生成 r${state.agentRevision + 1}。已有会话继续使用 r${state.agentRevision}；应用到当前会话前先检查兼容性。</span></div></div>
        <div class="capability-stack">
          <div class="panel"><div class="panel-title"><div><h2>常用能力</h2><p>日常对话中最常用、风险较低的能力。</p></div></div><div class="capability-list">${capabilityRow("web", "网页检索", "WebSearch 扩展", "搜索网页并返回来源")}${capabilityRow("knowledge", "知识库读取", "Knowledge 扩展", "从已授权知识库检索内容")}${capabilityRow("vision", "图片理解", "Vision 扩展", "理解截图、图表与照片")}${capabilityRow("scheduler", "定时任务", "Scheduler 扩展", "创建和管理提醒")}</div></div>
          <div class="panel" data-note="三个高能力分别授权；创造能力不隐式获得 Shell 或完整文件访问"><div class="panel-title"><div><h2>创造与开发</h2><p>允许此智能体在创造工作台生成并动态运行扩展。</p></div><button class="text-button" data-action="navigate" data-view="creator">进入创造工作台</button></div><div class="capability-list">${capabilityRow("creation", "动态创造", "NekroNxt 创造工作台", "生成并动态运行扩展草稿", "中风险")}${capabilityRow("shell", "开发 Shell", "主机运行时", "在受限环境执行开发命令", "高风险")}${capabilityRow("fullFiles", "完整文件访问", "主机运行时", "读写指定目录外的宿主文件", "极高风险")}</div></div>
          <div class="panel"><div class="panel-title"><div><h2>外部服务与 MCP</h2><p>通过 Connection 或 MCP 接入外部工具。</p></div><button class="btn small">管理连接</button></div><div class="summary-list"><div class="summary-row"><span>GitHub MCP</span><strong>仅读取 · 已连接</strong></div><div class="summary-row"><span>本地文件</span><strong>指定目录 · 已连接</strong></div></div></div>
          <div class="panel"><div class="panel-title"><h2>配置生效规则</h2></div><div class="effect-flow"><div class="effect-step"><strong>1 编辑草稿</strong><br><span>调整 r${state.agentRevision} 的草稿</span></div><span class="arrow">→</span><div class="effect-step"><strong>2 保存配置版本</strong><br><span>发布为不可变新版本</span></div><span class="arrow">→</span><div class="effect-step"><strong>3 明确应用</strong><br><span>兼容变化安全切换，不兼容变化滚动会话</span></div></div></div>
        </div>
        <aside class="panel"><div class="panel-title"><h2>草稿影响范围</h2></div><div class="summary-list"><div class="summary-row"><span>未来启用</span><strong>默认引用新版本</strong></div><div class="summary-row"><span>活动会话</span><strong>${state.rollover ? "等待兼容性检查" : `仍在 r${state.agentRevision}`}</strong></div></div><div class="divider"></div><div class="panel-title"><h3>待保存变更（${diffs.length}）</h3></div><div class="diff-list">${diffs.length ? diffs.map((diff, i) => `<div class="diff-item"><span class="diff-number">${i + 1}</span><span>${diff}</span></div>`).join("") : `<span class="muted">当前配置与已发布版本一致。</span>`}</div></aside>
      </div>
    </section>`;
}

function renderBindingStep() {
  const b = state.binding;
  if (b.step === 1) return `<div class="panel"><div class="panel-title"><div><h2>选择消息平台</h2><p>适配器由扩展提供，但用户从平台开始选择。</p></div></div><div class="choice-grid">${["QQ", "Discord", "Telegram", "WebHook"].map((p) => `<button class="choice-card ${b.platform === p ? "active" : ""}" data-action="select-platform" data-value="${p}"><strong>${p}</strong><small>${p === "QQ" ? "QQ 适配器 · NekroNxt 扩展" : "兼容适配器"}</small></button>`).join("")}</div></div>`;
  if (b.step === 2) return `<div class="panel"><div class="panel-title"><div><h2>连接账号</h2><p>平台连接表示一个已登录账号，不是群聊本身。</p></div><button class="btn small">＋ 添加账号</button></div><div class="choice-card active"><strong>NekroNxt（QQ 12345678）</strong><small>已连接 · 凭据有效 · 最近心跳刚刚</small></div></div>`;
  if (b.step === 3) return `<div class="panel"><div class="panel-title"><div><h2>选择真实频道</h2><p>每个群或私聊都会成为独立频道。</p></div></div><div class="choice-grid"><button class="choice-card active"><strong>产品交流群</strong><small>群号 987654 · 128 位成员</small></button><button class="choice-card"><strong>测试群</strong><small>群号 456789 · 12 位成员</small></button></div></div>`;
  if (b.step === 4) return `<div class="panel"><div class="panel-title"><div><h2>绑定智能体与响应规则</h2><p>频道绑定决定谁响应、何时响应，不修改智能体本身。</p></div></div><div class="form-grid"><label class="field"><span>主响应智能体</span><select><option>小奈 · 配置版本 r${state.agentRevision}</option><option>开发助手</option></select></label><label class="field"><span>触发方式</span><select data-binding-field="trigger"><option>被提及或回复时</option><option>每条消息</option><option>仅命令触发</option></select></label><div class="summary-row"><span>允许主动发言</span><label class="switch"><input type="checkbox" ${b.proactive ? "checked" : ""} data-action="toggle-proactive"><span class="slider"></span></label></div><label class="field"><span>历史读取</span><select><option>最近 50 条</option><option>仅触发消息</option><option>最近 100 条</option></select></label></div></div>`;
  return renderBindingTest();
}

function renderBindingTest() {
  const b = state.binding;
  const ready = b.receiveTest && b.sendTest;
  return `
    <div class="binding-summary panel" data-note="适配器、平台账号、频道和智能体是不同对象；更改只返回对应步骤">
      <div class="binding-row"><b>适配器</b><span>QQ 适配器 · NekroNxt 扩展</span><button class="text-button" data-action="binding-step" data-step="1">更改</button></div>
      <div class="binding-row"><b>平台连接</b><span>${b.connection} · 已连接</span><button class="text-button" data-action="binding-step" data-step="2">更改</button></div>
      <div class="binding-row"><b>频道</b><span>${b.channel}</span><button class="text-button" data-action="binding-step" data-step="3">更改</button></div>
      <div class="binding-row"><b>主响应智能体</b><span>${b.agent} · 配置版本 r${state.agentRevision}</span><button class="text-button" data-action="binding-step" data-step="4">更改</button></div>
    </div>
    <div class="test-grid">
      <div class="panel test-card" data-note="接收与发送权限可能单向可用，所以必须分开测试"><div class="panel-title"><div><h2>接收测试</h2><p>请在产品交流群中 @NekroNxt 发送任意消息。</p></div>${b.receiveTest ? `<span class="tag success">已收到事件</span>` : `<span class="tag">尚未测试</span>`}</div><div class="test-result">${b.receiveTest ? `<div class="message" style="margin:0"><span class="avatar small warm">豆</span><div><div class="message-head"><strong>豆豆不加糖</strong><time>今天 14:23</time></div><div class="message-body">@NekroNxt 你好，绑定测试～</div></div></div>` : `<span class="muted">等待来自所选频道的真实平台事件…</span>`}</div><button class="btn" data-action="receive-test">${b.receiveTest ? "重新测试接收" : "测试接收"}</button></div>
      <div class="panel test-card"><div class="panel-title"><div><h2>发送测试</h2><p>固定测试消息只会发送到产品交流群。</p></div>${b.sendTest ? `<span class="tag success">发送成功</span>` : `<span class="tag">尚未发送</span>`}</div><div class="test-result"><div class="message" style="margin:0"><span class="avatar small green">N</span><div><div class="message-head"><strong>NekroNxt</strong><time>预览</time></div><div class="message-body">你好！这是本频道的 NekroNxt 绑定测试消息。</div></div></div></div><button class="btn primary" data-action="send-test">${b.sendTest ? "重新发送测试消息" : "发送测试消息"}</button></div>
    </div>
    <div class="panel" style="margin-top:13px"><div class="panel-title"><h2>响应规则（摘要）</h2><button class="text-button" data-action="binding-step" data-step="4">编辑规则</button></div><div class="rules-grid"><div class="summary-row"><span>触发方式</span><strong>${b.trigger}</strong></div><div class="summary-row"><span>历史读取</span><strong>${b.history}</strong></div><div class="summary-row"><span>主动发言</span><strong>${b.proactive ? "允许（仅智能体明确选择时）" : "不允许"}</strong></div><div class="summary-row"><span>冲突规则</span><strong>仅小奈是主响应智能体</strong></div></div></div>
    <div class="${ready ? "success-callout" : "warning-callout"}" style="margin-top:13px">${ready ? "收发测试均通过：完成后 Binding 状态为“已就绪”。" : "测试尚未全部通过：现在完成会保存为“待验证”，不会谎报可用。"}</div>`;
}

function renderBinding() {
  const b = state.binding;
  return `
    <section class="view"><div class="binding-shell"><header class="page-header"><div><h1>绑定消息频道</h1><p>将平台里的一个真实频道交给指定智能体响应。</p></div><button class="btn ghost" data-action="navigate" data-view="agents">退出向导</button></header>${wizardSteps(5)}${renderBindingStep()}
      <div class="binding-bottom"><button class="btn" data-action="binding-back" ${b.step === 1 ? "disabled" : ""}>← 返回上一步</button><div class="button-row">${b.step < 5 ? `<button class="btn primary" data-action="binding-next">下一步</button>` : `<button class="btn" data-action="complete-binding" data-pending="true">稍后测试</button><button class="btn primary" data-action="complete-binding" data-note="只创建频道绑定；不会修改智能体的人设、模型或能力">完成绑定</button>`}</div></div>
    </div></section>`;
}

function renderCreatorInspector() {
  const c = state.creator;
  if (c.activeTab === "preview") return `<div class="panel"><div class="panel-title"><h2>工具预览</h2><span class="tag accent">summarize_web</span></div><label class="field"><span>网页 URL</span><input value="https://example.com/article" /></label><label class="field" style="margin-top:10px"><span>摘要长度</span><select><option>中等</option><option>简短</option><option>详细</option></select></label><button class="btn primary" style="margin-top:13px">在动态版本中试用</button></div>`;
  if (c.activeTab === "changes") return `<div class="panel"><div class="panel-title"><h2>变更摘要</h2></div><div class="summary-list"><div class="summary-row"><span>文件变化</span><strong>新增 4 · 修改 1</strong></div><div class="summary-row"><span>Contribution</span><strong>Tool: summarize_web</strong></div><div class="summary-row"><span>权限</span><strong>network:read</strong></div><div class="summary-row"><span>未申请</span><strong>Shell、完整文件访问</strong></div></div><button class="btn" style="margin-top:13px">查看生成文件</button></div>`;
  const allPass = c.validations.every((v) => v.status === "pass");
  return `
    <div class="lifecycle"><span class="life-node done">草稿</span><span class="life-arrow">→</span><span class="life-node done">动态 Package</span><span class="life-arrow">→</span><span class="life-node ${c.running ? "active" : "done"}">动态运行</span><span class="life-arrow">→</span><span class="life-node ${allPass ? "done" : "active"}">验证</span><span class="life-arrow">→</span><span class="life-node ${c.saved ? "done" : ""}">保存</span><span class="life-arrow">→</span><span class="life-node ${c.activated ? "done" : ""}">激活</span></div>
    <div class="panel"><div class="panel-title"><div><h2>动态版本</h2><p>Package #3 · 内存加载 · 仅本创造会话</p></div><span class="tag ${c.running ? "success" : ""}">${c.running ? "运行中" : "已停止"}</span></div>${c.running ? `<button class="btn danger small" data-action="stop-dynamic">停止动态版本</button>` : `<button class="btn primary small" data-action="run-dynamic">动态运行</button>`}</div>
    <div class="panel" style="margin-top:11px"><div class="panel-title"><div><h2>验证结果</h2><p>${c.validations.filter((v) => v.status === "pass").length} 项通过 · ${c.validations.filter((v) => v.status !== "pass").length} 项待确认</p></div><button class="btn small" data-action="rerun-validation">重新验证</button></div><div class="validation-list">${c.validations.map((v) => `<div class="validation-item"><span>${v.status === "pass" ? "✓" : "!"}</span><span>${v.label}</span><span class="validation-status tag ${v.status === "pass" ? "success" : "warning"}">${v.status === "pass" ? "通过" : "待确认"}</span>${v.id === "edge" && v.status !== "pass" ? `<button class="text-button" data-action="confirm-edge">确认结果</button>` : ""}</div>`).join("")}</div></div>
    <div class="panel" style="margin-top:11px"><div class="panel-title"><h2>变更摘要</h2></div><div class="summary-list"><div class="summary-row"><span>文件变更</span><strong>新增 4 · 修改 1</strong></div><div class="summary-row"><span>权限声明</span><strong>network:read</strong></div><div class="summary-row"><span>影响范围</span><strong>仅本地能力</strong></div></div></div>`;
}

function renderCreator() {
  const c = state.creator;
  const allPass = c.validations.every((v) => v.status === "pass");
  return `
    <section class="view flush"><div class="creator-shell">
      <header class="creator-top"><strong>NekroNxt 创造工作台</strong><h1>为小奈创建能力</h1><button class="btn small" data-action="navigate" data-view="extension">退出创造工作台</button></header>
      <aside class="creator-left"><div class="panel-title"><h2>创造会话</h2></div><div class="card draft-card"><small class="faint">关联智能体</small><div class="button-row" style="margin:8px 0 13px"><span class="avatar small">奈</span><strong>小奈</strong></div><small class="faint">扩展草稿</small><div class="button-row" style="margin-top:8px"><strong>网页摘要</strong><span class="tag accent">草稿中</span></div></div><div class="timeline"><div class="timeline-item done"><span class="timeline-dot"></span><strong>需求已确认</strong><small class="faint">10:24</small></div><div class="timeline-item done"><span class="timeline-dot"></span><strong>草稿 v1</strong><small class="faint">10:31</small></div><div class="timeline-item active"><span class="timeline-dot"></span><strong>动态包 #3</strong><small class="faint">当前</small></div><div class="timeline-item ${allPass ? "done" : ""}"><span class="timeline-dot"></span><strong>验证结果</strong></div><div class="timeline-item ${c.saved ? "done" : ""}"><span class="timeline-dot"></span><strong>${c.saved ? `已保存扩展版本 r${c.revision}` : "尚未保存"}</strong></div></div><button class="btn">＋ 新建检查点</button><div class="info-callout" style="margin-top:16px">本会话只操作此扩展草稿，不影响其他草稿或已保存版本。</div></aside>
      <main class="creator-chat"><div class="panel-title"><h2>与小奈协作创造</h2><span class="tag">小奈 · 已启用创造能力</span></div><div class="chat-stream"><div class="chat-bubble user">做一个可以读取网页并输出带引用摘要的能力，只允许网络读取。</div><div class="chat-bubble"><strong>小奈 · 实现计划</strong><div class="plan-card"><div class="plan-row"><span>贡献</span><strong>Tool: summarize_web</strong></div><div class="plan-row"><span>输入</span><span>URL、摘要长度</span></div><div class="plan-row"><span>输出</span><span>摘要、引用列表</span></div><div class="plan-row"><span>权限</span><span class="tag accent">network:read</span></div></div></div><div class="chat-bubble"><strong>已生成动态包 #3</strong><p class="muted">新增网页读取与摘要工具、引用提取逻辑和异常 URL 测试；没有申请 Shell 或完整文件访问。</p><button class="btn small">查看生成文件</button></div>${c.messages.map((m) => `<div class="chat-bubble ${m.role === "user" ? "user" : ""}">${esc(m.text)}</div>`).join("")}</div><form class="creator-composer" data-action="creator-message-form"><textarea id="creatorInput" placeholder="描述要修改的行为或补充测试场景…"></textarea><button class="btn primary" type="submit">发送</button></form></main>
      <aside class="creator-inspector" data-note="验证展示可展开的真实证据，不使用“AI 说成功”作为可信依据"><div class="tabs"><button class="tab ${c.activeTab === "preview" ? "active" : ""}" data-action="creator-tab" data-tab="preview">预览</button><button class="tab ${c.activeTab === "validation" ? "active" : ""}" data-action="creator-tab" data-tab="validation">验证</button><button class="tab ${c.activeTab === "changes" ? "active" : ""}" data-action="creator-tab" data-tab="changes">变更</button></div>${renderCreatorInspector()}</aside>
      <footer class="creator-footer" data-note="动态运行、持久化保存、为智能体启用是三个独立状态变化"><div class="creator-principle"><span><b>1 动态运行</b> · 临时加载</span><span><b>2 保存</b> · 本地扩展版本</span><span><b>3 启用</b> · 给指定智能体使用</span></div><div class="creator-actions"><button class="btn" data-action="creator-continue">继续修改</button><button class="btn primary" data-action="save-extension" ${!allPass || c.saved ? "disabled" : ""}>${c.saved ? `已保存 r${c.revision}` : "保存为本地扩展"}</button><button class="btn ${c.activated ? "" : "primary"}" data-action="activate-extension" ${!c.saved || c.activated ? "disabled" : ""}>${c.activated ? "已启用给小奈" : "启用给小奈"}</button></div></footer>
    </div></section>`;
}

function renderExtension() {
  const e = state.extension;
  if (e.deleted) return `<section class="view"><div class="empty-state"><div><strong>网页摘要已从本地删除</strong><p>这是原型演示状态。刷新页面可以恢复初始数据。</p><button class="btn primary" onclick="location.reload()">恢复原型</button></div></div></section>`;
  const activeCount = e.activations.filter((a) => a.enabled).length;
  const revisions = {
    3: { title: "新增引用去重", date: "2 小时前", validation: "12/12", hash: "a18f7cd2" },
    2: { title: "异常 URL 超时处理", date: "1 天前", validation: "12/12", hash: "9b7f3c1e" },
    1: { title: "首次保存", date: "3 天前", validation: "8/8", hash: "31d2ac09" },
  };
  const selected = revisions[e.selectedRevision];
  return `
    <section class="view"><div class="extension-header"><span class="extension-icon">▤</span><div class="extension-heading"><div class="button-row"><h1>网页摘要</h1><span class="tag">本地创建</span><span class="tag accent">NekroNxt 扩展</span><span class="tag success">扩展版本 r${e.defaultRevision} · 当前默认</span></div><p>读取网页并输出带引用的摘要。</p></div><button class="btn primary" data-action="navigate" data-view="creator" data-note="进入创造工作台并创建新草稿；不会直接编辑已保存版本">新建修改会话</button><button class="btn">•••</button></div>
      <div class="panel extension-summary"><div class="extension-stat"><small>状态</small><strong class="strong">已保存</strong></div><div class="extension-stat"><small>来源</small><strong>创造工作台</strong></div><div class="extension-stat"><small>权限</small><strong>network:read</strong></div><div class="extension-stat"><small>最近验证</small><strong style="color:var(--green)">全部通过 · 2 小时前</strong></div></div>
      <div class="extension-grid">
        <div class="panel"><div class="panel-title"><div><h2>贡献能力</h2><p>扩展版本向系统提供的工具、预设和界面能力。</p></div></div><div class="contribution-row"><span class="tool-symbol" style="width:36px;height:36px">⌕</span><div><strong>summarize_web</strong><small class="faint" style="display:block;margin-top:4px">输入 URL 与摘要长度 · network:read</small></div><span class="tag success">r2 引入 · 可用</span></div><div class="contribution-row"><span class="tool-symbol" style="width:36px;height:36px">≡</span><div><strong>带引用摘要预设</strong><small class="faint" style="display:block;margin-top:4px">生成带来源引用的结构化摘要</small></div><span class="tag success">r1 引入 · 可用</span></div></div>
        <div class="panel" data-note="智能体启用关系引用指定扩展版本，各智能体独立管理"><div class="panel-title"><div><h2>智能体启用情况</h2><p>安装扩展不会自动让所有智能体获得能力。</p></div><button class="btn small">管理启用</button></div>${e.activations.map((a) => `<div class="activation-row"><span class="avatar small ${a.id === "ops" ? "green" : a.id === "assist" ? "warm" : ""}">${a.letter}</span><div><strong>${a.name}</strong><small class="faint" style="display:block">${a.enabled ? "已启用" : "未启用"}</small></div><div>${a.enabled ? `使用 r${a.revision} · ${a.scope}${a.revision < e.defaultRevision ? ` <span class="tag warning">有可用更新</span>` : ""}` : "—"}</div>${a.enabled ? (a.revision < e.defaultRevision ? `<button class="btn small" data-action="update-activation" data-id="${a.id}">切换到 r${e.defaultRevision}</button>` : `<button class="btn small" data-action="toggle-activation" data-id="${a.id}">停用</button>`) : `<button class="btn small" data-action="toggle-activation" data-id="${a.id}">启用</button>`}</div>`).join("")}</div>
      </div>
      <div class="revision-grid"><div class="panel"><div class="panel-title"><h2>扩展版本历史</h2></div><div class="revision-list">${Object.entries(revisions).map(([n, r]) => `<button class="revision-item ${Number(n) === e.selectedRevision ? "active" : ""}" data-action="select-revision" data-revision="${n}"><strong>r${n}</strong><span>${r.title}<small class="faint" style="display:block;margin-top:3px">${r.date}</small></span>${Number(n) === e.defaultRevision ? `<span class="tag success">当前默认</span>` : ""}</button>`).join("")}</div><div class="info-callout" style="margin-top:13px">默认版本只影响未来启用关系或新会话，不强制热替换活动会话。</div></div><div class="panel"><div class="panel-title"><div><h2>选中版本：r${e.selectedRevision}</h2><p>${selected.title}</p></div><span class="tag success">验证通过</span></div><div class="summary-list"><div class="summary-row"><span>变更摘要</span><strong>${selected.title}，保持输出结构兼容</strong></div><div class="summary-row"><span>验证证据</span><strong>${selected.validation} 项全部通过</strong></div><div class="summary-row"><span>包指纹</span><strong>${selected.hash}</strong></div><div class="summary-row"><span>权限</span><strong>network:read（无变化）</strong></div></div><div class="button-row" style="margin-top:15px"><button class="btn primary" data-action="navigate" data-view="creator">在创造工作台基于 r${e.selectedRevision} 修改</button><button class="btn" data-action="switch-default" ${e.selectedRevision === e.defaultRevision ? "disabled" : ""}>设为默认版本</button></div></div></div>
      <div class="panel danger-zone"><div class="danger-copy"><strong style="color:#ff9d9d">危险操作</strong><p class="muted">先从全部智能体停用，再删除本地资源。</p></div><button class="btn danger" data-action="stop-all-activations" ${activeCount === 0 ? "disabled" : ""}>从全部智能体停用</button><button class="btn danger" data-action="delete-extension" ${activeCount > 0 ? "disabled" : ""} data-note="没有智能体使用时才允许删除">删除本地扩展</button><span class="muted">${activeCount > 0 ? `仍有 ${activeCount} 个智能体正在使用` : "可以安全删除"}</span></div>
    </section>`;
}

function renderSettings() {
  return `<section class="view"><header class="page-header"><div><h1>本地实例设置</h1><p>原型仅展示与产品形态相关的基础状态。</p></div></header><div class="settings-grid"><div class="panel"><div class="panel-title"><h2>运行节点</h2><span class="tag success">正常</span></div><div class="setting-row"><span>宿主类型</span><strong>Desktop · macOS</strong></div><div class="setting-row"><span>数据目录</span><strong>本地应用数据</strong></div><div class="setting-row"><span>更新通道</span><strong>稳定版</strong></div></div><div class="panel"><div class="panel-title"><h2>模型服务</h2><button class="btn small">管理</button></div><div class="setting-row"><span>DeepSeek V4</span><span class="tag success">可用</span></div><div class="setting-row"><span>Claude Sonnet</span><span class="tag">未配置</span></div></div></div></section>`;
}

function navigate(view) {
  state.view = view;
  render();
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "navigate") navigate(target.dataset.view);
  if (action === "open-agent") navigate("channel");
  if (action === "manage-agent") navigate("capabilities");
  if (action === "wizard-next") { state.wizardStep = Math.min(4, state.wizardStep + 1); render(); }
  if (action === "wizard-back") { state.wizardStep = Math.max(1, state.wizardStep - 1); render(); }
  if (action === "select-model") { state.wizard.model = target.dataset.value; render(); }
  if (action === "select-mode") { state.wizard.mode = target.dataset.value; render(); }
  if (action === "create-agent") {
    toast("智能体创建成功", `已原子创建 ${state.wizard.name}、配置版本 r1、网页频道与默认频道绑定。`);
    navigate("agents");
  }
  if (action === "toggle-pending") { state.tool.pendingExpanded = !state.tool.pendingExpanded; render(); }
  if (action === "stop-tool") showModal({ title: "停止当前任务？", body: "这会取消当前工具执行，但不会删除已经收录的 3 条群消息。", confirmLabel: "停止当前任务", confirmAction: "confirm-stop-tool", danger: true });
  if (action === "confirm-stop-tool") { state.tool.status = "stopped"; closeModal(); render(); toast("当前任务已停止", "排队消息仍保留在频道记录中。"); }
  if (action === "restart-tool") { state.tool.status = "running"; state.tool.injected = false; state.tool.elapsed = 0; render(); toast("已开始新的智能体任务"); }
  if (action === "complete-tool") { state.tool.status = "completed"; state.tool.injected = true; render(); toast("工具已完成", "3 条排队消息已在安全间隙注入，智能体正在重新规划。"); }
  if (action === "runtime-details") toast("运行详情", "当前 Turn：模型生成 1 次、Tool 调用 1 次、排队上下文 3 条。");
  if (action === "discard-capabilities") { state.capabilities = { ...state.publishedCapabilities }; state.rollover = false; render(); toast("已放弃草稿", `恢复到配置版本 r${state.agentRevision}。`); }
  if (action === "save-capabilities") {
    state.agentRevision += 1; state.publishedCapabilities = { ...state.capabilities }; state.rollover = false; render();
    toast(`已发布配置版本 r${state.agentRevision}`, `未来启用默认引用 r${state.agentRevision}；已有活动会话不受影响。`);
  }
  if (action === "save-rollover") {
    state.agentRevision += 1; state.publishedCapabilities = { ...state.capabilities }; state.rollover = true; render();
    toast(`已发布配置版本 r${state.agentRevision}`, "系统会先检查兼容性；只有不兼容变化才在安全间隙滚动会话。");
  }
  if (action === "binding-step") { state.binding.step = Number(target.dataset.step); render(); }
  if (action === "binding-next") { state.binding.step = Math.min(5, state.binding.step + 1); render(); }
  if (action === "binding-back") { state.binding.step = Math.max(1, state.binding.step - 1); render(); }
  if (action === "select-platform") { state.binding.platform = target.dataset.value; render(); }
  if (action === "toggle-proactive") { state.binding.proactive = !state.binding.proactive; }
  if (action === "receive-test") { state.binding.receiveTest = true; render(); toast("接收测试通过", "已从产品交流群收到真实平台事件，但没有触发正式智能体任务。"); }
  if (action === "send-test") { state.binding.sendTest = true; render(); toast("发送测试通过", "固定测试消息只发送到了产品交流群。"); }
  if (action === "complete-binding") {
    const ready = state.binding.receiveTest && state.binding.sendTest && !target.dataset.pending;
    state.binding.status = ready ? "ready" : "pending";
    toast(ready ? "频道绑定已就绪" : "频道绑定已保存为待验证", ready ? "后续消息进入该频道的独立会话。" : "配置已保留，但不会声称收发可用。");
    navigate("channel");
  }
  if (action === "creator-tab") { state.creator.activeTab = target.dataset.tab; render(); }
  if (action === "stop-dynamic") { state.creator.running = false; render(); toast("动态版本已停止", "Draft 和检查点仍然保留。"); }
  if (action === "run-dynamic") { state.creator.running = true; render(); toast("动态 Package #3 已加载", "仅在本创造会话中可见，尚未持久化。"); }
  if (action === "confirm-edge") { const edge = state.creator.validations.find((v) => v.id === "edge"); edge.status = "pass"; render(); toast("异常 URL 行为已确认", "所有必要验证现已通过，可以保存本地扩展版本。"); }
  if (action === "rerun-validation") { state.creator.validations.forEach((v) => { if (v.id !== "edge") v.status = "pass"; }); render(); toast("验证已重新执行", "异常 URL 的产品提示仍需要人工确认。"); }
  if (action === "creator-continue") { state.creator.saved = false; state.creator.activated = false; state.creator.revision = null; state.creator.messages.push({ role: "assistant", text: "已基于 Package #3 创建新的修改检查点，请描述下一轮修改。" }); render(); }
  if (action === "save-extension") {
    state.creator.saved = true; state.creator.revision = 1; render();
    toast("已保存为本地扩展版本 r1", "源码版本已持久化，但尚未为任何智能体启用。");
  }
  if (action === "activate-extension") { state.creator.activated = true; render(); toast("已启用给小奈", "小奈的未来启用状态将引用网页摘要 r1。"); }
  if (action === "select-revision") { state.extension.selectedRevision = Number(target.dataset.revision); render(); }
  if (action === "switch-default") { state.extension.defaultRevision = state.extension.selectedRevision; render(); toast(`默认版本已切换到 r${state.extension.defaultRevision}`, "只影响未来启用关系。"); }
  if (action === "toggle-activation") {
    const activation = state.extension.activations.find((a) => a.id === target.dataset.id);
    activation.enabled = !activation.enabled;
    activation.revision = activation.enabled ? state.extension.defaultRevision : null;
    render(); toast(activation.enabled ? `已为${activation.name}启用扩展` : `已从${activation.name}停用扩展`);
  }
  if (action === "update-activation") {
    const activation = state.extension.activations.find((a) => a.id === target.dataset.id);
    activation.revision = state.extension.defaultRevision; render();
    toast(`${activation.name}已安排切换到 r${state.extension.defaultRevision}`, "活动会话将在安全间隙采用新版本。");
  }
  if (action === "stop-all-activations") showModal({ title: "从全部智能体停用？", body: "这会从所有智能体移除此能力，但保留扩展源码和全部版本。", confirmLabel: "从全部智能体停用", confirmAction: "confirm-stop-all", danger: true });
  if (action === "confirm-stop-all") { state.extension.activations.forEach((a) => { a.enabled = false; a.revision = null; }); closeModal(); render(); toast("已从全部智能体停用", "本地扩展和全部版本仍然保留。"); }
  if (action === "delete-extension") showModal({ title: "删除本地扩展？", body: "当前没有智能体使用此扩展。删除会移除本地扩展资源和全部版本，此原型中可通过刷新恢复。", confirmLabel: "删除本地扩展", confirmAction: "confirm-delete-extension", danger: true });
  if (action === "confirm-delete-extension") { state.extension.deleted = true; closeModal(); render(); toast("本地扩展已删除"); }
  if (action === "close-modal") closeModal();
  if (action === "open-command") showModal({ title: "快速跳转", body: "这是需求确认原型。可使用顶部“快速跳转”依次检查七个核心界面和状态。", confirmLabel: "知道了" });
});

document.addEventListener("input", (event) => {
  if (event.target.dataset.wizardField) state.wizard[event.target.dataset.wizardField] = event.target.value;
  if (event.target.dataset.capability) {
    state.capabilities[event.target.dataset.capability] = event.target.checked;
    render();
  }
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-action]");
  if (!form) return;
  event.preventDefault();
  if (form.dataset.action === "send-channel-form") {
    const input = document.querySelector("#channelInput");
    const text = input.value.trim();
    if (!text) return;
    state.channelMessages.push({ text, time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) });
    render(); toast("消息已发送", "目标：QQ 用户群 · 身份：NekroNxt 平台账号");
  }
  if (form.dataset.action === "creator-message-form") {
    const input = document.querySelector("#creatorInput");
    const text = input.value.trim();
    if (!text) return;
    state.creator.messages.push({ role: "user", text }, { role: "assistant", text: "已记录修改要求，并基于当前检查点生成下一轮变更计划。动态运行前不会覆盖已保存版本。" });
    render();
  }
});

scenarioSelect.addEventListener("change", () => navigate(scenarioSelect.value));
annotationToggle.addEventListener("change", () => document.body.classList.toggle("annotating", annotationToggle.checked));

function startElapsedClock() {
  const node = document.querySelector("#elapsedTime");
  if (!node || state.tool.status !== "running") return;
  const minutes = Math.floor(state.tool.elapsed / 60).toString().padStart(2, "0");
  const seconds = (state.tool.elapsed % 60).toString().padStart(2, "0");
  node.textContent = `00:${minutes}:${seconds}`;
}

setInterval(() => {
  if (state.tool.status !== "running") return;
  state.tool.elapsed += 1;
  startElapsedClock();
}, 1000);

render();
