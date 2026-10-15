import {
  ChannelIdSchema,
  commandUsage,
  type AgentId,
  type ChannelId,
  type CommandCatalogEntry,
  type CommandExecutionIdentity,
  type CommandPolicy,
  type PlatformIdentityId,
} from '@nekro-nxt/contracts'
import type { SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { BUILTIN_COMMANDS } from './builtins.js'
import { SilentCommandError, type RegisteredCommand } from './types.js'

export interface CommandDirectoryOptions {
  readonly repository: SqliteCoreRepository
  readonly extensions: (agentId: AgentId) => readonly RegisteredCommand[]
}

const WEB_ADMIN: CommandExecutionIdentity = { source: 'web', displayName: 'Web 管理员' }

/** Which commands exist for a channel, who may run them, and the policies and grants that decide it. */
export class CommandDirectory {
  readonly #o: CommandDirectoryOptions
  constructor(options: CommandDirectoryOptions) {
    this.#o = options
  }

  /** Built-ins plus the commands of the agent bound to the channel (or of every agent without a channel). */
  registered(channelId?: ChannelId): readonly RegisteredCommand[] {
    const ids =
      channelId === undefined
        ? this.#o.repository.listAgents().map((agent) => agent.definition.id)
        : [this.#o.repository.getBinding(channelId)?.agentId].filter((id): id is AgentId => id !== undefined)
    const extensions = new Map<string, RegisteredCommand>()
    for (const id of ids) for (const command of this.#o.extensions(id)) extensions.set(command.fullName, command)
    return [...BUILTIN_COMMANDS, ...extensions.values()]
  }

  /** Built-in names win; a short extension name is usable while it is unique, otherwise candidates are listed. */
  resolve(name: string, channelId: ChannelId): RegisteredCommand {
    const all = this.registered(channelId)
    const builtin = all.find(
      (command) =>
        command.extensionRevisionId === undefined &&
        (command.definition.name === name || command.definition.aliases.includes(name)),
    )
    if (builtin) return builtin
    const matches = all.filter(
      (command) =>
        command.fullName === name ||
        command.definition.name === name ||
        command.definition.aliases.includes(name) ||
        command.definition.aliases.some(
          (alias) => command.fullName.slice(0, command.fullName.lastIndexOf(':') + 1) + alias === name,
        ),
    )
    if (matches.length > 1)
      throw new Error(`命令名称冲突，请使用完整名称：${matches.map((command) => '/' + command.fullName).join('、')}`)
    if (!matches[0]) throw new SilentCommandError(`未知命令：/${name}。输入 /help 查看可用命令。`)
    return matches[0]
  }

  authorized(channelId: ChannelId | undefined, identity: CommandExecutionIdentity): boolean {
    // Web identities are created only by the trusted management Host routes, never from inbound facts or JSON.
    if (identity.source === 'web') return true
    if (channelId === undefined || identity.connectionId === undefined || identity.platformUserId === undefined)
      return false
    const channel = this.#o.repository.getChannel(channelId)
    return (
      channel?.connectionId === identity.connectionId &&
      this.#o.repository.commands.hasGrant(channelId, identity.connectionId, identity.platformUserId)
    )
  }

  /** The effective view for one caller: enablement, permission and whether they can run it right now. */
  entries(channelId?: ChannelId, identity: CommandExecutionIdentity = WEB_ADMIN): readonly CommandCatalogEntry[] {
    const store = this.#o.repository.commands
    return this.registered(channelId).map((command) => {
      const globalPolicy = store.policy('global', command.fullName)
      const channelPolicy = channelId === undefined ? undefined : store.policy(channelId, command.fullName)
      const permission =
        command.definition.minimumPermission === 'channel-admin' ||
        globalPolicy?.permission === 'channel-admin' ||
        channelPolicy?.permission === 'channel-admin'
          ? 'channel-admin'
          : 'public'
      const enabled =
        command.fullName === 'help' ||
        (channelPolicy?.enabled ?? globalPolicy?.enabled ?? command.definition.enabledByDefault)
      const bound = channelId !== undefined && this.#o.repository.getBinding(channelId) !== undefined
      return {
        definition: command.definition,
        fullName: command.fullName,
        source: command.source,
        ...(command.extensionRevisionId === undefined ? {} : { extensionRevisionId: command.extensionRevisionId }),
        ...(command.unavailableReason === undefined ? {} : { unavailableReason: command.unavailableReason }),
        enabled,
        permission,
        available:
          enabled &&
          command.unavailableReason === undefined &&
          (permission === 'public' || this.authorized(channelId, identity)) &&
          (bound || ['help', 'status'].includes(command.fullName)),
        usage: commandUsage(command.definition, command.fullName),
        ...(globalPolicy === undefined ? {} : { globalPolicy }),
        ...(channelPolicy === undefined ? {} : { channelPolicy }),
      }
    })
  }

  setPolicy(scope: string, name: string, policy: CommandPolicy): void {
    const channelId = scope === 'global' ? undefined : ChannelIdSchema.parse(scope)
    if (channelId !== undefined) this.#channel(channelId)
    const command = this.registered(channelId).find((entry) => entry.fullName === name)
    if (!command) throw new Error('命令未注册，请检查扩展加载状态。')
    if (name === 'help' && (policy.enabled === false || policy.permission === 'channel-admin'))
      throw new Error('帮助命令必须始终对普通用户可用。')
    if (command.definition.minimumPermission === 'channel-admin' && policy.permission === 'public')
      throw new Error('不能降低命令声明的最低权限。')
    if (
      scope !== 'global' &&
      policy.permission === 'public' &&
      this.#o.repository.commands.policy('global', name)?.permission === 'channel-admin'
    )
      throw new Error('此命令的全局权限为频道管理，频道不能改为普通用户。')
    this.#o.repository.commands.setPolicy(scope, name, policy)
  }

  grant(channelId: ChannelId, identityId: PlatformIdentityId, enabled: boolean): void {
    const channel = this.#channel(channelId)
    const identity = this.#o.repository.getPlatformIdentity(identityId)
    const member = this.#o.repository.getChannelMemberByIdentity(channelId, identityId)
    if (!identity || identity.connectionId !== channel.connectionId || !member)
      throw new Error('只能授权此连接、此频道中已存在的成员。')
    if (enabled) this.#o.repository.commands.grant(channelId, channel.connectionId, identity.platformUserId)
    else this.#o.repository.commands.revoke(channelId, channel.connectionId, identity.platformUserId)
  }

  members(channelId: ChannelId) {
    const channel = this.#channel(channelId)
    return this.#o.repository
      .listPlatformUsers()
      .filter(
        (user) =>
          user.connection.id === channel.connectionId && user.activeChannels.some((active) => active.id === channelId),
      )
      .flatMap((user) => {
        const identity = this.#o.repository.getPlatformIdentity(user.identityId)
        return identity === undefined
          ? []
          : [
              {
                identityId: identity.id,
                displayName: identity.displayName ?? identity.platformUserId,
                platformUserId: identity.platformUserId,
                authorized: this.#o.repository.commands.hasGrant(
                  channelId,
                  channel.connectionId,
                  identity.platformUserId,
                ),
              },
            ]
      })
  }

  #channel(id: ChannelId) {
    const channel = this.#o.repository.getChannel(id)
    if (!channel) throw new Error('频道不存在。')
    return channel
  }
}
