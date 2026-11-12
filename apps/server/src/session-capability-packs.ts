import type { AgentCapabilityGrants } from '@nekro-nxt/core'
import type { CapabilityPack } from './capability-packs.js'
import { COMMUNITY_DOCS_TOOLS } from './community-docs-tools.js'
import { communityCapabilityPack, extensionCapabilityPacks } from './extension-capability-packs.js'

/** Reminders and recurring jobs of the current channel. */
export const SCHEDULED_TASKS_PACK = '定时任务'
/** Moving, deleting, packing and searching workspace files when the agent has no commands. */
export const FILE_MANAGEMENT_PACK = '文件管理'
/** The NekroNXT user documentation on the community site (「查阅社区文档」). */
export const COMMUNITY_DOCS_PACK = '使用文档'

export const SCHEDULED_TASK_TOOLS = [
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_pause',
  'schedule_resume',
  'schedule_delete',
  'schedule_run_now',
] as const

/** The workspace tier's file tools beside read, write and edit, which stay resident. */
export const WORKSPACE_FILE_TOOLS = [
  'move',
  'copy',
  'delete',
  'make_dir',
  'file_info',
  'diff',
  'zip',
  'unzip',
  'glob',
  'grep',
] as const

const COMMUNITY_DOCS_INSTRUCTIONS = [
  '先用自己的话把做法或原因讲清楚，按对方的情况挑重点，不要整段照抄文档；再附上最相关的一个链接，方便对方自己看完整步骤和截图。',
  '文档版本和这台 NekroNXT 一致。文档里没有的按钮、设置不要编；查不到就直说，并给出最接近的页面。',
  '对方找不到界面上的位置、或者一段流程说不清时，把文档里对应的图发过去，比描述位置快；一次一两张，不要整页地发。',
].join('\n')

const SCHEDULED_TASKS_INSTRUCTIONS =
  '到时间时你会收到一条〔定时任务到时间了〕通知，再决定在群里说什么、做什么；任务自己不会发消息。所以 label 要写清到时候做什么、对谁。'

/**
 * Every pack one agent's session offers, in catalog order. Packs whose tools this session does not register drop out
 * when the catalog is built; 「文件管理」 also needs the capability check, since commands bring tools of the same names.
 */
export const sessionCapabilityPacks = (
  capabilities: Pick<
    AgentCapabilityGrants,
    'dynamicCreation' | 'extensionAutonomy' | 'scheduledTasks' | 'fileTools' | 'developmentShell' | 'communityDocs'
  >,
): CapabilityPack[] => [
  ...extensionCapabilityPacks(capabilities),
  communityCapabilityPack(capabilities),
  ...(capabilities.communityDocs
    ? [
        {
          name: COMMUNITY_DOCS_PACK,
          purpose: '查 NekroNXT 官方使用文档：有人问 NekroNXT 怎么用、某个设置在哪、遇到报错或故障时。',
          tools: [...COMMUNITY_DOCS_TOOLS],
          instructions: COMMUNITY_DOCS_INSTRUCTIONS,
        },
      ]
    : []),
  ...(capabilities.scheduledTasks
    ? [
        {
          name: SCHEDULED_TASKS_PACK,
          purpose: '建提醒和定时任务，也能让自己过一会儿回来接着做；查看、暂停、修改已有任务。',
          tools: [...SCHEDULED_TASK_TOOLS],
          instructions: SCHEDULED_TASKS_INSTRUCTIONS,
        },
      ]
    : []),
  ...(capabilities.fileTools && !capabilities.developmentShell
    ? [
        {
          name: FILE_MANAGEMENT_PACK,
          purpose: '移动、复制、删除文件和目录，压缩解压，按文件名或内容查找。读、写、改文件不用加载。',
          tools: [...WORKSPACE_FILE_TOOLS],
        },
      ]
    : []),
]
