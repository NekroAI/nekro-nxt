import { randomUUID } from 'node:crypto'
import type { InstanceDescriptor } from '@nekro-nxt/contracts'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { InstanceOperationError } from './instance-operation-error.js'
import { SerialTaskQueue } from './serial-task-queue.js'

export type InstanceKind = 'local' | 'remote'
export type InstanceStatus =
  'connecting' | 'ready' | 'unstable' | 'offline' | 'authentication-required' | 'incompatible'

export interface InstanceProfile {
  readonly id: string
  readonly kind: InstanceKind
  readonly displayName: string
  readonly origin: string
  readonly transport?: InstanceDescriptor['transport']
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

export const normalizeRemoteOrigin = (input: string): string => {
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new InstanceOperationError('invalid-address', '请输入服务器地址。')
  const address = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/iu.exec(address)?.[1]
  const hostPort = authority?.slice((authority.lastIndexOf('@') ?? -1) + 1)
  if (authority === undefined || hostPort === undefined || hostPort.endsWith(':')) {
    throw new InstanceOperationError('invalid-address', '服务器地址格式无效，请输入主机名或 IP 与端口。')
  }
  const explicitlyPorted = /^\[[^\]]+\]:\d+$/u.test(hostPort) || /:\d+$/u.test(hostPort)
  let parsed: URL
  try {
    parsed = new URL(address)
  } catch {
    throw new InstanceOperationError('invalid-address', '服务器地址格式无效，请输入主机名或 IP 与端口。')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new InstanceOperationError('unsupported-protocol', '服务器地址只支持 HTTPS 或 HTTP。')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new InstanceOperationError('invalid-address', '服务器地址不能包含账号、密码、查询参数或片段。')
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new InstanceOperationError('invalid-address', '服务器地址不能包含路径。')
  }
  if (!explicitlyPorted && !parsed.port) parsed.port = '4960'
  return parsed.origin
}

export const isLoopbackOrigin = (origin: string): boolean => {
  const parsed = new URL(origin)
  return (
    parsed.hostname === 'localhost' || parsed.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname)
  )
}

export const remoteTransportForOrigin = (origin: string): InstanceDescriptor['transport'] => {
  const parsed = new URL(origin)
  if (parsed.protocol === 'https:') return 'auto-tls-pinned-v1'
  return isLoopbackOrigin(origin) ? 'loopback-http' : 'explicit-http-v1'
}

export const requiresInsecureHttpConfirmation = (origin: string): boolean =>
  new URL(origin).protocol === 'http:' && !isLoopbackOrigin(origin)

