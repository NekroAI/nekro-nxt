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

/** One line per permission, network origins and ordinary Host capabilities last. */
export const permissionLines = (declaration: HostUiPermissionDeclaration | undefined): readonly string[] => [
  ...(declaration?.permissions ?? [])
    .filter((item) => item !== 'network.request')
    .map((item) => PERMISSION_LABELS[item]),
  ...(declaration?.networkOrigins ?? []).map((origin) => `访问 ${origin}`),
  ...summarizeExtensionCapabilities(declaration?.capabilities)
    .filter((item) => item.risk !== 'high')
    .map(capabilityLine),
]

/** High-risk capabilities the user must accept one by one before enabling. */
export const highRiskCapabilities = (
  declaration: HostUiPermissionDeclaration | undefined,
): readonly ExtensionCapabilitySummaryItem[] =>
  summarizeExtensionCapabilities(declaration?.capabilities).filter((item) => item.risk === 'high')
