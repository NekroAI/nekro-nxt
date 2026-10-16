import { useEffect, useState } from 'react'
import { CommandPermissionSchema, type CommandPermission } from '@nekro-nxt/contracts'
import { commandApi, type CommandCatalog } from '../../command-api.js'
import { Plus } from 'lucide-react'
import {
  Banner,
  Button,
  DataTable,
  Dialog,
  MemberAvatar,
  SearchField,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Select,
  Skeleton,
  Switch,
  type Column,
} from '../../ui-kit/index.js'
import { useProductStore } from '../../product-runtime.js'
import styles from './commands-section.module.css'
import settingsStyles from './settings.module.css'

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
  const [showAll, setShowAll] = useState(false)
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
  type Command = NonNullable<typeof catalog>['commands'][number]
  // Everything a row needs about one command's effective permission, for the console or for this channel.
  const describe = (command: Command) => {
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
    return { policy, minimum, globalLevel, floor, globalRestriction, permissionOverride, permissionSource }
  }
  const columns: readonly Column<Command>[] = [
    {
      key: 'command',
      header: '命令',
      width: 'minmax(220px, 2fr)',
      render: (command) => {
        const { policy, globalLevel, globalRestriction } = describe(command)
        return (
          <span className={styles.command}>
            <span className={styles.name}>/{command.fullName}</span>
            <span className={styles.note}>
              {command.source} · {command.definition.description}
            </span>
            <code className={styles.usage}>{command.usage}</code>
            {command.definition.consoleReply === 'channel' ? (
              <span className={styles.note}>在控制台里执行时，结果也会发送到外部频道。</span>
            ) : null}
            {globalRestriction && policy?.permission !== undefined && rank(policy.permission) < rank(globalLevel) ? (
              <span className={styles.note}>
                频道不能降低全局权限，此前保存的「{PERMISSION_LABEL[policy.permission]}」不生效。
              </span>
            ) : null}
          </span>
        )
      },
    },
    {
      key: 'permission',
      header: '生效权限',
      width: 'minmax(180px, 1fr)',
      render: (command) => {
        const { policy, minimum, floor, permissionOverride, permissionSource } = describe(command)
        return (
          <span className={styles.command}>
            <Select
              aria-label={`${command.fullName} 权限`}
              disabled={busy || command.fullName === 'help' || minimum === 'admin'}
              value={permissionOverride ?? 'inherit'}
              onValueChange={(value) => {
                const permission = value === 'inherit' ? {} : { permission: CommandPermissionSchema.parse(value) }
                void mutate(() =>
                  commandApi.policy(channelId ?? 'global', command.fullName, {
                    ...(policy?.enabled === undefined ? {} : { enabled: policy.enabled }),
                    ...permission,
                  }),
                )
              }}
              options={[
                {
                  value: 'inherit',
                  label: `${PERMISSION_LABEL[command.permission]}（${permissionSource}）`,
                },
                { value: 'public', label: PERMISSION_LABEL.public, disabled: rank(floor) > rank('public') },
                {
                  value: 'channel-admin',
                  label: PERMISSION_LABEL['channel-admin'],
                  disabled: rank(floor) > rank('channel-admin'),
                },
                { value: 'admin', label: PERMISSION_LABEL.admin },
              ]}
            />
          </span>
        )
      },
    },
    {
      key: 'enabled',
      header: '启用',
      width: channelId ? '120px' : '88px',
      align: 'end',
      render: (command) => {
        const { policy, permissionOverride } = describe(command)
        if (command.fullName === 'help') return <span className={styles.note}>始终开启</span>
        return channelId ? (
          <Select
            aria-label={`${command.fullName} 启用覆盖`}
            disabled={busy}
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
              { value: 'inherit', label: command.globalPolicy?.enabled === false ? '跟随全局（停用）' : '跟随全局' },
              { value: 'true', label: '启用' },
              { value: 'false', label: '停用' },
            ]}
          />
        ) : (
          <Switch
            label={`启用 ${command.fullName}`}
            checked={command.enabled}
            disabled={busy}
            onCheckedChange={(enabled) =>
              void mutate(() => commandApi.policy('global', command.fullName, { ...policy, enabled }))
            }
          />
        )
      },
    },
  ]
  // In a channel only what differs from the console's settings is listed; the rest is one click away.
  const overridden = catalog?.commands.filter((command) => command.channelPolicy !== undefined) ?? []
  const rows = channelId && !showAll ? overridden : (catalog?.commands ?? [])
  const status = (
    <>
      {error ? (
        <Banner
          tone="bad"
          action={
            <Button size="small" onClick={() => setGeneration((n) => n + 1)}>
              重试
            </Button>
          }
        >
          {error}
        </Banner>
      ) : null}
      {catalog?.problems.map((problem) => (
        <Banner key={problem} tone="warn">
          {problem}
        </Banner>
      ))}
    </>
  )
  const permissionCell = columns.find((column) => column.key === 'permission')!.render
  const enabledCell = columns.find((column) => column.key === 'enabled')!.render
  const commandCell = columns.find((column) => column.key === 'command')!.render
  // The inspector and phones are too narrow for a table: one stacked row per command, its two settings side by side.
  const stackedRows = (
    <PropertyList>
      {rows.length === 0 ? <PropertyRow label={channelId ? '这个频道的命令都跟随全局设置' : '还没有命令'} /> : null}
      {rows.map((command) => (
        <PropertyRow key={command.fullName} label={commandCell(command)} layout="stacked">
          <div className={styles.channelControls}>
            {permissionCell(command)}
            {enabledCell(command)}
          </div>
        </PropertyRow>
      ))}
    </PropertyList>
  )
  const table =
    !catalog && !error ? (
      <Skeleton height={160} />
    ) : catalog ? (
      <DataTable
        label="聊天命令"
        columns={columns}
        rows={rows}
        rowKey={(command) => command.fullName}
        empty={channelId ? '这个频道的命令都跟随全局设置。' : '还没有命令。'}
      />
    ) : null
  return (
    <section className={styles.stack} aria-label={channelId ? '频道命令设置' : '命令设置'}>
      {status}
      {channelId ? (
        <PropertyGroup
          title="聊天命令"
          description="只列出与全局设置不同的命令。权限不能低于命令要求或全局设置。"
          actions={
            <Button size="small" variant="ghost" onClick={() => setShowAll((value) => !value)}>
              {showAll ? '只看不同的' : '显示全部命令'}
            </Button>
          }
        >
          {!catalog && !error ? <Skeleton height={120} /> : catalog ? stackedRows : null}
        </PropertyGroup>
      ) : (
        <>
          {catalog ? (
            <PropertyList>
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
            </PropertyList>
          ) : null}
          {/* Phones get the stacked rows; the table needs the width of a desktop window (05 §6.2). */}
          <div className={styles.wideOnly}>{table}</div>
          <div className={styles.narrowOnly}>{catalog ? stackedRows : null}</div>
        </>
      )}
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
        <CommandMembers
          members={members}
          busy={busy}
          onGrant={(identityId, enabled) => void mutate(() => commandApi.grant(channelId, identityId, enabled))}
        />
      ) : null}
    </section>
  )
}

