/**
 * Risk levels of what an extension declares, shared by NekroNXT and the community: the community labels a release
 * with them, and NekroNXT uses the same levels to decide what an agent may do on its own and what an administrator
 * must confirm.
 */
export type PermissionLevel = 'normal' | 'elevated' | 'high'

/** `host`: approved when installed on the machine; `agent`: approved when enabled for each agent. */
export type PermissionLayer = 'host' | 'agent'

export interface PermissionItem {
  readonly key: string
  readonly level: PermissionLevel
  readonly label: string
  readonly detail?: string
  readonly layer: PermissionLayer
}

/** `block` must not be published; `risk` needs a human review; `warning` and `info` only inform. */
export type RiskSeverity = 'info' | 'warning' | 'risk' | 'block'

export interface RiskFinding {
  readonly id: string
  readonly severity: RiskSeverity
  readonly title: string
  readonly detail: string
  readonly file?: string
  readonly line?: number
}

const LEVEL_RANK: Readonly<Record<PermissionLevel, number>> = { normal: 0, elevated: 1, high: 2 }

/** The highest level among the items; `normal` when there are none. */
export const highestPermissionLevel = (items: readonly Pick<PermissionItem, 'level'>[]): PermissionLevel =>
  items.reduce<PermissionLevel>((top, item) => (LEVEL_RANK[item.level] > LEVEL_RANK[top] ? item.level : top), 'normal')

/** Items of `next` that are new or of a higher level than in `previous`, compared per layer. */
export const addedPermissionItems = (
  previous: readonly PermissionItem[],
  next: readonly PermissionItem[],
): PermissionItem[] => {
  const known = new Map<string, number>()
  for (const item of previous) {
    const key = `${item.layer}:${item.key}`
    known.set(key, Math.max(known.get(key) ?? -1, LEVEL_RANK[item.level]))
  }
  return next.filter((item) => {
    const before = known.get(`${item.layer}:${item.key}`)
    return before === undefined || LEVEL_RANK[item.level] > before
  })
}

type Json = Record<string, unknown>

const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/**
 * Manifest V7 的两层声明：浏览器侧权限与 `permissions.host` 在安装到本机时批准，`permissions.agent` 在给每个智能体
 * 启用时批准。
 */
export interface DeclaredPermissions {
  readonly hostUi: readonly string[]
  readonly networkOrigins: readonly string[]
  readonly host: Json
  readonly agent: Json
}

export const declaredPermissions = (manifest: Readonly<Json>): DeclaredPermissions => {
  const permissions = asObject(manifest['permissions']) ?? {}
  return {
    hostUi: asStrings(permissions['permissions']),
    networkOrigins: asStrings(permissions['networkOrigins']),
    host: asObject(permissions['host']) ?? {},
    agent: asObject(permissions['agent']) ?? {},
  }
}

/** 两层能力合在一起看（组合风险规则不区分在哪一层声明）。 */
const mergedCapabilities = ({ host, agent }: DeclaredPermissions): Json => ({
  ...agent,
  ...(host['network'] !== undefined && agent['network'] === undefined ? { network: host['network'] } : {}),
})

/** 界面权限：读取类为普通；能改动宿主或代发消息的为高。 */
const HOST_UI_LABELS: Readonly<Record<string, readonly [PermissionLevel, string]>> = {
  'agents.read': ['normal', '读取智能体列表与配置'],
  'channels.read': ['normal', '读取频道列表'],
  'connections.read': ['normal', '读取平台连接'],
  'extensions.read': ['normal', '读取已安装扩展'],
  'dsh-plugins.read': ['normal', '读取 DSH 插件'],
  'runtime.read': ['normal', '读取运行状态'],
  'messages.read': ['elevated', '读取聊天消息'],
  'assets.read': ['elevated', '读取图片与文件'],
  'agents.manage': ['high', '修改智能体'],
  'channels.manage': ['high', '修改频道'],
  'connections.manage': ['high', '修改平台连接'],
  'credentials.write': ['high', '写入凭据'],
  'messages.send': ['high', '以管理员身份发送消息'],
  'notifications.publish': ['normal', '发送界面通知'],
  'network.request': ['elevated', '从界面访问网络'],
}

const KNOWN_HOST_CAPABILITIES = new Set(['network', 'storage', 'assets', 'index', 'models'])

const KNOWN_CAPABILITIES = new Set([
  'network',
  'storage',
  'assets',
  'index',
  'history',
  'inboundHook',
  'jobs',
  'platform',
  'llm',
  'mcp',
  'context',
])

