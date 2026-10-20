import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  CredentialDomainsSchema,
  CredentialNameSchema,
  CredentialUsageSchema,
  ExtensionIdSchema,
  JsonValueSchema,
  parseJsonValue,
  type AgentId,
  type ChannelId,
  type EpisodeId,
  type ExtensionId,
  type ExtensionRevisionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { DynamicAuthoringService, DynamicAuthoringSnapshot } from '@nekro-nxt/extension-runtime'
import { z } from 'zod'
import type { DynamicAuthoringPackageDefinitionInput } from '../dynamic-authoring-runtime.js'
import type { ExtensionAction } from './actions.js'
import type { ExtensionGovernanceToolPort, RevisionDefinition } from './tool-port.js'

/** What the revise tool tells the ledger when the next define starts a revise task. */
export interface ReviseIntent {
  readonly targetExtensionId: ExtensionId
  readonly baseRevisionId: ExtensionRevisionId
  readonly referenceRevisionId?: ExtensionRevisionId
}

export interface ExtensionAgentToolContext {
  readonly port: () => ExtensionGovernanceToolPort | undefined
  readonly authoring: DynamicAuthoringService | undefined
  readonly agentId: AgentId
  readonly channelId: ChannelId
  readonly episodeId: EpisodeId
  readonly sessionId: string
  /** Defines a candidate in this conversation, as `nekro_nxt_extension_define` does. */
  readonly define: (input: DynamicAuthoringPackageDefinitionInput) => {
    readonly pluginId: string
    readonly packageId: string
  }
  /** Defines a stored candidate again in this conversation without recording a new attempt. */
  readonly restore: (snapshot: DynamicAuthoringSnapshot) => { readonly pluginId: string; readonly packageId: string }
  readonly setReviseIntent: (intent: ReviseIntent | undefined) => void
}

const json = (value: unknown): JsonValue => parseJsonValue(JSON.parse(JSON.stringify(value)))

const renderJson = (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }]

const requirePort = (context: ExtensionAgentToolContext): ExtensionGovernanceToolPort => {
  const port = context.port()
  if (!port) throw new Error('这台 NekroNXT 没有开启扩展管理。')
  return port
}

const requireRequester = (context: ExtensionAgentToolContext): ExtensionGovernanceToolPort => {
  const port = requirePort(context)
  const verdict = port.requesterAllowed(context.agentId, context.episodeId)
  if (!verdict.allowed) throw new Error(verdict.reason)
  return port
}

/** The candidate definition in the shape the agent edits and submits back through `nekro_nxt_extension_define`. */
const editableDefinition = (definition: RevisionDefinition) => {
  const snapshot = definition.snapshot
  const pages = snapshot.contributions.filter(
    (contribution) =>
      typeof contribution === 'object' &&
      contribution !== null &&
      !Array.isArray(contribution) &&
      contribution['kind'] === 'host-page',
  )
  const commands = snapshot.contributions.flatMap((contribution) => {
    if (
      typeof contribution !== 'object' ||
      contribution === null ||
      Array.isArray(contribution) ||
      contribution['kind'] !== 'command'
    ) {
      return []
    }
    const { kind: _kind, ...definition } = contribution
    void _kind
    return [definition]
  })
  return {
    codeFormat: definition.codeFormat,
    name: snapshot.name,
    purpose: snapshot.purpose,
    code: snapshot.code,
    resources: Object.entries(snapshot.resources).map(([path, content]) => ({ path, content })),
    ...(snapshot.clientCss === undefined ? {} : { clientCssPath: snapshot.clientCss.path }),
    ...(snapshot.icon === undefined ? {} : { iconPath: snapshot.icon.path }),
    pages,
    commands,
    permissions: snapshot.permissions,
    ...(snapshot.config === undefined ? {} : { config: snapshot.config }),
    ...(snapshot.verificationInputs === undefined ? {} : { verification: snapshot.verificationInputs }),
    ...(snapshot.dataVersion === undefined ? {} : { dataVersion: snapshot.dataVersion }),
  }
}