/** How many matching members the add dialog lists at once; the search narrows the rest. */
const PICK_LIMIT = 30

/**
 * Members with this channel's management commands. Only the authorized ones are listed, each removable; others are
 * found and added from a searchable list, so a large group does not stretch the inspector.
 */
function CommandMembers({
  members,
  busy,
  onGrant,
}: {
  readonly members: Members
  readonly busy: boolean
  readonly onGrant: (identityId: string, enabled: boolean) => void
}) {
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const authorized = members.filter((member) => member.authorized)
  const sameName = (member: Members[number]) =>
    members.filter((other) => other.displayName === member.displayName).length > 1
  const needle = query.trim().toLowerCase()
  const candidates = members
    .filter((member) => !member.authorized)
    .filter((member) => !needle || member.displayName.toLowerCase().includes(needle))
  return (
    <PropertyGroup
      title="命令授权成员"
      description="可以在这个频道使用管理命令的成员。"
      tip="群主和群管理员不会自动获得授权。NekroNXT 管理员在每个频道都有管理权限，在设置的「管理员」里配置。"
      actions={
        members.length > 0 ? (
          <Button size="small" icon={<Plus />} onClick={() => setAdding(true)}>
            添加成员
          </Button>
        ) : undefined
      }
    >
      {members.length === 0 ? (
        <p className={styles.membersEmpty}>收到这个频道的消息后，就能从发过言的成员里选择。</p>
      ) : authorized.length === 0 ? (
        <p className={styles.membersEmpty}>还没有授权成员。</p>
      ) : (
        <PropertyList>
          {authorized.map((member) => (
            <PropertyRow
              key={member.identityId}
              label={member.displayName}
              // The platform id only tells apart members who share a name.
              description={sameName(member) ? member.platformUserId : undefined}
            >
              <Button size="small" variant="ghost" disabled={busy} onClick={() => onGrant(member.identityId, false)}>
                取消授权
              </Button>
            </PropertyRow>
          ))}
        </PropertyList>
      )}
      <Dialog open={adding} onOpenChange={setAdding} title="添加命令授权成员" wide>
        <SearchField value={query} onChange={setQuery} label="查找成员" placeholder="按昵称查找" />
        {candidates.length === 0 ? (
          <Banner tone="info">{needle ? '没有找到这个成员。' : '频道里的成员都已经授权了。'}</Banner>
        ) : (
          <ul className={settingsStyles.pickList}>
            {candidates.slice(0, PICK_LIMIT).map((member) => (
              <li key={member.identityId}>
                <MemberAvatar name={member.displayName} size="sm" />
                <span className={settingsStyles.pickInfo}>
                  <b>{member.displayName}</b>
                  {sameName(member) ? <small>{member.platformUserId}</small> : null}
                </span>
                <Button size="small" disabled={busy} onClick={() => onGrant(member.identityId, true)}>
                  授权
                </Button>
              </li>
            ))}
          </ul>
        )}
        {candidates.length > PICK_LIMIT ? (
          <p className={styles.membersEmpty}>还有 {candidates.length - PICK_LIMIT} 位成员，输入昵称缩小范围。</p>
        ) : null}
      </Dialog>
    </PropertyGroup>
  )
}
