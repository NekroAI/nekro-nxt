import {
  summarizeExtensionCapabilities,
  type ExtensionCapabilitySummaryItem,
  type HostUiPermission,
  type HostUiPermissionDeclaration,
} from '@nekro-nxt/contracts'

/** What each permission lets an extension do, phrased for the person approving it. */
export const PERMISSION_LABELS: Readonly<Record<HostUiPermission, string>> = {
  'agents.read': '查看智能体',
  'channels.read': '查看频道',
  'connections.read': '查看平台账号',
  'extensions.read': '查看扩展',
  'dsh-plugins.read': '查看 DSH 插件',
  'runtime.read': '查看运行状态与上下文用量',
  'messages.read': '读取消息',
  'assets.read': '读取图片与文件',
  'agents.manage': '修改智能体',
  'channels.manage': '修改频道与绑定',
  'connections.manage': '修改平台账号',
  'credentials.write': '写入凭据',
  'messages.send': '发送消息',
  'notifications.publish': '发送通知',
  'network.request': '访问外部网络',
}

const capabilityLine = (item: ExtensionCapabilitySummaryItem): string =>
  item.detail === undefined ? item.label : `${item.label}：${item.detail}`

export type PermissionLayer = 'host' | 'agent'

/** One line per permission, network origins and ordinary capabilities last; high-risk ones are accepted separately. */
export const permissionLines = (
  declaration: HostUiPermissionDeclaration | undefined,
  layer: PermissionLayer = 'agent',
  fieldTitle?: (key: string) => string,
): readonly string[] => [
  ...(declaration?.permissions ?? [])
    .filter((item) => item !== 'network.request')
    .map((item) => PERMISSION_LABELS[item]),
  ...(declaration?.networkOrigins ?? []).map((origin) => `访问 ${origin}`),
  ...summarizeExtensionCapabilities(declaration?.capabilities, {
    layer,
    ...(fieldTitle === undefined ? {} : { fieldTitle }),
  })
    .filter((item) => item.risk !== 'high')
    .map(capabilityLine),
]

/** High-risk capabilities the user must accept one by one; keys carry the layer, since both layers may declare one. */
export const highRiskCapabilities = (
  declaration: HostUiPermissionDeclaration | undefined,
  layer: PermissionLayer = 'agent',
): readonly ExtensionCapabilitySummaryItem[] =>
  summarizeExtensionCapabilities(declaration?.capabilities, { layer })
    .filter((item) => item.risk === 'high')
    .map((item) => ({ ...item, key: `${layer}:${item.key}` }))
