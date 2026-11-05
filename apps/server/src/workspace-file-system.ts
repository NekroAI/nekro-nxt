import { FsError } from '@deepseek-ai/dsh-fs'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import path from 'node:path'

type Target = Parameters<SandboxedFileSystem['readText']>[0]

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * DSH's sandboxed file system with reads scoped like writes: outside `danger-full-access`, file tools only read,
 * list and stat inside the session workspace and the {@link readOnlyRoots}. Targets arrive resolved to real paths,
 * so a symlink out of these places is judged by where it points. Writes keep DSH's own fence.
 */
export class WorkspaceFileSystem extends SandboxedFileSystem {
  /** Directories outside the workspace that may be read but never written, such as the session's spill files. */
  protected readOnlyRoots(): readonly string[] {
    return []
  }

  private assertReadable(target: Target): void {
    this.assertReadablePath(canonicalPath(String(target.targetKey)), target.displayPath)
  }

  /** `realPath` is already resolved, so a final symlink is judged by its own location. */
  private assertReadablePath(realPath: string, displayPath: string): void {
    const policy = this.ctx.sandboxPolicy.resolve()
    if (policy.mode === 'danger-full-access') return
    if (isWithin(canonicalPath(policy.workspaceRoot), realPath)) return
    if (this.readOnlyRoots().some((root) => isWithin(canonicalPath(root), realPath))) return
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

/** {@link WorkspaceFileSystem} that also reads inside `readOnlyRoots`, looked up on every call. */
export const createWorkspaceFileSystem = (readOnlyRoots: () => readonly string[]): typeof WorkspaceFileSystem =>
  class ReadOnlyRootsFileSystem extends WorkspaceFileSystem {
    protected override readOnlyRoots(): readonly string[] {
      return readOnlyRoots()
    }
  }