const capabilityItems = (declaredCapabilities: Json, layer: PermissionLayer): PermissionItem[] => {
  const known = layer === 'host' ? KNOWN_HOST_CAPABILITIES : KNOWN_CAPABILITIES
  // The host layer has network, storage, the asset library, search indexes and model calls; anything else there is
  // reported as unknown below.
  const capabilities = Object.fromEntries(Object.entries(declaredCapabilities).filter(([key]) => known.has(key)))
  const items: Omit<PermissionItem, 'layer'>[] = []
  const network = asObject(capabilities['network'])
  if (network !== undefined) {
    const mode = network['mode']
    if (mode === 'domains') {
      items.push({
        key: 'network',
        level: 'normal',
        label: '访问指定网站',
        detail: asStrings(network['domains']).join('、'),
      })
    } else if (mode === 'config') {
      items.push({
        key: 'network',
        level: 'elevated',
        label: '访问你在配置中填写的地址',
        detail: asStrings(network['fields']).join('、'),
      })
    } else {
      const purpose = network['purpose']
      items.push({
        key: 'network',
        level: 'high',
        label: '访问任意网站',
        ...(typeof purpose === 'string' ? { detail: purpose } : {}),
      })
    }
  }
  const storage = asObject(capabilities['storage'])
  if (storage !== undefined) {
    items.push(
      layer === 'host'
        ? { key: 'storage', level: 'normal', label: '保存扩展数据（本机共用）' }
        : { key: 'storage', level: 'normal', label: '保存扩展数据', detail: asStrings(storage['scopes']).join('、') },
    )
  }
  const assets = asObject(capabilities['assets'])
  if (assets !== undefined) {
    // Wording matches what NekroNXT shows when approving the same capability.
    if (assets['write'] === true) items.push({ key: 'assets', level: 'normal', label: '生成图片与文件' })
    if (asObject(assets['library']) !== undefined) {
      items.push({
        key: 'assets.library',
        level: 'elevated',
        label: '把频道里的图片收进扩展资源库，之后可以在其他频道使用',
      })
    }
  }
  const index = asObject(capabilities['index'])
  if (index !== undefined) {
    const names = asArray(index['collections'])
      .map((collection) => asObject(collection)?.['name'])
      .filter((name): name is string => typeof name === 'string')
    items.push({ key: 'index', level: 'normal', label: '建立可搜索的索引', detail: names.join('、') })
  }
  const models = asObject(capabilities['models'])
  if (models !== undefined) {
    const perMinute = models['maxCallsPerMinute']
    items.push({
      key: 'models',
      level: 'elevated',
      label: '使用本机已配置的模型，可以发送图片（消耗用量）',
      ...(typeof perMinute === 'number' ? { detail: `每分钟最多 ${perMinute} 次` } : {}),
    })
  }
  if (asObject(capabilities['history']) !== undefined) {
    items.push({ key: 'history', level: 'high', label: '读取当前频道的聊天记录' })
  }
  const hook = asObject(capabilities['inboundHook'])
  if (hook !== undefined) {
    const effects = [
      hook['mayHide'] === true ? '可隐藏消息' : '',
      hook['mayForceTrigger'] === true ? '可唤醒智能体' : '',
    ]
      .filter(Boolean)
      .join('，')
    items.push({
      key: 'inboundHook',
      level: hook['reads'] === 'all' ? 'high' : 'elevated',
      label: hook['reads'] === 'all' ? '查看频道内每条新消息' : '查看会唤醒智能体的新消息',
      ...(effects ? { detail: effects } : {}),
    })
  }
  const jobs = asObject(capabilities['jobs'])
  if (jobs !== undefined) {
    const declared = asArray(jobs['declared']).length
    items.push({
      key: 'jobs',
      level: 'normal',
      label: '定时任务',
      ...(declared > 0 ? { detail: `${declared} 个固定任务` } : {}),
    })
  }
  const platform = asObject(capabilities['platform'])
  if (platform !== undefined) {
    const actions = asArray(platform['actions']).length
    const raw = asStrings(platform['raw'])
    if (actions > 0)
      items.push({ key: 'platform.actions', level: 'elevated', label: '执行平台操作', detail: `${actions} 项` })
    if (raw.length > 0) {
      items.push({ key: 'platform.raw', level: 'high', label: '调用平台原始接口', detail: raw.join('、') })
    }
  }
  const llm = asObject(capabilities['llm'])
  if (llm !== undefined) {
    const calls = llm['maxCallsPerTurn']
    items.push({
      key: 'llm',
      level: 'elevated',
      label: '调用模型（消耗用量）',
      ...(typeof calls === 'number' ? { detail: `每轮最多 ${calls} 次` } : {}),
    })
  }
  const mcp = asObject(capabilities['mcp'])
  if (mcp !== undefined) {
    for (const server of asArray(mcp['servers'])) {
      const entry = asObject(server)
      if (entry === undefined) continue
      const name = typeof entry['name'] === 'string' ? entry['name'] : 'MCP'
      if (entry['transport'] === 'stdio') {
        const command = typeof entry['command'] === 'string' ? entry['command'] : ''
        items.push({ key: 'mcp.stdio', level: 'high', label: `在你的设备上运行程序（${name}）`, detail: command })
      } else {
        const url = typeof entry['url'] === 'string' ? entry['url'] : ''
        items.push({ key: 'mcp.http', level: 'elevated', label: `连接 MCP 服务（${name}）`, detail: url })
      }
    }
  }
  const context = asArray(capabilities['context'])
  if (context.length > 0) {
    items.push({ key: 'context', level: 'normal', label: '向智能体提供上下文', detail: `${context.length} 段` })
  }
  for (const key of Object.keys(declaredCapabilities)) {
    if (!known.has(key)) items.push({ key, level: 'elevated', label: `未知能力：${key}` })
  }
  return items.map((item) => ({ ...item, layer }))
}

