import { useEffect, useState } from 'react'
import { CommandPermissionSchema, type CommandPermission } from '@nekro-nxt/contracts'
import { commandApi, type CommandCatalog } from '../../command-api.js'
import { Button, Chip, PropertyGroup, PropertyList, PropertyRow, Select, Switch } from '../../ui-kit/index.js'
import { useProductStore } from '../../product-runtime.js'
import styles from './commands-section.module.css'

type Members = Awaited<ReturnType<typeof commandApi.members>>['members']

const PERMISSION_LABEL: Record<CommandPermission, string> = {
  public: '普通用户',
  'channel-admin': '频道管理',
  admin: 'NekroNXT 管理员',
}
const rank = (level: CommandPermission | undefined): number =>
  level === 'admin' ? 2 : level === 'channel-admin' ? 1 : 0

export function CommandsSection({ channelId }: { readonly channelId?: string }) {
  const [catalog, setCatalog] = useState<CommandCatalog>()
  const [members, setMembers] = useState<Members>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const extensions = useProductStore((s) => s.extensions)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setCatalog(undefined)
    setError('')
    void Promise.all([
      commandApi.list(channelId, controller.signal),
      channelId ? commandApi.members(channelId) : Promise.resolve({ members: [] }),
    ])
      .then(([list, users]) => {
        if (!controller.signal.aborted) {
          setCatalog(list)
          setMembers(users.members)
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '读取命令失败。')
      })
    return () => controller.abort()
  }, [channelId, generation, extensions])
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
      setGeneration((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label={channelId ? '频道命令设置' : '命令设置'}>
      <PropertyGroup
        title={channelId ? '聊天命令覆盖' : '聊天命令'}
        description={
          channelId ? '启用状态可覆盖全局；权限不能低于命令要求或全局设置。' : '统一管理聊天命令。帮助始终可用。'
        }
      >
        {error ? (
          <p role="alert">
            {error}
            <Button variant="ghost" onClick={() => setGeneration((n) => n + 1)}>
              重试
            </Button>
          </p>
        ) : null}
        {!catalog && !error ? <p role="status">正在读取命令…</p> : null}
        {catalog?.problems.map((problem) => (
          <p role="alert" key={problem}>
            {problem}
          </p>
        ))}
        <PropertyList>
          {!channelId && catalog ? (
            <PropertyRow
              label="无权限时回复提示"
              description={
                catalog.settings.unauthorizedFeedback
                  ? '平台成员执行需要授权的命令时，告诉对方需要管理员授权'
                  : '不回复，只在命令记录里留下原因'
              }
            >
              <Switch
                label="无权限时回复提示"
                checked={catalog.settings.unauthorizedFeedback}
                disabled={busy}
                onCheckedChange={(enabled) => void mutate(() => commandApi.setUnauthorizedFeedback(enabled))}
              />
            </PropertyRow>
          ) : null}
          {catalog?.commands.map((command) => {
            const policy = channelId ? command.channelPolicy : command.globalPolicy
            const minimum = command.definition.minimumPermission
            const globalLevel = channelId ? command.globalPolicy?.permission : undefined
            // The strictest of the command's own requirement and, in a channel, the global setting.
            const floor = rank(globalLevel) > rank(minimum) ? (globalLevel ?? minimum) : minimum
            const globalRestriction = globalLevel !== undefined && rank(globalLevel) > rank(minimum)
            const permissionOverride =
              policy?.permission !== undefined && rank(policy.permission) > rank(floor) ? policy.permission : undefined
            const permissionSource =
              rank(command.permission) === rank(minimum) && minimum !== 'public'
                ? '命令最低要求'
                : globalRestriction && rank(command.permission) === rank(globalLevel)
                  ? '全局设置要求'
                  : policy?.permission !== undefined
                    ? channelId
                      ? '频道设置'
                      : '全局设置'
                    : channelId && command.globalPolicy?.permission !== undefined
                      ? '全局设置'
                      : '命令默认值'
            const save = (next: NonNullable<typeof policy>) =>
              void mutate(() => commandApi.policy(channelId ?? 'global', command.fullName, { ...policy, ...next }))
            return (
              <PropertyRow
                key={command.fullName}
                label={<span className={styles.name}>/{command.fullName}</span>}
                description={`${command.source} · ${command.definition.description}`}
                layout="stacked"
              >
                <div className={styles.controls}>
                  <code className={styles.usage}>{command.usage}</code>
                  {command.definition.consoleReply === 'channel' ? (
                    <p>在控制台里执行时，结果也会发送到外部频道。</p>
                  ) : null}
                  <p>
                    生效权限：{PERMISSION_LABEL[command.permission]}（{permissionSource}）{' '}
                    <Chip>{command.enabled ? '启用' : '停用'}</Chip>
                  </p>
                  {globalRestriction ? (
                    <p>
                      频道不能降低全局权限。
                      {policy?.permission !== undefined && rank(policy.permission) < rank(globalLevel)
                        ? `此前保存的「${PERMISSION_LABEL[policy.permission]}」覆盖不生效。`
                        : ''}
                    </p>
                  ) : null}
                  {channelId ? (
                    <Select
                      aria-label={`${command.fullName} 启用覆盖`}
                      disabled={busy || command.fullName === 'help'}
                      value={policy?.enabled === undefined ? 'inherit' : String(policy.enabled)}
                      onValueChange={(value) => {
                        const enabled = value === 'inherit' ? {} : { enabled: value === 'true' }
                        void mutate(() =>
                          commandApi.policy(channelId, command.fullName, {
                            ...(permissionOverride ? { permission: permissionOverride } : {}),
                            ...enabled,
                          }),
                        )
                      }}
                      options={[
                        { value: 'inherit', label: '跟随全局' },
                        { value: 'true', label: '启用' },
                        { value: 'false', label: '停用' },
                      ]}
                    />
                  ) : (
                    <Switch
                      label={`启用 ${command.fullName}`}
                      checked={command.enabled}
                      disabled={busy || command.fullName === 'help'}
                      onCheckedChange={(enabled) => save({ enabled })}
                    />
                  )}
                  <Select
                    aria-label={`${command.fullName} 权限`}
                    disabled={busy || command.fullName === 'help' || minimum === 'admin'}
                    value={permissionOverride ?? 'inherit'}
                    onValueChange={(value) => {
                      const permission =
                        value === 'inherit' ? {} : { permission: CommandPermissionSchema.parse(value) }
                      void mutate(() =>
                        commandApi.policy(channelId ?? 'global', command.fullName, {
                          ...(policy?.enabled === undefined ? {} : { enabled: policy.enabled }),
                          ...permission,
                        }),
                      )
                    }}
                    options={[
                      { value: 'inherit', label: channelId ? '跟随全局与命令要求' : '跟随命令默认权限' },
                      { value: 'public', label: PERMISSION_LABEL.public, disabled: rank(floor) > rank('public') },
                      {
                        value: 'channel-admin',
                        label: PERMISSION_LABEL['channel-admin'],
                        disabled: rank(floor) > rank('channel-admin'),
                      },
                      { value: 'admin', label: PERMISSION_LABEL.admin },
                    ]}
                  />
                </div>
              </PropertyRow>
            )
          })}
        </PropertyList>
      </PropertyGroup>
      {channelId && catalog?.channel?.kind === 'group' ? (
        <PropertyGroup
          title="群聊中的命令"
          description="群里可能有多个机器人。默认只有 @机器人 后再输入 /命令 才会执行，其他以 / 开头的消息按普通聊天处理。"
        >
          <PropertyList>
            <PropertyRow
              label="允许不带 @ 的命令"
              description={catalog.channel.bareCommands ? '群里直接输入 /命令 也会执行' : '需要先 @机器人'}
            >
              <Switch
                label="允许不带 @ 的命令"
                checked={catalog.channel.bareCommands}
                disabled={busy}
                onCheckedChange={(enabled) => void mutate(() => commandApi.setBareCommands(channelId, enabled))}
              />
            </PropertyRow>
          </PropertyList>
        </PropertyGroup>
      ) : null}
      {channelId ? (
        <PropertyGroup title="命令授权成员" description="只授予当前频道的管理命令权限；平台群管理员不会自动获得授权。NekroNXT 管理员在设置的「管理员」里配置，他们在每个频道都有管理权限。">
          {!members.length ? (
            <p>频道成员目录暂无可授权成员，收到平台消息后可在此选择。</p>
          ) : (
            <PropertyList>
              {members.map((member) => (
                <PropertyRow key={member.identityId} label={member.displayName} description={member.platformUserId}>
                  <Switch
                    label={`授权 ${member.displayName}`}
                    checked={member.authorized}
                    disabled={busy}
                    onCheckedChange={(enabled) =>
                      void mutate(() => commandApi.grant(channelId, member.identityId, enabled))
                    }
                  />
                </PropertyRow>
              ))}
            </PropertyList>
          )}
        </PropertyGroup>
      ) : null}
    </section>
  )
}