export const assertInsecureHttpConfirmed = (origin: string, confirmedOrigin: unknown): void => {
  if (requiresInsecureHttpConfirmation(origin) && confirmedOrigin !== origin) {
    throw new InstanceOperationError('insecure-http-confirmation-required', '请先确认未加密 HTTP 连接风险。')
  }
}

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
  if (value['kind'] === 'remote' && typeof value['observedInstanceId'] !== 'string') {
    throw new Error('远程实例身份字段无效。')
  }
  const origin = value['kind'] === 'remote' ? normalizeRemoteOrigin(value['origin']) : new URL(value['origin']).origin
  const transport =
    value['kind'] === 'remote' &&
    (value['transport'] === 'loopback-http' ||
      value['transport'] === 'auto-tls-pinned-v1' ||
      value['transport'] === 'explicit-http-v1')
      ? value['transport']
      : value['kind'] === 'remote'
        ? remoteTransportForOrigin(origin)
        : undefined
  if (value['kind'] === 'remote' && transport !== remoteTransportForOrigin(origin)) {
    throw new Error('远程实例 transport 与地址不匹配。')
  }
  if (
    value['kind'] === 'remote' &&
    new URL(origin).protocol === 'https:' &&
    typeof value['pinnedSpkiSha256'] !== 'string'
  ) {
    throw new Error('远程实例 TLS 身份字段无效。')
  }
  if (!ALLOWED_ROUTE.test(value['lastRoute'])) throw new Error('实例最近路由无效。')
  return {
    id: value['id'],
    kind: value['kind'],
    displayName: value['displayName'],
    origin,
    ...(transport === undefined ? {} : { transport }),
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
  if (new Set(profiles.map(({ origin }) => origin)).size !== profiles.length) throw new Error('实例 Profile 地址重复。')
  const remoteInstanceIds = profiles.flatMap(({ observedInstanceId }) =>
    observedInstanceId === undefined ? [] : [observedInstanceId],
  )
  if (new Set(remoteInstanceIds).size !== remoteInstanceIds.length) throw new Error('远程实例身份重复。')
  if (!profiles.some(({ id }) => id === value['selectedProfileId'])) throw new Error('当前实例不存在。')
  return {
    format: 'nxt.desktop-instance-profiles',
    version: 1,
    selectedProfileId: value['selectedProfileId'],
    profiles,
  }
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
  readonly #mutations = new SerialTaskQueue()
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

  assertRemoteConnectionAvailable(input: { readonly origin: string; readonly observedInstanceId?: string }): string {
    const origin = normalizeRemoteOrigin(input.origin)
    if (
      this.#envelope.profiles.some(
        (profile) =>
          profile.origin === origin ||
          (input.observedInstanceId !== undefined && profile.observedInstanceId === input.observedInstanceId),
      )
    ) {
      throw new InstanceOperationError('duplicate-instance', '该服务实例已经添加。')
    }
    return origin
  }

  async addRemote(input: {
    readonly displayName: string
    readonly origin: string
    readonly observedInstanceId: string
    readonly transport?: InstanceDescriptor['transport']
    readonly pinnedSpkiSha256?: string
    readonly credentialRef?: string
    readonly now?: number
  }): Promise<InstanceProfile> {
    return this.#mutations.run(async () => {
      const origin = this.assertRemoteConnectionAvailable({
        origin: input.origin,
        observedInstanceId: input.observedInstanceId,
      })
      const transport = input.transport ?? remoteTransportForOrigin(origin)
      if (transport !== remoteTransportForOrigin(origin)) {
        throw new Error('远程实例 transport 与地址不匹配。')
      }
      const now = input.now ?? Date.now()
      const id = randomUUID()
      const profile: InstanceProfile = {
        id,
        kind: 'remote',
        displayName: input.displayName.trim() || new URL(origin).host,
        origin,
        transport,
        observedInstanceId: input.observedInstanceId,
        ...(input.pinnedSpkiSha256 === undefined ? {} : { pinnedSpkiSha256: input.pinnedSpkiSha256 }),
        ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
        partition: `persist:nxt-instance-${id}`,
        notificationsEnabled: true,
        lastRoute: DEFAULT_ROUTE,
        addedAt: now,
        lastSelectedAt: now,
      }
      const previous = this.#envelope
      this.#envelope = { ...previous, selectedProfileId: id, profiles: [...previous.profiles, profile] }
      try {
        await this.#save()
      } catch (error) {
        this.#envelope = previous
        throw error
      }
      return profile
    })
  }

  async update(
    id: string,
    patch: Partial<Pick<InstanceProfile, 'displayName' | 'notificationsEnabled' | 'lastRoute' | 'lastSelectedAt'>>,
  ): Promise<InstanceProfile> {
    return this.#mutations.run(async () => {
      const current = this.get(id)
      if (current === undefined) throw new Error('服务实例不存在。')
      const next: InstanceProfile = {
        ...current,
        ...patch,
        ...(patch.lastRoute === undefined
          ? {}
          : { lastRoute: ALLOWED_ROUTE.test(patch.lastRoute) ? patch.lastRoute : DEFAULT_ROUTE }),
      }
      const previous = this.#envelope
      this.#envelope = {
        ...previous,
        profiles: previous.profiles.map((profile) => (profile.id === id ? next : profile)),
      }
      try {
        await this.#save()
      } catch (error) {
        this.#envelope = previous
        throw error
      }
      return next
    })
  }

  async updateRemoteSecurity(
    id: string,
    security: {
      readonly pinnedSpkiSha256?: string
      readonly credentialRef?: string
    },
  ): Promise<InstanceProfile> {
    return this.#mutations.run(async () => {
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
        ...(current.observedInstanceId === undefined ? {} : { observedInstanceId: current.observedInstanceId }),
        ...(current.transport === undefined ? {} : { transport: current.transport }),
        ...(security.pinnedSpkiSha256 === undefined ? {} : { pinnedSpkiSha256: security.pinnedSpkiSha256 }),
        ...(security.credentialRef === undefined ? {} : { credentialRef: security.credentialRef }),
      }
      const previous = this.#envelope
      this.#envelope = {
        ...previous,
        profiles: previous.profiles.map((profile) => (profile.id === id ? next : profile)),
      }
      try {
        await this.#save()
      } catch (error) {
        this.#envelope = previous
        throw error
      }
      return next
    })
  }

  async select(id: string, now = Date.now()): Promise<InstanceProfile> {
    return this.#mutations.run(async () => {
      const profile = this.get(id)
      if (profile === undefined) throw new Error('服务实例不存在。')
      const previous = this.#envelope
      this.#envelope = {
        ...previous,
        selectedProfileId: id,
        profiles: previous.profiles.map((item) => (item.id === id ? { ...item, lastSelectedAt: now } : item)),
      }
      try {
        await this.#save()
      } catch (error) {
        this.#envelope = previous
        throw error
      }
      const selected = this.get(id)
      if (selected === undefined) throw new Error('服务实例不存在。')
      return selected
    })
  }

  async remove(id: string): Promise<InstanceProfile> {
    return this.#mutations.run(async () => {
      if (id === LOCAL_PROFILE_ID) throw new Error('本地实例不能移除。')
      const profile = this.get(id)
      if (profile === undefined) throw new Error('服务实例不存在。')
      const previous = this.#envelope
      this.#envelope = {
        ...previous,
        selectedProfileId: previous.selectedProfileId === id ? LOCAL_PROFILE_ID : previous.selectedProfileId,
        profiles: previous.profiles.filter((item) => item.id !== id),
      }
      try {
        await this.#save()
      } catch (error) {
        this.#envelope = previous
        throw error
      }
      return profile
    })
  }

  async #save(): Promise<void> {
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.#envelope, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, this.#filePath)
  }
}
