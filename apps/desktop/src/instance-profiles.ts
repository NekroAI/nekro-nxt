import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type InstanceKind = 'local' | 'remote'
export type InstanceStatus =
  'connecting' | 'ready' | 'unstable' | 'offline' | 'authentication-required' | 'incompatible'

export interface InstanceProfile {
  readonly id: string
  readonly kind: InstanceKind
  readonly displayName: string
  readonly origin: string
  readonly observedInstanceId?: string
  readonly pinnedSpkiSha256?: string
  readonly credentialRef?: string
  readonly partition: string
  readonly notificationsEnabled: boolean
  readonly lastRoute: string
  readonly addedAt: number
  readonly lastSelectedAt: number
}

interface ProfileEnvelopeV1 {
  readonly format: 'nxt.desktop-instance-profiles'
  readonly version: 1
  readonly selectedProfileId: string
  readonly profiles: readonly InstanceProfile[]
}

const LOCAL_PROFILE_ID = 'local'
const DEFAULT_ROUTE = '/work'
const ALLOWED_ROUTE = /^\/(?:work|connections|users|extensions|settings)(?:\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/u

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const parseProfile = (value: unknown): InstanceProfile => {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    (value['kind'] !== 'local' && value['kind'] !== 'remote') ||
    typeof value['displayName'] !== 'string' ||
    typeof value['origin'] !== 'string' ||
    typeof value['partition'] !== 'string' ||
    typeof value['notificationsEnabled'] !== 'boolean' ||
    typeof value['lastRoute'] !== 'string' ||
    typeof value['addedAt'] !== 'number' ||
    typeof value['lastSelectedAt'] !== 'number'
  ) {
    throw new Error('实例 Profile 字段无效。')
  }
  if (value['kind'] === 'remote' && !value['partition'].startsWith('persist:nxt-instance-')) {
    throw new Error('远程实例 partition 无效。')
  }
  if (!ALLOWED_ROUTE.test(value['lastRoute'])) throw new Error('实例最近路由无效。')
  return {
    id: value['id'],
    kind: value['kind'],
    displayName: value['displayName'],
    origin: new URL(value['origin']).origin,
    ...(typeof value['observedInstanceId'] === 'string' ? { observedInstanceId: value['observedInstanceId'] } : {}),
    ...(typeof value['pinnedSpkiSha256'] === 'string' ? { pinnedSpkiSha256: value['pinnedSpkiSha256'] } : {}),
    ...(typeof value['credentialRef'] === 'string' ? { credentialRef: value['credentialRef'] } : {}),
    partition: value['partition'],
    notificationsEnabled: value['notificationsEnabled'],
    lastRoute: value['lastRoute'],
    addedAt: value['addedAt'],
    lastSelectedAt: value['lastSelectedAt'],
  }
}

const parseEnvelope = (value: unknown): ProfileEnvelopeV1 => {
  if (
    !isRecord(value) ||
    value['format'] !== 'nxt.desktop-instance-profiles' ||
    value['version'] !== 1 ||
    typeof value['selectedProfileId'] !== 'string' ||
    !Array.isArray(value['profiles'])
  ) {
    throw new Error('实例 Profile 文件版本无效。')
  }
  const profiles = value['profiles'].map(parseProfile)
  const local = profiles[0]
  if (local?.id !== LOCAL_PROFILE_ID || local.kind !== 'local') throw new Error('固定本地实例缺失。')
  if (new Set(profiles.map(({ id }) => id)).size !== profiles.length) throw new Error('实例 Profile ID 重复。')
  if (!profiles.some(({ id }) => id === value['selectedProfileId'])) throw new Error('当前实例不存在。')
  return {
    format: 'nxt.desktop-instance-profiles',
    version: 1,
    selectedProfileId: value['selectedProfileId'],
    profiles,
  }
}

export const normalizeRemoteOrigin = (input: string): string => {
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new Error('请输入服务器地址。')
  const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('服务器地址只能包含 IP 或域名与端口。')
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new Error('服务器地址不能包含路径。')
  if (!parsed.port) parsed.port = '4960'
  return parsed.origin
}

const localProfile = (origin: string, now: number): InstanceProfile => ({
  id: LOCAL_PROFILE_ID,
  kind: 'local',
  displayName: '本地实例',
  origin,
  partition: 'persist:nxt-instance-local',
  notificationsEnabled: true,
  lastRoute: DEFAULT_ROUTE,
  addedAt: now,
  lastSelectedAt: now,
})

export class InstanceProfileStore {
  readonly #filePath: string
  #envelope: ProfileEnvelopeV1

  private constructor(filePath: string, envelope: ProfileEnvelopeV1) {
    this.#filePath = filePath
    this.#envelope = envelope
  }