const continueTask = (
  context: ExtensionAgentToolContext,
  port: ExtensionGovernanceToolPort,
  reference: string | undefined,
) => {
  const authoring = context.authoring
  if (!authoring) throw new Error('这台 NekroNXT 没有开启创造任务账本。')
  const task = port.continuableTask(context.agentId, context.episodeId, reference)
  const attempt = authoring.listAttempts(task.id).at(-1)
  if (!attempt) throw new Error(`任务「${task.title}」还没有候选。`)
  return { task, attempt }
}

/**
 * The agent's extension tools beyond defining candidates: see what it has, inspect one extension or task, start a
 * revise task from a saved version, continue a task left in another conversation, and take lifecycle actions within
 * its autonomy.
 */
export const extensionAgentTools = (context: ExtensionAgentToolContext) => [
  defineTool({
    name: 'nekro_nxt_extension_list',
    description:
      '查看授权范围内的本机扩展，包括其他智能体保存的扩展：名称、编号、版本、启用状态和启用前提，以及你自己的任务和待确认请求。返回扩展自主权（manual / confirm / autonomous）和当前查看范围；手动档只列出与你相关的扩展。',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute: () => Promise.resolve(json(requireRequester(context).list(context.agentId))),
  }),
  defineTool({
    name: 'nekro_nxt_extension_inspect',
    description:
      '查看一个扩展或你自己的创造任务的配置和状态：每个配置项（本机层、智能体层）的说明、类型、默认值、当前值（凭据只显示是否已填写或绑定的凭据名称）和级别，配置问题和启用前提，最近的配置版本，安装的版本、给哪些智能体启用、最近的警告和错误日志，以及你对它的各项操作（包括按级别修改配置）会直接完成、需要确认还是要到后台处理。扩展用不了、报错或用户问起配置时，先用它查清楚原因再回复。',
    parameters: {
      extension: { type: 'string', description: '扩展名称或编号。' },
      task: {
        type: 'string',
        description: '创造任务名称或编号；只有一个进行中的任务时可以不填。查看任务时不要填 extension。',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const input = z
        .object({ extension: z.string().trim().min(1).optional(), task: z.string().optional() })
        .parse(args)
      if (input.extension !== undefined && input.task !== undefined) throw new Error('extension 和 task 只填一个。')
      const port = requireRequester(context)
      return json(
        await port.inspect(
          context.agentId,
          input.extension === undefined
            ? { kind: 'task', reference: input.task }
            : { kind: 'extension', reference: input.extension },
          port.requester(context.agentId, context.episodeId),
        ),
      )
    },
  }),
  defineTool({
    name: 'nekro_nxt_credential_list',
    description:
      '查看这台 NekroNXT 上的凭据：名称、说明、使用方式、允许的域名、是否对你开放、是否需要管理员同意，以及扩展可以调用的模型供应商。看不到凭据的值。扩展要用 API 密钥或账号时先查这里，再在配置或 testConfig 里按名称绑定。',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute: async () => json(await requirePort(context).listCredentials(context.agentId)),
  }),
  defineTool({
    name: 'nekro_nxt_credential_request',
    description:
      '缺少凭据，或者要用的凭据需要管理员同意（nekro_nxt_credential_list 里 needsApproval 为 true）时用它：缺少时给出建议的名称、用途和需要访问的域名，管理员会收到通知，打开已填好的添加页面；需要同意时会在频道里发出请求，管理员用 /ext approve 同意。处理好后会通知你继续。不要让人把凭据发在聊天里。',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: '已有凭据的名称，或建议新凭据的名称，例如「天气服务 API Key」。',
      },
      purpose: { type: 'string', required: true, description: '用来做什么，管理员会看到。' },
      domains: {
        type: 'array',
        items: { type: 'string' },
        description: '凭据要发往的域名，例如 api.example.com 或 *.example.com。',
      },
      usage: {
        type: 'string',
        enum: ['request', 'program'],
        description: 'request：只在扩展发网络请求时由宿主填入（默认）；program：命令或代码需要读到值。',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute(args) {
      const input = z
        .object({
          name: CredentialNameSchema,
          purpose: z.string().trim().min(1).max(500),
          domains: CredentialDomainsSchema.optional(),
          usage: CredentialUsageSchema.optional(),
        })
        .parse(args)
      const port = requireRequester(context)
      return Promise.resolve(
        json(
          port.requestCredential(context.agentId, context.channelId, {
            name: input.name,
            purpose: input.purpose,
            domains: input.domains ?? [],
            usage: input.usage ?? 'request',
          }),
        ),
      )
    },
  }),
  defineTool({
    name: 'nekro_nxt_extension_revise',
    description:
      '修改一个已经保存的扩展：以它的某个版本（默认当前版本）为基线开始一个修改任务，返回基线的完整定义。只改需要改的部分，其余照原样带上，用 nekro_nxt_extension_define 的 { kind: "existing", pluginId } 提交，再用 cordis_run 试运行。保存时会成为这个扩展的下一个版本。合并本机修改和社区新版时，把一个作为 version、另一个作为 reference。',
    parameters: {
      extension: { type: 'string', required: true, description: '扩展名称或编号。' },
      version: { type: 'string', description: '作为基线的版本，例如 v2；不填用当前版本。' },
      reference: { type: 'string', description: '另一个版本，作为参考一起返回（比如要合并进来的本机修改）。' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const input = z
        .object({
          extension: z.string().trim().min(1),
          version: z.string().optional(),
          reference: z.string().optional(),
        })
        .parse(args)
      const port = requireRequester(context)
      const prepared = await port.prepareRevise(context.agentId, {
        extension: input.extension,
        ...(input.version === undefined ? {} : { version: input.version }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
      })
      if (prepared.openTask !== undefined) {
        const open = prepared.openTask
        if (open.episodeId === context.episodeId && !['paused', 'interrupted'].includes(open.status)) {
          return json({
            alreadyOpen: true,
            taskId: open.id,
            pluginId: open.pluginKey,
            message: `「${prepared.extensionName}」已经有一个修改任务在这个对话里进行，接着用 nekro_nxt_extension_define 的 existing 提交即可。`,
          })
        }
        const { task, attempt } = continueTask(context, port, open.id)
        const snapshot = await context.authoring!.snapshotForAttempt(attempt)
        const receipt = context.restore(snapshot)
        context.authoring!.resumeTask({
          taskId: task.id,
          channelId: context.channelId,
          episodeId: context.episodeId,
          pluginKey: receipt.pluginId,
          runnerPackageId: receipt.packageId,
        })
        return json({
          continued: true,
          taskId: task.id,
          pluginId: receipt.pluginId,
          packageId: receipt.packageId,
          message: `「${prepared.extensionName}」已有一个修改任务，已把它接到这次对话；最新候选还没运行，先 cordis_run 看看结果再接着改。`,
          latest: editableDefinition({ snapshot, codeFormat: snapshot.codeFormat ?? 'body' }),
        })
      }
      const base = prepared.base.snapshot
      context.setReviseIntent({
        targetExtensionId: prepared.extensionId,
        baseRevisionId: prepared.baseRevisionId,
        ...(prepared.referenceRevisionId === undefined ? {} : { referenceRevisionId: prepared.referenceRevisionId }),
      })
      let receipt
      try {
        receipt = context.define({
          plugin: { kind: 'new', idPrefix: prepared.idPrefix },
          name: base.name,
          purpose: base.purpose,
          code: base.code,
          resources: base.resources,
          ...(base.clientCss === undefined ? {} : { clientCss: base.clientCss }),
          ...(base.icon === undefined ? {} : { icon: base.icon }),
          permissions: base.permissions,
          contributions: base.contributions,
          ...(base.config === undefined ? {} : { config: base.config }),
          ...(base.verificationInputs === undefined ? {} : { verificationInputs: base.verificationInputs }),
          ...(base.dataVersion === undefined ? {} : { dataVersion: base.dataVersion }),
          ...(base.codeFormat === undefined ? {} : { codeFormat: base.codeFormat }),
        })
      } finally {
        context.setReviseIntent(undefined)
      }
      return json({
        pluginId: receipt.pluginId,
        packageId: receipt.packageId,
        extension: prepared.extensionName,
        base: prepared.baseLabel,
        message: `已从「${prepared.extensionName}」${prepared.baseLabel} 开始修改任务。基线已定义为第一个候选（未运行）。改完用 nekro_nxt_extension_define 的 { kind: "existing", pluginId: "${receipt.pluginId}" } 提交；codeFormat 保持 ${prepared.base.codeFormat}。`,
        definition: editableDefinition(prepared.base),
        ...(prepared.reference === undefined
          ? {}
          : { reference: { version: prepared.referenceLabel, definition: editableDefinition(prepared.reference) } }),
      })
    },
  }),
  defineTool({
    name: 'nekro_nxt_extension_continue',
    description:
      '把一个暂停、中断或留在别的对话里的创造任务接到这次对话继续做。接上后最新候选还没有运行，用 cordis_run 运行它，再接着修改。',
    parameters: {
      task: { type: 'string', description: '任务名称或编号；只有一个进行中的任务时可以不填。' },
      testConfig: {
        type: 'json',
        description:
          '可选，试运行用的配置值：{ 字段名: 值 }，和 nekro_nxt_extension_define 的 testConfig 相同；凭据字段写 { "credential": "凭据名称" }。',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const input = z
        .object({ task: z.string().optional(), testConfig: z.record(z.string(), JsonValueSchema).optional() })
        .parse(args)
      const port = requireRequester(context)
      const { task, attempt } = continueTask(context, port, input.task)
      const notes = input.testConfig === undefined ? [] : (await port.setTestConfig(task.id, input.testConfig)).notes
      const snapshot = await context.authoring!.snapshotForAttempt(attempt)
      const receipt = context.restore(snapshot)
      context.authoring!.resumeTask({
        taskId: task.id,
        channelId: context.channelId,
        episodeId: context.episodeId,
        pluginKey: receipt.pluginId,
        runnerPackageId: receipt.packageId,
      })
      return json({
        taskId: task.id,
        title: task.title,
        pluginId: receipt.pluginId,
        packageId: receipt.packageId,
        message: `「${task.title}」已经接到这次对话。先用 cordis_run 运行 ${receipt.packageId}，有问题再用 nekro_nxt_extension_define 的 existing 修改。`,
        ...(notes.length === 0 ? {} : { notes: [...notes] }),
      })
    },
  }),
  defineTool({
    name: 'nekro_nxt_extension_action',
    description: [
      '对扩展做生命周期操作。按你的扩展自主权和权限风险，结果可能是直接完成、在这次回复结束后生效（启用、切换等会改变你身上挂载的操作）、在频道里发出请求等管理员用 /ext approve 确认，或者需要管理员在后台处理；照返回的结果如实告诉用户。',
      'save：保存任务最新的、试运行通过的候选（修改任务存为原扩展的新版本，新建任务存为新扩展，可给 name、slug）。',
      'enable / disable：给你自己启用或停用。switch：切到指定版本。revert：回到上一次切换前的版本。',
      'branch：从某个版本另起一个扩展（name 必填，copyData 决定是否复制现有数据）。',
      'migrate_data：把另一个扩展（source）的数据迁到这个扩展，mode 为 overwrite（同名以来源为准，保留其余）或 replace（先清空）；includeConfig 连同配置一起迁移（凭据不迁移）。总要管理员确认。',
      'publish：把当前版本发布到社区（notes 写更新说明）。update：导入社区的新发布并切换。install：从社区安装（communityExtensionId）。withdraw：撤回一次发布（releaseId）。发布和撤回总要管理员确认。',
      'configure：修改配置。layer 为 agent（你自己的，默认）或 host（本机，所有智能体共用）；values 写 { 字段名: 值 }，null 恢复默认；凭据字段用 credentials 按名称绑定 { 字段名: "凭据名称" }，null 解除。reason 写为什么改。在回复结束后生效，一次回复里的多次修改合并。enable 也可以带 values 和 credentials 作为初始配置。',
      'revert_config：把某一层配置恢复到 inspect 的 configHistory 里的某个版本（layer、version），恢复本身也是一个新版本。',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [
          'save',
          'enable',
          'disable',
          'switch',
          'revert',
          'branch',
          'migrate_data',
          'publish',
          'update',
          'install',
          'withdraw',
          'configure',
          'revert_config',
        ],
      },
      extension: { type: 'string', description: '扩展名称或编号。' },
      task: { type: 'string', description: 'save 时的任务名称或编号。' },
      version: { type: 'string', description: 'switch 的目标版本，或 branch 的来源版本，例如 v2。' },
      name: { type: 'string', description: 'save（新扩展）或 branch 的名称。' },
      slug: { type: 'string', description: '英文短名：小写字母、数字和连字符。' },
      copyData: { type: 'boolean', description: 'branch 时是否复制原扩展的数据。' },
      source: { type: 'string', description: 'migrate_data 的来源扩展名称或编号。' },
      mode: { type: 'string', enum: ['overwrite', 'replace'], description: 'migrate_data 的方式。' },
      includeConfig: { type: 'boolean', description: 'migrate_data 时是否连同配置一起迁移（凭据不迁移）。' },
      notes: { type: 'string', description: 'publish 的更新说明。' },
      communityExtensionId: { type: 'string', description: 'install 的社区扩展编号。' },
      releaseId: { type: 'string', description: 'withdraw 的发布编号。' },
      layer: {
        type: 'string',
        enum: ['agent', 'host'],
        description: 'configure / revert_config 的配置层，默认 agent。',
      },
      values: { type: 'json', description: 'configure 或 enable 的配置值：{ 字段名: 值 }，null 恢复默认。' },
      credentials: {
        type: 'json',
        description: 'configure 或 enable 的凭据绑定：{ 字段名: "凭据名称" }，null 解除绑定。',
      },
      configVersion: { type: 'number', description: 'revert_config 要恢复到的配置版本号。' },
      reason: { type: 'string', description: 'configure / revert_config 的原因，会记在配置历史里。' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const input = z
        .object({
          action: z.enum([
            'save',
            'enable',
            'disable',
            'switch',
            'revert',
            'branch',
            'migrate_data',
            'publish',
            'update',
            'install',
            'withdraw',
            'configure',
            'revert_config',
          ]),
          extension: z.string().trim().min(1).optional(),
          task: z.string().optional(),
          version: z.string().optional(),
          name: z.string().trim().min(1).max(80).optional(),
          slug: z.string().optional(),
          copyData: z.boolean().optional(),
          source: z.string().optional(),
          mode: z.enum(['overwrite', 'replace']).optional(),
          includeConfig: z.boolean().optional(),
          notes: z.string().max(2000).optional(),
          communityExtensionId: z.string().optional(),
          releaseId: z.string().optional(),
          layer: z.enum(['agent', 'host']).optional(),
          values: z.record(z.string(), JsonValueSchema).optional(),
          credentials: z.record(z.string(), CredentialNameSchema.nullable()).optional(),
          configVersion: z.number().int().positive().optional(),
          reason: z.string().trim().max(500).optional(),
        })
        .parse(args)
      // Configuration changes follow their own requester setting, judged with the change itself.
      const configuring = input.action === 'configure' || input.action === 'revert_config'
      const port = configuring ? requirePort(context) : requireRequester(context)
      const requester = port.requester(context.agentId, context.episodeId)
      const origin = {
        actorAgentId: context.agentId,
        ...(requester.kind === 'member' ? { requesterMemberId: requester.memberId } : {}),
        ...(input.reason === undefined || input.reason === '' ? {} : { reason: input.reason }),
      }
      const extension = () => {
        if (input.extension === undefined) throw new Error('请写上扩展名称。')
        return port.resolveExtension(context.agentId, input.extension)
      }
      const revisionOf = (extensionId: ExtensionId, label: string | undefined): ExtensionRevisionId => {
        if (label === undefined) throw new Error('请写上版本，例如 v2。')
        return port.revisionByLabel(extensionId, label)
      }
      let action: ExtensionAction
      switch (input.action) {
        case 'save': {
          const task = port.resolveTask(context.agentId, input.task)
          action = {
            kind: 'save',
            taskId: task.id,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.slug === undefined ? {} : { slug: input.slug }),
          }
          break
        }
        case 'enable':
          action = {
            kind: 'enable',
            extensionId: extension().id,
            agentId: context.agentId,
            ...(input.values === undefined ? {} : { values: input.values }),
            ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
            ...(input.values === undefined && input.credentials === undefined ? {} : origin),
          }
          break
        case 'disable':
          action = { kind: 'disable', extensionId: extension().id, agentId: context.agentId }
          break
        case 'configure': {
          const layer = input.layer ?? 'agent'
          if (input.values === undefined && input.credentials === undefined) {
            throw new Error('configure 要写 values 或 credentials。')
          }
          action = {
            kind: 'configure',
            extensionId: extension().id,
            layer,
            ...(layer === 'agent' ? { agentId: context.agentId } : {}),
            values: input.values ?? {},
            credentials: input.credentials ?? {},
            ...origin,
          }
          break
        }
        case 'revert_config': {
          const target = extension()
          if (input.configVersion === undefined) throw new Error('请写上要恢复到的配置版本 configVersion。')
          action = {
            kind: 'revert-config',
            extensionId: target.id,
            versionId: port.configVersion(context.agentId, target.id, input.layer ?? 'agent', input.configVersion).id,
            ...origin,
          }
          break
        }
        case 'switch': {
          const target = extension()
          action = { kind: 'switch', extensionId: target.id, revisionId: revisionOf(target.id, input.version) }
          break
        }
        case 'revert':
          action = { kind: 'revert', extensionId: extension().id }
          break
        case 'branch': {
          const origin = extension()
          if (input.name === undefined) throw new Error('分支需要一个名称。')
          action = {
            kind: 'branch',
            revisionId:
              input.version === undefined ? port.currentRevision(origin.id) : revisionOf(origin.id, input.version),
            name: input.name,
            ...(input.slug === undefined ? {} : { slug: input.slug }),
            copyData: input.copyData === true,
          }
          break
        }
        case 'migrate_data': {
          if (input.source === undefined) throw new Error('请写上数据来源扩展。')
          action = {
            kind: 'migrate-data',
            targetExtensionId: extension().id,
            source: { kind: 'extension', extensionId: port.resolveExtension(context.agentId, input.source).id },
            mode: input.mode ?? 'overwrite',
            ...(input.includeConfig === true ? { includeConfig: true } : {}),
          }
          break
        }
        case 'publish':
          action = { kind: 'community-publish', extensionId: extension().id, notes: input.notes ?? '' }
          break
        case 'update':
          action = { kind: 'community-update', extensionId: extension().id }
          break
        case 'install':
          if (input.communityExtensionId === undefined) throw new Error('请写上社区扩展编号。')
          action = {
            kind: 'community-install',
            communityExtensionId: ExtensionIdSchema.parse(input.communityExtensionId),
            agentId: context.agentId,
          }
          break
        case 'withdraw':
          if (input.releaseId === undefined) throw new Error('请写上发布编号。')
          action = { kind: 'community-withdraw', releaseId: input.releaseId }
          break
      }
      return json(await port.act(context.agentId, context.channelId, action, requester))
    },
  }),
]
