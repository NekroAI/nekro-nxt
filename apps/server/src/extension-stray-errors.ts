import { ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import type { NekroRuntime } from './bootstrap.js'
import type { HostLogService } from './logs/service.js'

/** Where an error that reached the process came from, read off its stack. */
export type StrayErrorSource =
  { readonly kind: 'candidate'; readonly pluginId: string } | { readonly kind: 'revision'; readonly revisionId: string }

const CANDIDATE_FRAME = /cordis-dyn-([A-Za-z0-9_-]+)\.js:\d+/u
const REVISION_FRAME = /extension-cache[\\/](xrv_[0-9A-Za-z]+)[\\/]/u

/**
 * The extension whose code is on the error's stack: a dynamic candidate runs as `cordis-dyn-<plugin>.js`, a saved
 * Revision is imported from its build in `extension-cache/<revision>/`. `undefined` when no extension frame is found.
 */
export const strayErrorSource = (error: unknown): StrayErrorSource | undefined => {
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  const candidate = CANDIDATE_FRAME.exec(stack)
  if (candidate) return { kind: 'candidate', pluginId: candidate[1]! }
  const revision = REVISION_FRAME.exec(stack)
  return revision ? { kind: 'revision', revisionId: revision[1]! } : undefined
}

/** What went wrong, in words the agent can act on. */
export const strayErrorMessage = (error: unknown): string => {
  if (error instanceof Error && 'code' in error && error.code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING') {
    return '动态扩展不能用 import() 加载模块'
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Handles an error no code waited for (an unhandled rejection or an uncaught exception). When it comes from an
 * extension, it is logged against that extension, a candidate's agent is told, and the host keeps running: the
 * failure unwound only the extension's own call. Anything else returns false and should end the process as before.
 */
export const handleStrayExtensionError = (
  runtime: Pick<NekroRuntime, 'repository' | 'host'>,
  logs: HostLogService | undefined,
  error: unknown,
): boolean => {
  const source = strayErrorSource(error)
  if (source === undefined) return false
  const message = strayErrorMessage(error)
  const details = { stack: error instanceof Error ? error.stack : undefined }
  if (source.kind === 'candidate') {
    runtime.host.reportCandidateCrash(source.pluginId, message)
    logs?.write({
      level: 'error',
      message: `动态扩展候选 ${source.pluginId} 运行出错，错误没有被处理：${message}`,
      source: { kind: 'system', id: 'dynamic-authoring', name: '动态创造' },
      details,
    })
    return true
  }
  const parsed = ExtensionRevisionIdSchema.safeParse(source.revisionId)
  const revision = parsed.success ? runtime.repository.getExtensionRevision(parsed.data) : undefined
  const extensionId = revision?.extensionId ?? source.revisionId
  const name = (revision && runtime.repository.getExtension(revision.extensionId)?.displayName) || '扩展'
  logs?.write({
    level: 'error',
    message: `「${name}」运行出错，错误没有被处理：${message}`,
    source: { kind: 'extension', id: extensionId, name },
    scope: { extensionId, revisionId: source.revisionId },
    details,
  })
  return true
}