  static async open(filePath: string, localOrigin: string, now = Date.now()): Promise<InstanceProfileStore> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    try {
      const envelope = parseEnvelope(JSON.parse(await readFile(filePath, 'utf8')))
      const profiles = envelope.profiles.map((profile) =>
        profile.id === LOCAL_PROFILE_ID ? { ...profile, origin: localOrigin } : profile,
      )
      return new InstanceProfileStore(filePath, { ...envelope, profiles })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') {
        const recoveryPath = `${filePath}.recovery-${now}`
        await rename(filePath, recoveryPath)
      }
      const envelope: ProfileEnvelopeV1 = {
        format: 'nxt.desktop-instance-profiles',
        version: 1,
        selectedProfileId: LOCAL_PROFILE_ID,
        profiles: [localProfile(localOrigin, now)],
      }
      const store = new InstanceProfileStore(filePath, envelope)
      await store.#save()
      return store
    }
  }

  get selectedProfileId(): string {
    return this.#envelope.selectedProfileId
  }

  list(): readonly InstanceProfile[] {
    return this.#envelope.profiles
  }

  get(id: string): InstanceProfile | undefined {
    return this.#envelope.profiles.find((profile) => profile.id === id)
  }

  async addRemote(input: {
    readonly displayName: string
    readonly origin: string
    readonly observedInstanceId: string
    readonly pinnedSpkiSha256: string
    readonly credentialRef?: string
    readonly now?: number
  }): Promise<InstanceProfile> {
    const origin = normalizeRemoteOrigin(input.origin)
    if (
      this.#envelope.profiles.some(
        (profile) => profile.origin === origin || profile.observedInstanceId === input.observedInstanceId,
      )
    ) {
      throw new Error('该服务实例已经添加。')
    }
    const now = input.now ?? Date.now()
    const id = randomUUID()
    const profile: InstanceProfile = {
      id,
      kind: 'remote',
      displayName: input.displayName.trim() || new URL(origin).host,
      origin,
      observedInstanceId: input.observedInstanceId,
      pinnedSpkiSha256: input.pinnedSpkiSha256,
      ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
      partition: `persist:nxt-instance-${id}`,
      notificationsEnabled: true,
      lastRoute: DEFAULT_ROUTE,
      addedAt: now,
      lastSelectedAt: now,
    }
    this.#envelope = { ...this.#envelope, selectedProfileId: id, profiles: [...this.#envelope.profiles, profile] }
    await this.#save()
    return profile
  }

  async update(
    id: string,
    patch: Partial<
      Pick<InstanceProfile, 'displayName' | 'origin' | 'notificationsEnabled' | 'lastRoute' | 'lastSelectedAt'>
    >,
  ): Promise<InstanceProfile> {
    const current = this.get(id)
    if (current === undefined) throw new Error('服务实例不存在。')
    const next: InstanceProfile = {
      ...current,
      ...patch,
      ...(patch.origin === undefined
        ? {}
        : { origin: current.kind === 'local' ? current.origin : normalizeRemoteOrigin(patch.origin) }),
      ...(patch.lastRoute === undefined
        ? {}
        : { lastRoute: ALLOWED_ROUTE.test(patch.lastRoute) ? patch.lastRoute : DEFAULT_ROUTE }),
    }
    this.#envelope = {
      ...this.#envelope,
      profiles: this.#envelope.profiles.map((profile) => (profile.id === id ? next : profile)),
    }
    await this.#save()
    return next
  }

  async updateSecurity(
    id: string,
    security: {
      readonly observedInstanceId: string
      readonly pinnedSpkiSha256: string
      readonly credentialRef?: string
    },
  ): Promise<InstanceProfile> {
    const current = this.get(id)
    if (current === undefined || current.kind !== 'remote') throw new Error('远程服务实例不存在。')
    const next: InstanceProfile = {
      id: current.id,
      kind: current.kind,
      displayName: current.displayName,
      origin: current.origin,
      partition: current.partition,
      notificationsEnabled: current.notificationsEnabled,
      lastRoute: current.lastRoute,
      addedAt: current.addedAt,
      lastSelectedAt: current.lastSelectedAt,
      observedInstanceId: security.observedInstanceId,
      pinnedSpkiSha256: security.pinnedSpkiSha256,
      ...(security.credentialRef === undefined ? {} : { credentialRef: security.credentialRef }),
    }
    this.#envelope = {
      ...this.#envelope,
      profiles: this.#envelope.profiles.map((profile) => (profile.id === id ? next : profile)),
    }
    await this.#save()
    return next
  }

  async select(id: string, now = Date.now()): Promise<InstanceProfile> {
    const profile = this.get(id)
    if (profile === undefined) throw new Error('服务实例不存在。')
    this.#envelope = {
      ...this.#envelope,
      selectedProfileId: id,
      profiles: this.#envelope.profiles.map((item) => (item.id === id ? { ...item, lastSelectedAt: now } : item)),
    }
    await this.#save()
    return this.get(id)!
  }

  async remove(id: string): Promise<InstanceProfile> {
    if (id === LOCAL_PROFILE_ID) throw new Error('本地实例不能移除。')
    const profile = this.get(id)
    if (profile === undefined) throw new Error('服务实例不存在。')
    this.#envelope = {
      ...this.#envelope,
      selectedProfileId: this.#envelope.selectedProfileId === id ? LOCAL_PROFILE_ID : this.#envelope.selectedProfileId,
      profiles: this.#envelope.profiles.filter((item) => item.id !== id),
    }
    await this.#save()
    return profile
  }

  async #save(): Promise<void> {
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.#envelope, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, this.#filePath)
  }
}
