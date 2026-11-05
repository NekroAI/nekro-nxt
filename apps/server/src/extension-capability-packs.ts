import type { AgentCapabilityGrants } from '@nekro-nxt/core'
import type { CapabilityPack } from './capability-packs.js'

/** Seeing and changing saved extensions; with manual autonomy the agent can only look. */
export const EXTENSION_MANAGEMENT_PACK = '扩展管理'
/** Writing and trying extension code. */
export const EXTENSION_DEVELOPMENT_PACK = '扩展开发'

/** Read-only management tools, the only ones an agent with manual autonomy gets. */
export const EXTENSION_VIEW_TOOLS = ['nekro_nxt_extension_list', 'nekro_nxt_extension_inspect'] as const
/** Credential lookups and requests; development needs them for test values even when management is read-only. */
export const EXTENSION_CREDENTIAL_TOOLS = [
  'nekro_nxt_credential_list',
  'nekro_nxt_credential_request',
  'nekro_nxt_extension_request_withdraw',
] as const
export const EXTENSION_ACTION_TOOLS = ['nekro_nxt_extension_action'] as const
export const EXTENSION_DEVELOPMENT_TOOLS = [
  'nekro_nxt_extension_define',
  'nekro_nxt_extension_revise',
  'nekro_nxt_extension_continue',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
  'cordis_inspect_self',
  'cordis_inspect_list',
  'cordis_inspect_query',
] as const

const MANAGEMENT_INSTRUCTIONS = [
  '扩展用不了、报错，或者有人问起它的配置时，先用 nekro_nxt_extension_inspect 查清原因再回复。',
  'nekro_nxt_extension_action 的结果可能是已完成、在这次回复结束后生效、已发出请求（附编号）或者要到后台处理，照结果如实告诉对方；新启用的工具要等下一次回复才能用。',
  '扩展要用的凭据用 nekro_nxt_credential_list 查，缺少时用 nekro_nxt_credential_request 请管理员处理，不要让人把凭据发在聊天里。',
].join('\n')

const VIEW_INSTRUCTIONS = [
  '你的扩展自主权是「手动」，只能查看与你相关的扩展；启用、配置这类改动请管理员在工坊里操作。',
  '扩展用不了、报错，或者有人问起它的配置时，先用 nekro_nxt_extension_inspect 查清原因再回复。',
].join('\n')

const DEVELOPMENT_INSTRUCTIONS = [
  '动手前先用 skill 加载 cordis-plugin-development，界面组件、宿主能力、配置、适配器和示例都在里面。',
  '',
  '一般的顺序：',
  '1. 新扩展用 nekro_nxt_extension_define 定义候选。修改已保存的扩展先用 nekro_nxt_extension_revise 开修改任务，在它返回的定义上只改需要改的部分，再用 define 的 { kind: "existing", pluginId } 提交。别的对话里没做完的任务用 nekro_nxt_extension_continue 接过来。',
  '2. 用 cordis_run 运行 define 返回的 Package，宿主会真实调用每个工具和数据接口、渲染界面来验证。失败时先用 cordis_inspect_self 看诊断，在同一个 Plugin 上提交新候选修好，不要另建一个。',
  '3. 验证通过后用 nekro_nxt_extension_action 的 save 保存，再 enable 启用（在「扩展管理」里）。扩展自主权是「手动」时由管理员在工坊里保存和启用。',
  '',
  '定义、运行、保存、启用是四个独立的步骤，每一步都等真实结果；没保存的候选不要说成已经保存。扩展要用 API 密钥或账号时，先用 nekro_nxt_credential_list 查已有凭据，在 testConfig 里按名称绑定。',
].join('\n')

/**
 * The extension packs one agent's session offers. 「扩展管理」 follows the extension autonomy setting and needs no
 * dynamic creation; 「扩展开发」 needs dynamic creation. Tools that are not registered simply drop out.
 */
/**
 * The catalog line is all an agent sees of these tools before loading them, so it carries what the agent may do on its
 * own; without it a cautious persona tends to refuse work it is allowed to do.
 */
const AUTONOMY_NOTE: Readonly<Record<'confirm' | 'autonomous', string>> = {
  confirm: '你的扩展自主权是「确认」，改动会发请求给管理员确认。',
  autonomous: '你的扩展自主权是「自主」，只影响自己的普通操作可以直接完成。',
}

export const extensionCapabilityPacks = (
  capabilities: Pick<AgentCapabilityGrants, 'dynamicCreation' | 'extensionAutonomy'>,
): CapabilityPack[] => {
  const manual = capabilities.extensionAutonomy === 'manual'
  return [
    manual
      ? {
          name: EXTENSION_MANAGEMENT_PACK,
          purpose: '查看与你相关的扩展：启用状态、配置和最近的错误。',
          tools: [...EXTENSION_VIEW_TOOLS],
          instructions: VIEW_INSTRUCTIONS,
        }
      : {
          name: EXTENSION_MANAGEMENT_PACK,
          purpose: `查看和管理已有扩展：启用、配置、绑定凭据、安装、更新和发布。${AUTONOMY_NOTE[capabilities.extensionAutonomy === 'confirm' ? 'confirm' : 'autonomous']}`,
          tools: [...EXTENSION_VIEW_TOOLS, ...EXTENSION_ACTION_TOOLS, ...EXTENSION_CREDENTIAL_TOOLS],
          instructions: MANAGEMENT_INSTRUCTIONS,
        },
    ...(capabilities.dynamicCreation
      ? [
          {
            name: EXTENSION_DEVELOPMENT_PACK,
            purpose: '制作新扩展或修改扩展代码，试运行并保存。你开着动态创造，有人请你做扩展时可以自己动手。',
            tools: [...EXTENSION_DEVELOPMENT_TOOLS, ...(manual ? EXTENSION_CREDENTIAL_TOOLS : [])],
            instructions: DEVELOPMENT_INSTRUCTIONS,
          },
        ]
      : []),
  ]
}
