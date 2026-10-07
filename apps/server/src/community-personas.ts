import {
  COMMUNITY_PERSONA_AVATAR_MAX_BYTES,
  COMMUNITY_PERSONA_MAX_LENGTH,
  CommunityMyPersonaSchema,
  CommunityPersonaDetailSchema,
  CommunityPersonaIdSchema,
  CommunityPersonaSummarySchema,
  type HostApiContracts,
  parseJsonValue,
  promptDocumentFromText,
  type AgentId,
  type AgentRevisionId,
  type ChannelId,
  type CommunityMyPersona,
  type CommunityPersonaDetail,
  type CommunityPersonaSummary,
  type HostApiResponse,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { AgentRevisionContent } from '@nekro-nxt/core'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import { z } from 'zod'
import { CommunityError, type CommunityService } from './community.js'

const LINKS_SETTING_KEY = 'community.personaLinks'
/** 读取社区头像时的上限：社区约定 512 KiB，留出余量以免社区调整后立即失效。 */
const AVATAR_DOWNLOAD_MAX_BYTES = 1024 * 1024

interface LinkSettingsRepository {
  getSystemSetting(key: string): SystemSettingRecord | undefined
  putSystemSetting(
    key: string,
    value: JsonValue,
    expectedRevision: number | undefined,
    updatedAt: number,
  ): SystemSettingRecord
}

const StoredLinksSchema = z
  .object({ version: z.literal(1), links: z.record(z.string(), z.record(z.string(), z.string())) })
  .strict()

const RecordSchema = z.record(z.string(), z.unknown())
const asRecord = (value: unknown): Record<string, unknown> => {
  const parsed = RecordSchema.safeParse(value)
  return parsed.success && !Array.isArray(value) ? parsed.data : {}
}
const text = (value: unknown, max: number, fallback = ''): string =>
  typeof value === 'string' ? value.slice(0, max) : fallback
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
const time = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0)
const httpUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/** 识别图片格式；只接受 PNG、JPEG 与 WebP，以文件头为准，不信任社区或页面声明的类型。 */
export const sniffPersonaAvatar = (bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | undefined => {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[8 + index] === byte)) {
    return 'image/webp'
  }
  return undefined
}

/** 社区头像地址里的版本参数；页面只看到本机代理地址，代理时再按 ID 与版本向当前社区读取。 */
const avatarVersion = (raw: unknown): string | null | undefined => {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    const version = new URL(raw, 'http://community.invalid').searchParams.get('v')
    return version && /^[0-9A-Za-z_-]{1,128}$/u.test(version) ? version : null
  } catch {
    return undefined
  }
}

const proxyAvatarUrl = (id: string, raw: unknown): string | null => {
  const version = avatarVersion(raw)
  if (version === undefined) return null
  const base = `/api/community/personas/${encodeURIComponent(id)}/avatar`
  return version === null ? base : `${base}?v=${encodeURIComponent(version)}`
}

/**
 * 社区人设：目录、详情、头像代理、安装计数与发布。与扩展共用同一个社区通道（地址、登录与出错格式）；
 * 社区响应宽松读取，只取 NekroNXT 需要的字段，个别条目格式不对时从列表里略过而不是整页失败。
 */
export class CommunityPersonaService {
  readonly #community: CommunityService
  readonly #repository: LinkSettingsRepository
  readonly #now: () => number

  constructor(community: CommunityService, repository: LinkSettingsRepository, now: () => number = Date.now) {
    this.#community = community
    this.#repository = repository
    this.#now = now
  }

  #pageUrl(id: string): string {
    return new URL(`/personas/${encodeURIComponent(id)}`, this.#community.communityUrl).toString()
  }

