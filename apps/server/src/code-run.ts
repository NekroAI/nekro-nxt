import type { Context } from '@deepseek-ai/cordis'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/**
 * DSH reads the `run_code` runtime and its sandbox policy from the root context, while NXT gives every agent its own
 * sandbox. The root pieces are mounted so that only `ptcRuntime` and the policy become visible: the policy sits behind
 * an isolated `systemPrompt` (otherwise it adds a file-policy line to every agent's prompt), and the runtime's own
 * filesystem, subprocess and sandbox services stay private. Programs always run in `workspace-write` under the calling
 * Session's workspace, also for agents granted unrestricted file access.
 */
export async function mountCodeRunRuntime(
  root: Context,
  options: { readonly nodeExecutable: string | undefined; readonly fallbackDirectory: string },
): Promise<void> {
  await root.isolate('systemPrompt').plugin(SandboxPolicyService, {
    mode: 'workspace-write',
    workspaceRoot: options.fallbackDirectory,
  })
  const runtime = root.isolate('fs').isolate('subprocess').isolate('sandbox')
  await runtime.plugin(SandboxedFileSystem, { cwd: options.fallbackDirectory })
  await runtime.plugin(LocalSubprocessRuntime)
  await runtime.plugin(LocalSandboxProvider, {})
  await runtime.plugin(
    NodePtcRuntime,
    options.nodeExecutable === undefined ? {} : { launch: { kind: 'node-script', executable: options.nodeExecutable } },
  )
}
