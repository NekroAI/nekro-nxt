import { useEffect, useState } from 'react'
import { commandApi, type CommandCatalog } from '../../command-api.js'
import { Button, Chip, PropertyGroup, PropertyList, PropertyRow, Select, Switch } from '../../ui-kit/index.js'
import { useProductStore } from '../../product-runtime.js'

type Members = Awaited<ReturnType<typeof commandApi.members>>['members']
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
        title={channelId ? '命令覆盖' : '命令'}
        description={
          channelId ? '频道设置优先于全局；管理权限不能低于命令的最低要求。' : '统一管理聊天命令。帮助始终可用。'
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
          {catalog?.commands.map((command) => {
            const policy = channelId ? command.channelPolicy : command.globalPolicy
            const save = (next: NonNullable<typeof policy>) =>
              void mutate(() => commandApi.policy(channelId ?? 'global', command.fullName, { ...policy, ...next }))
            return (
              <PropertyRow
                key={command.fullName}
                label={`/${command.fullName}`}
                description={`${command.source} · ${command.definition.description}`}
              >
                <div>
                  <code>{command.usage}</code>
                  <p>
                    默认权限：{command.definition.minimumPermission === 'public' ? '普通用户' : '频道管理'}{' '}
                    <Chip>{command.enabled ? '启用' : '停用'}</Chip>
                  </p>
                  {channelId ? (
                    <Select
                      aria-label={`${command.fullName} 启用覆盖`}
                      disabled={busy || command.fullName === 'help'}
                      value={policy?.enabled === undefined ? 'inherit' : String(policy.enabled)}
                      onValueChange={(value) => {
                        const enabled = value === 'inherit' ? {} : { enabled: value === 'true' }
                        void mutate(() =>
                          commandApi.policy(channelId, command.fullName, {
                            ...(policy?.permission ? { permission: policy.permission } : {}),
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
                    disabled={
                      busy || command.fullName === 'help' || command.definition.minimumPermission === 'channel-admin'
                    }
                    value={policy?.permission ?? 'inherit'}
                    onValueChange={(value) => {
                      const permission =
                        value === 'inherit'
                          ? {}
                          : { permission: value === 'channel-admin' ? ('channel-admin' as const) : ('public' as const) }
                      void mutate(() =>
                        commandApi.policy(channelId ?? 'global', command.fullName, {
                          ...(policy?.enabled === undefined ? {} : { enabled: policy.enabled }),
                          ...permission,
                        }),
                      )
                    }}
                    options={[
                      { value: 'inherit', label: '跟随默认权限' },
                      { value: 'public', label: '普通用户' },
                      { value: 'channel-admin', label: '频道管理' },
                    ]}
                  />
                </div>
              </PropertyRow>
            )
          })}
        </PropertyList>
      </PropertyGroup>
      {channelId ? (
        <PropertyGroup title="命令授权成员" description="只授予当前频道的管理命令权限；平台群管理员不会自动获得授权。">
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