/** 权限摘要：本机层（浏览器侧权限与 `permissions.host`）在前，智能体层（`permissions.agent`）在后。 */
export const summarizePermissions = (manifest: Readonly<Json>): PermissionItem[] => {
  const declared = declaredPermissions(manifest)
  const items: PermissionItem[] = []
  for (const permission of declared.hostUi) {
    const known = HOST_UI_LABELS[permission]
    items.push(
      known === undefined
        ? { key: permission, level: 'elevated', label: `未知权限：${permission}`, layer: 'host' }
        : {
            key: permission,
            level: known[0],
            label: known[1],
            ...(permission === 'network.request' && declared.networkOrigins.length > 0
              ? { detail: declared.networkOrigins.join('、') }
              : {}),
            layer: 'host',
          },
    )
  }
  items.push(...capabilityItems(declared.host, 'host'), ...capabilityItems(declared.agent, 'agent'))
  return items
}

/** 单项合理、组合起来可被利用的能力。 */
export const combinationFindings = (manifest: Readonly<Json>): RiskFinding[] => {
  const declared = declaredPermissions(manifest)
  const { hostUi } = declared
  const capabilities = mergedCapabilities(declared)
  const findings: RiskFinding[] = []
  const network = asObject(capabilities['network'])
  const hasNetwork = network !== undefined || hostUi.includes('network.request')
  const hook = asObject(capabilities['inboundHook'])
  if (asObject(capabilities['history']) !== undefined && hasNetwork) {
    findings.push({
      id: 'combo.history-network',
      severity: 'risk',
      title: '可外传聊天记录',
      detail: '扩展同时能读取聊天记录和访问网络，需要确认它不会把聊天内容发送出去。',
    })
  }
  if (hook?.['reads'] === 'all' && hasNetwork) {
    findings.push({
      id: 'combo.hook-all-network',
      severity: 'risk',
      title: '可外传全部群消息',
      detail: '扩展能查看频道内每条新消息并访问网络，需要确认它不会把消息发送出去。',
    })
  }
  if (hook?.['mayHide'] === true && hook['mayForceTrigger'] === true) {
    findings.push({
      id: 'combo.hook-hide-trigger',
      severity: 'risk',
      title: '可隐藏消息并操纵智能体唤醒',
      detail: '扩展既能对智能体隐藏消息，又能强制唤醒智能体，可被用来改变智能体看到的对话。',
    })
  }
  const mcp = asObject(capabilities['mcp'])
  if (asArray(mcp?.['servers']).some((server) => asObject(server)?.['transport'] === 'stdio')) {
    findings.push({
      id: 'capability.mcp-stdio',
      severity: 'risk',
      title: '会在宿主机上运行程序',
      detail: '扩展声明了本机 MCP 程序，启用后会在运行 NekroNXT 的设备上执行命令。',
    })
  }
  if (asStrings(asObject(capabilities['platform'])?.['raw']).length > 0) {
    findings.push({
      id: 'capability.platform-raw',
      severity: 'risk',
      title: '可调用平台原始接口',
      detail: '原始接口不经过 NekroNXT 的结构化检查，可执行平台允许的任意操作。',
    })
  }
  if (network?.['mode'] === 'unrestricted') {
    findings.push({
      id: 'capability.network-unrestricted',
      severity: 'warning',
      title: '网络访问不受限',
      detail: '扩展可以访问任意网站，请确认声明的用途与源码一致。',
    })
  }
  if (hostUi.includes('credentials.write')) {
    findings.push({
      id: 'permission.credentials-write',
      severity: 'warning',
      title: '可写入凭据',
      detail: '扩展页面可以写入 NekroNXT 中保存的凭据。',
    })
  }
  if (
    (hostUi.includes('connections.manage') || hostUi.includes('agents.manage')) &&
    hostUi.includes('network.request')
  ) {
    findings.push({
      id: 'combo.manage-network',
      severity: 'risk',
      title: '可修改宿主配置并访问网络',
      detail: '扩展页面能修改智能体或平台连接，同时能访问网络，可被远程控制。',
    })
  }
  return findings
}
