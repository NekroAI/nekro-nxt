import type { CommunitySource, HostApiResponse } from '@nekro-nxt/contracts'
import { randomUUID } from 'node:crypto'
import type { NekroRuntime } from './bootstrap.js'
import { parseExtensionImport, type ParsedExtensionImport } from './host-route-support.js'

const IMPORT_TTL_MS = 10 * 60_000

/**
 * 扩展包导入的第一步：解析并校验包，暂存到用户确认。本地文件与社区下载共用这一步，确认仍走同一个提交接口。
 */
export class ExtensionImportStaging {
  readonly #pending = new Map<string, { readonly parsed: ParsedExtensionImport; readonly expiresAt: number }>()
  readonly #sources = new Map<string, Omit<CommunitySource, 'installedAt'>>()

  inspect(runtime: NekroRuntime, bytes: Uint8Array): HostApiResponse<'inspectExtensionImport'> {
    this.#prune()
    const parsed = parseExtensionImport(bytes)
    const existingRevision = runtime.repository.getExtensionRevision(parsed.manifest.revision.id)
    if (
      existingRevision &&
      (existingRevision.extensionId !== parsed.manifest.extension.id ||
        existingRevision.contentDigest !== parsed.manifest.revision.contentDigest ||
        existingRevision.payloadDigest !== parsed.manifest.revision.payloadDigest)
    ) {
      throw new Error('相同 Extension/Revision 身份已存在，但内容不同；不会覆盖本地版本。')
    }
    const token = randomUUID()
    this.#pending.set(token, { parsed, expiresAt: Date.now() + IMPORT_TTL_MS })
    const slugOwner = runtime.repository.getExtensionBySlug(parsed.manifest.extension.slug)
    return {
      token,
      extensionId: parsed.manifest.extension.id,
      revisionId: parsed.manifest.revision.id,
      slug: parsed.manifest.extension.slug,
      displayName: parsed.manifest.extension.displayName,
      scope: parsed.manifest.extension.scope,
      idempotent: existingRevision !== undefined,
      slugConflict: slugOwner !== undefined && slugOwner.id !== parsed.manifest.extension.id,
    }
  }

  get(token: string): ParsedExtensionImport | undefined {
    this.#prune()
    return this.#pending.get(token)?.parsed
  }

  /** 社区下载的包在确认导入后记录来源；本地文件导入没有来源。 */
  attachSource(token: string, source: Omit<CommunitySource, 'installedAt'>): void {
    if (this.#pending.has(token)) this.#sources.set(token, source)
  }

  source(token: string): Omit<CommunitySource, 'installedAt'> | undefined {
    return this.#sources.get(token)
  }

  delete(token: string): void {
    this.#pending.delete(token)
    this.#sources.delete(token)
  }

  clear(): void {
    this.#pending.clear()
    this.#sources.clear()
  }

  #prune(now = Date.now()): void {
    for (const [token, pending] of this.#pending) {
      if (pending.expiresAt <= now) {
        this.#pending.delete(token)
        this.#sources.delete(token)
      }
    }
  }
}