  #summaryFields(raw: unknown): Record<string, unknown> {
    const record = asRecord(raw)
    const publisher = asRecord(record['publisher'])
    const id = typeof record['id'] === 'string' ? record['id'] : ''
    const handle = text(publisher['handle'], 80)
    return {
      id,
      name: text(record['name'], 200).trim(),
      summary: text(record['summary'], 1000),
      tags: (Array.isArray(record['tags']) ? record['tags'] : [])
        .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        .map((tag) => tag.trim().slice(0, 40))
        .slice(0, 16),
      avatarUrl: CommunityPersonaIdSchema.safeParse(id).success ? proxyAvatarUrl(id, record['avatarUrl']) : null,
      official: record['official'] === true,
      publisher: {
        handle,
        displayName: text(publisher['displayName'], 200, handle),
        avatarUrl: httpUrl(publisher['avatarUrl']),
      },
      installs: count(record['installs']),
      updatedAt: time(record['updatedAt']),
      pageUrl: id ? this.#pageUrl(id) : '',
    }
  }

  #mine(raw: unknown): CommunityMyPersona {
    const record = asRecord(raw)
    const latest = asRecord(record['latestRevision'])
    const reviewStatus = latest['reviewStatus']
    return CommunityMyPersonaSchema.parse({
      ...this.#summaryFields(raw),
      status: record['status'] === 'delisted' ? 'delisted' : 'listed',
      latestRevision: {
        id: latest['id'],
        createdAt: time(latest['createdAt']),
        reviewStatus:
          reviewStatus === 'approved' || reviewStatus === 'flagged' || reviewStatus === 'rejected'
            ? reviewStatus
            : 'pending',
        reviewSummary: typeof latest['reviewSummary'] === 'string' ? latest['reviewSummary'].slice(0, 2000) : null,
      },
    })
  }

  async list(input: {
    readonly query?: string | undefined
    readonly tag?: string | undefined
    readonly official?: '1' | undefined
    readonly cursor?: string | undefined
  }): Promise<{ readonly items: CommunityPersonaSummary[]; readonly nextCursor: string | null }> {
    const search = new URLSearchParams({ limit: '30' })
    if (input.query) search.set('q', input.query)
    if (input.tag) search.set('tag', input.tag)
    if (input.official) search.set('official', input.official)
    if (input.cursor) search.set('cursor', input.cursor)
    const body = asRecord(await this.#community.apiJson(`/api/v1/personas?${search.toString()}`))
    const items = (Array.isArray(body['items']) ? body['items'] : []).flatMap((item) => {
      const parsed = CommunityPersonaSummarySchema.safeParse(this.#summaryFields(item))
      return parsed.success ? [parsed.data] : []
    })
    return { items, nextCursor: typeof body['nextCursor'] === 'string' ? body['nextCursor'] : null }
  }

  async get(personaId: string): Promise<CommunityPersonaDetail> {
    const raw = await this.#community.apiJson(`/api/v1/personas/${encodeURIComponent(personaId)}`)
    const record = asRecord(raw)
    const revision = asRecord(record['revision'])
    const review = asRecord(record['review'])
    const persona = typeof record['persona'] === 'string' ? record['persona'] : ''
    if (persona.length > COMMUNITY_PERSONA_MAX_LENGTH) {
      throw new CommunityError(502, '这个人设的正文超过 64 KiB，无法使用。')
    }
    const parsed = CommunityPersonaDetailSchema.safeParse({
      ...this.#summaryFields(raw),
      description: text(record['description'], 20_000),
      persona,
      revision: { id: revision['id'], notes: text(revision['notes'], 2000), createdAt: time(revision['createdAt']) },
      review:
        review['status'] === 'approved' || review['status'] === 'flagged'
          ? {
              status: review['status'],
              summary: typeof review['summary'] === 'string' ? review['summary'].slice(0, 2000) : null,
            }
          : null,
    })
    if (!parsed.success) throw new CommunityError(502, '社区返回的人设信息不完整。')
    return parsed.data
  }

  /** 按 ID 与版本从当前社区读取头像，只接受 PNG、JPEG 与 WebP。 */
  async avatar(
    personaId: string,
    version: string | null,
  ): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
    const id = CommunityPersonaIdSchema.parse(personaId)
    const query = version && /^[0-9A-Za-z_-]{1,128}$/u.test(version) ? `?v=${encodeURIComponent(version)}` : ''
    const { bytes } = await this.#community.download(
      `/api/v1/personas/${encodeURIComponent(id)}/avatar${query}`,
      AVATAR_DOWNLOAD_MAX_BYTES,
    )
    const mediaType = sniffPersonaAvatar(bytes)
    if (!mediaType) throw new CommunityError(502, '社区返回的头像不是受支持的图片。')
    return { bytes, mediaType }
  }

  /** 安装成功后尽力计数一次；失败不影响安装。 */
  async recordInstall(personaId: string): Promise<void> {
    try {
      await this.#community.apiJson(`/api/v1/personas/${encodeURIComponent(personaId)}/installs`, { method: 'POST' })
    } catch {
      // 计数是尽力而为。
    }
  }

  #links(): { readonly links: Record<string, Record<string, string>>; readonly revision: number | undefined } {
    const record = this.#repository.getSystemSetting(LINKS_SETTING_KEY)
    const parsed = StoredLinksSchema.safeParse(record?.value)
    return { links: parsed.success ? parsed.data.links : {}, revision: record?.revision }
  }

  /** 本机智能体在当前社区最近一次发布的人设。 */
  agentLinks(): Record<string, string> {
    return { ...this.#links().links[this.#community.communityUrl] }
  }

  #link(agentId: AgentId, personaId: string): void {
    const { links, revision } = this.#links()
    const url = this.#community.communityUrl
    this.#repository.putSystemSetting(
      LINKS_SETTING_KEY,
      parseJsonValue({ version: 1, links: { ...links, [url]: { ...links[url], [agentId]: personaId } } }),
      revision,
      this.#now(),
    )
  }

  async mine(): Promise<HostApiResponse<'listCommunityMyPersonas'>> {
    const body = asRecord(await this.#community.apiJson('/api/v1/me/personas', {}, true))
    const items = (Array.isArray(body['items']) ? body['items'] : []).flatMap((item) => {
      try {
        return [this.#mine(item)]
      } catch {
        return []
      }
    })
    const known = new Set(items.map((item) => item.id))
    const agentLinks = Object.fromEntries(
      Object.entries(this.agentLinks()).filter(([, personaId]) => known.has(personaId)),
    )
    return { items, agentLinks }
  }

  async publish(
    input: ReturnType<typeof HostApiContracts.publishCommunityPersona.parseRequest>,
  ): Promise<CommunityMyPersona> {
    const form = new FormData()
    form.set('name', input.name.trim())
    form.set('summary', input.summary.trim())
    form.set('description', input.description)
    form.set('tags', JSON.stringify(input.tags.map((tag) => tag.trim())))
    form.set('persona', input.persona)
    if (input.personaId) form.set('personaId', input.personaId)
    if (input.notes) form.set('notes', input.notes)
    if (input.avatar) {
      const bytes = Buffer.from(input.avatar.base64, 'base64')
      if (bytes.byteLength === 0 || bytes.byteLength > COMMUNITY_PERSONA_AVATAR_MAX_BYTES) {
        throw new CommunityError(400, '头像需要小于 512 KiB。', 'community-persona-avatar-invalid')
      }
      if (sniffPersonaAvatar(bytes) !== input.avatar.mediaType) {
        throw new CommunityError(400, '头像只支持 PNG、JPEG 或 WebP 图片。', 'community-persona-avatar-invalid')
      }
      const extension = input.avatar.mediaType.slice('image/'.length)
      form.set('avatar', new Blob([Uint8Array.from(bytes)], { type: input.avatar.mediaType }), `avatar.${extension}`)
    }
    const published = this.#mine(
      await this.#community.apiJson('/api/v1/personas', { method: 'POST', body: form }, true),
    )
    this.#link(input.agentId, published.id)
    return published
  }
}

