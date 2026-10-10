import { FsError } from '@deepseek-ai/dsh-fs'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import path from 'node:path'

type Target = Parameters<SandboxedFileSystem['readText']>[0]

/**
 * DSH's sandboxed file system with reads scoped like writes: outside `danger-full-access`, file tools only read,
 * list and stat inside the session workspace. Targets arrive resolved to real paths, so a symlink out of the
 * workspace is judged by where it points.
 */
export class WorkspaceFileSystem extends SandboxedFileSystem {
  private assertReadable(target: Target): void {
    this.assertReadablePath(canonicalPath(String(target.targetKey)), target.displayPath)
  }

  /** `realPath` is already resolved, so a final symlink is judged by its own location. */
  private assertReadablePath(realPath: string, displayPath: string): void {
    const policy = this.ctx.sandboxPolicy.resolve()
    if (policy.mode === 'danger-full-access') return
    const root = canonicalPath(policy.workspaceRoot)
    const relative = path.relative(root, realPath)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return
    throw new FsError(`cannot read "${displayPath}": outside the workspace`, 'FS_SANDBOX_DENIED')
  }

  override async lstat(...args: Parameters<SandboxedFileSystem['lstat']>) {
    const [target, opts] = args
    const absolute = path.resolve(opts?.cwd ?? this.ctx.sandboxPolicy.resolve().workspaceRoot, target)
    // The entry itself may be a symlink; its directory decides where it lives.
    this.assertReadablePath(path.join(canonicalPath(path.dirname(absolute)), path.basename(absolute)), target)
    return super.lstat(...args)
  }

  override async stat(...args: Parameters<SandboxedFileSystem['stat']>) {
    this.assertReadable(args[0])
    return super.stat(...args)
  }

  override async readText(...args: Parameters<SandboxedFileSystem['readText']>) {
    this.assertReadable(args[0])
    return super.readText(...args)
  }

  override async streamText(...args: Parameters<SandboxedFileSystem['streamText']>) {
    this.assertReadable(args[0])
    return super.streamText(...args)
  }

  override async readBytes(...args: Parameters<SandboxedFileSystem['readBytes']>) {
    this.assertReadable(args[0])
    return super.readBytes(...args)
  }

  override async readByteRange(...args: Parameters<SandboxedFileSystem['readByteRange']>) {
    this.assertReadable(args[0])
    return super.readByteRange(...args)
  }

  override async listDir(...args: Parameters<SandboxedFileSystem['listDir']>) {
    this.assertReadable(args[0])
    return super.listDir(...args)
  }

  override async watch(...args: Parameters<SandboxedFileSystem['watch']>) {
    this.assertReadable(args[0])
    return super.watch(...args)
  }
}
