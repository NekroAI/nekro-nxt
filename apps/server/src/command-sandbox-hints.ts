import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * What went wrong when the command sandbox stopped a command (#96). DSH reports these in English for its own agent;
 * the agent here needs to know in plain words whether retrying makes sense and what to ask the administrator.
 *
 * - `unavailable`: the sandbox could not start (no backend, runner crashed, Windows ACL provisioning failed); no
 *   command runs at all, even `echo`.
 * - `denied`: the sandbox ran and refused a file operation outside what the access level allows.
 * - `approval`: something asked to widen access, which needs an approval service NekroNXT does not provide.
 */
export type SandboxProblem = 'unavailable' | 'denied' | 'approval'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'nekro-nxt-sandbox-hint': { readonly kind: 'nekro-nxt-sandbox-hint' }
  }
}

const UNAVAILABLE = [
  'the sandbox runner itself failed',
  'no sandbox backend is usable',
  'windows-acl-run:',
  'AclSandbox ',
  'Windows ACL temp root',
  'CreateRestrictedToken',
]

export const sandboxProblem = (text: string): SandboxProblem | undefined => {
  if (UNAVAILABLE.some((marker) => text.includes(marker))) return 'unavailable'
  if (text.includes('no approval service is composed') || text.includes('requires approval (not yet supported)'))
    return 'approval'
  if (text.includes('[sandbox: file access denied under')) return 'denied'
  return undefined
}

const CAUSE: Partial<Record<NodeJS.Platform, string>> = {
  win32:
    '在 Windows 上，常见原因是数据目录放在了非 NTFS 磁盘、网络盘或同步盘里，或者上层文件夹的权限不允许设置访问控制。',
  linux: '在 Linux 上，常见原因是没有安装 bubblewrap，或者系统禁止了非特权用户命名空间。',
  darwin: '在 macOS 上，常见原因是系统拒绝了 sandbox-exec。',
}

/** What the agent should understand and pass on; it reads this right after the tool result. */
export const sandboxHint = (problem: SandboxProblem, platform: NodeJS.Platform): string => {
  if (problem === 'unavailable')
    return [
      '〔说明〕这条命令没有执行：这台设备上的命令沙箱没能启动，不是命令本身的问题，换一种写法重试也一样。',
      CAUSE[platform] ?? '',
      `请把这个情况告诉管理员：可以把你的访问权限调到「完整访问」，命令就不再经过沙箱${platform === 'win32' ? '；也可以在 设置 → 存储 里把数据目录迁到本地 NTFS 磁盘上的普通文件夹' : ''}。管理员处理之前，不要再尝试运行命令。`,
    ].join('')
  if (problem === 'approval')
    return '〔说明〕NekroNXT 目前不能在对话里审批放宽权限的申请，这类申请都会被拒绝。需要更大的权限时，请直接告诉管理员，在你的访问权限里调整。'
  return '〔说明〕这次是文件沙箱拦下的：当前的访问权限只允许在你的工作区里写入、移动和删除文件，工作区以外的位置不能改。确实需要改工作区以外的文件时，请管理员把访问权限调到「完整访问」；不要换别的写法绕开。'
}

const resultText = (result: Readonly<ToolExecutionResult>): string =>
  [
    ...result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
    ...(result.isError ? [result.error.message] : []),
  ].join('\n')

const SANDBOXED_TOOLS = new Set(['bash'])

/**
 * Adds the hint after a command the sandbox stopped. The result itself is left as DSH wrote it, so its own markers
 * and the durable record stay the same; the hint arrives as context right after it.
 */
export const mountSandboxHints = (
  context: Context,
  options: { readonly platform?: NodeJS.Platform; readonly onUnavailable?: (detail: string) => void } = {},
): (() => void) => {
  const platform = options.platform ?? process.platform
  return context.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!SANDBOXED_TOOLS.has(exec.name)) return decision
    const text = resultText(result)
    const problem = sandboxProblem(text)
    if (problem === undefined) return decision
    if (problem === 'unavailable') options.onUnavailable?.(text.slice(0, 2_000))
    const hint = createUserMessage({
      content: [{ type: 'text', text: sandboxHint(problem, platform) }],
      source: { kind: 'nekro-nxt-sandbox-hint' },
    })
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), hint] }
  })
}
