import type { AgentCapabilityGrants } from '@nekro-nxt/core'
import type { CapabilityPack } from './capability-packs.js'
import { extensionCapabilityPacks } from './extension-capability-packs.js'

/** Reminders and recurring jobs of the current channel. */
export const SCHEDULED_TASKS_PACK = '定时任务'
/** Moving, deleting, packing and searching workspace files when the agent has no commands. */
export const FILE_MANAGEMENT_PACK = '文件管理'

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

const SCHEDULED_TASKS_INSTRUCTIONS =
  '到时间时你会收到一条〔定时任务到时间了〕通知，再决定在群里说什么、做什么；任务自己不会发消息。所以 label 要写清到时候做什么、对谁。'

/**
 * Every pack one agent's session offers, in catalog order. Packs whose tools this session does not register drop out
 * when the catalog is built; 「文件管理」 also needs the capability check, since commands bring tools of the same names.
 */
export const sessionCapabilityPacks = (
  capabilities: Pick<
    AgentCapabilityGrants,
    'dynamicCreation' | 'extensionAutonomy' | 'scheduledTasks' | 'fileTools' | 'developmentShell'
  >,
): CapabilityPack[] => [
  ...extensionCapabilityPacks(capabilities),
  ...(capabilities.scheduledTasks
    ? [
        {
          name: SCHEDULED_TASKS_PACK,
          purpose: '建提醒和定时任务，查看、暂停、修改已有任务。',
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
