import type { Context } from '@deepseek-ai/cordis'
import { CordisDynamicPluginId, CordisDynamicPackageId } from '@deepseek-ai/dsh-cordis-host-runner'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { parseJsonValue } from '@nekro-nxt/contracts'
import { z } from 'zod'
import type { NekroNxtDynamicCordisRunner } from './dynamic-authoring-runtime.js'

/** Product-owned commands over the public Runner; all ownership and approvals remain in the Runner. */
export function mountDynamicCordisTools(context: Context, runner: NekroNxtDynamicCordisRunner): void {
  const agentFor = (execution: ToolExecution) => {
    if (!execution.agent) throw new Error('动态扩展操作需要当前智能体。')
    return runner.resolveDynamicAuthoringOwner(execution.agent)
  }
  context.tools.register(
    defineTool({
      name: 'cordis_inspect_self',
      description: '查看当前智能体拥有的临时扩展、候选版本和运行状态。',
      parameters: {
        pluginId: { type: 'string', description: '可选插件标识。' },
        packageId: { type: 'string', description: '可选精确版本标识。' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(args, execution) {
        const owner = agentFor(execution)
        const value = args.pluginId
          ? args.packageId
            ? runner.inspectPackage(owner, CordisDynamicPluginId(args.pluginId), CordisDynamicPackageId(args.packageId))
            : runner.inspectPlugin(owner, CordisDynamicPluginId(args.pluginId))
          : runner.listPlugins(owner)
        return Promise.resolve(parseJsonValue(JSON.parse(JSON.stringify(value))))
      },
    }),
  )
  context.tools.register(
    defineTool({
      name: 'cordis_define',
      description:
        '兼容普通 Host Tool/RPC/产品 Slot 候选的定义入口；带页面、权限或资源的候选必须用 nekro_nxt_extension_define。定义不执行代码。',
      parameters: {
        plugin: {
          type: 'json',
          required: true,
          description: '{kind:"new",idPrefix:string} 或 {kind:"existing",pluginId:string}。',
        },
        name: { type: 'string', required: true, description: '候选名称。' },
        purpose: { type: 'string', required: true, description: '候选用途。' },
        code: { type: 'json', required: true, description: '至少包含 host 或 client 源码字符串。' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(args, execution) {
        const plugin = z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('new'), idPrefix: z.string().min(1) }).strict(),
            z.object({ kind: z.literal('existing'), pluginId: z.string().min(1) }).strict(),
          ])
          .parse(args.plugin)
        const code = z
          .object({ host: z.string().optional(), client: z.string().optional() })
          .strict()
          .refine((value) => value.host !== undefined || value.client !== undefined)
          .parse(args.code)
        const result = runner.define({
          sessionId: agentFor(execution).id,
          plugin:
            plugin.kind === 'new' ? plugin : { kind: 'existing', pluginId: CordisDynamicPluginId(plugin.pluginId) },
          name: args.name,
          purpose: args.purpose,
          code: {
            ...(code.host === undefined ? {} : { host: code.host }),
            ...(code.client === undefined ? {} : { client: code.client }),
          },
        })
        return Promise.resolve(parseJsonValue(JSON.parse(JSON.stringify(result))))
      },
    }),
  )
  context.tools.register(
    defineTool({
      name: 'cordis_run',
      description: '运行或更新已经定义的精确动态扩展版本。运行不等于保存或启用；客户端代码遵循当前任务的审批规则。',
      parameters: {
        pluginId: { type: 'string', required: true, description: '定义工具返回的 pluginId。' },
        packageId: { type: 'string', required: true, description: '定义工具返回的 packageId。' },
        mode: { type: 'string', enum: ['run', 'update'], description: '首次运行用 run，替换运行中的版本用 update。' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, execution) {
        const result = await runner.run(
          agentFor(execution),
          CordisDynamicPluginId(args.pluginId),
          CordisDynamicPackageId(args.packageId),
          args.mode === 'update' ? 'update' : 'run',
          execution.signal,
        )
        // An interface candidate finishes only after a browser confirms and renders it; say so, so the model can
        // direct the user to the task page and wait for the Host result instead of re-running or claiming success.
        const nextStep =
          result.ok && result.status === 'awaiting-approval'
            ? {
                nextStep:
                  '候选包含界面，需要用户在频道的扩展开发任务中打开任务页面确认运行，浏览器加载界面并完成验证后，结果会自动发给你。在此之前不要重复运行或声称已完成。',
              }
            : {}
        return parseJsonValue(JSON.parse(JSON.stringify({ ...result, ...nextStep })))
      },
    }),
  )
  for (const action of ['stop', 'undefine'] as const)
    context.tools.register(
      defineTool({
        name: `cordis_${action}`,
        description:
          action === 'stop'
            ? '停止当前动态扩展运行，保留候选版本和已保存扩展。'
            : '移除当前会话中的临时动态扩展及其运行；不删除已经保存的扩展版本。',
        parameters: { pluginId: { type: 'string', required: true, description: '当前会话拥有的临时 pluginId。' } },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, execution) {
          const result = await runner[action](agentFor(execution), CordisDynamicPluginId(args.pluginId))
          return parseJsonValue(JSON.parse(JSON.stringify(result)))
        },
      }),
    )
}