type InstallRequest = ReturnType<typeof HostApiContracts.installCommunityPersona.parseRequest>

/** 安装需要的本机能力；路由里接到运行时，测试里用虚构实现。 */
export interface PersonaInstallTarget {
  defaultCapabilities(): Promise<NonNullable<AgentRevisionContent['capabilities']>>
  createAgent(content: AgentRevisionContent): Promise<{ readonly agentId: AgentId; readonly channelId: ChannelId }>
  currentRevision(agentId: AgentId): (AgentRevisionContent & { readonly id: AgentRevisionId }) | undefined
  reviseAgent(
    agentId: AgentId,
    expectedCurrentRevisionId: AgentRevisionId,
    content: AgentRevisionContent,
  ): AgentRevisionId
  uploadAvatar(agentId: AgentId, bytes: Uint8Array): Promise<unknown>
}

/**
 * 把社区人设装进本机。设定正文同时写入纯文本与等价的结构化文档；替换时只换设定与可选的名称，模型、能力与
 * 图片策略保持不变，旧配置留在版本历史里。头像在智能体保存之后再设置，失败只在结果里说明。
 */
export const installCommunityPersona = async (
  personas: CommunityPersonaService,
  target: PersonaInstallTarget,
  personaId: string,
  input: InstallRequest,
): Promise<HostApiResponse<'installCommunityPersona'>> => {
  const detail = await personas.get(personaId)
  if (detail.revision.id !== input.expectedRevisionId) {
    throw new CommunityError(409, '作者刚刚更新了这个人设，请重新查看后再安装。', 'community-persona-changed')
  }
  const persona = detail.persona
  const personaDocument = promptDocumentFromText(persona)
  let agentId: AgentId
  let channelId: ChannelId | null = null
  let currentRevisionId: AgentRevisionId
  if (input.target === 'new') {
    const created = await target.createAgent({
      displayName: input.displayName.trim(),
      persona,
      personaDocument,
      model: {
        provider: input.model.provider,
        model: input.model.model,
        ...(input.model.reasoningEffort === undefined ? {} : { reasoningEffort: input.model.reasoningEffort }),
      },
      capabilities: await target.defaultCapabilities(),
    })
    agentId = created.agentId
    channelId = created.channelId
    const revision = target.currentRevision(agentId)
    if (!revision) throw new CommunityError(500, '智能体创建后没有找到它的配置。')
    currentRevisionId = revision.id
  } else {
    const current = target.currentRevision(input.agentId)
    if (!current) throw new CommunityError(404, '智能体不存在或已被删除。', 'not-found')
    if (current.id !== input.expectedCurrentRevisionId) {
      throw new CommunityError(409, '智能体配置已在其他位置更新，请刷新后重试。', 'revision-conflict')
    }
    agentId = input.agentId
    const { id: currentId, ...content } = current
    currentRevisionId = target.reviseAgent(agentId, currentId, {
      ...content,
      displayName: input.displayName?.trim() || current.displayName,
      persona,
      personaDocument,
    })
  }
  let avatar: 'applied' | 'none' | 'failed' = 'none'
  if (input.useAvatar && detail.avatarUrl) {
    try {
      const version = new URL(detail.avatarUrl, 'http://host.invalid').searchParams.get('v')
      await target.uploadAvatar(agentId, (await personas.avatar(personaId, version)).bytes)
      avatar = 'applied'
    } catch {
      avatar = 'failed'
    }
  }
  void personas.recordInstall(personaId)
  return { agentId, channelId, currentRevisionId, avatar }
}
