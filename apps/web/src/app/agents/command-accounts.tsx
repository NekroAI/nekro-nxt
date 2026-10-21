import type { CommandAccountUsage } from '@nekro-nxt/contracts'
import { Fragment } from 'react'
import { ACCOUNT_USAGES, accountScopesText, useLinkedAccounts } from '../../linked-accounts/linked-accounts-data.js'
import { useProductStore, type AgentSummary } from '../../product-runtime.js'
import { Button, Chip, PropertyRow, Select, ToggleChip } from '../../ui-kit/index.js'
import { useGo } from '../model/nav.js'
import type { AgentDraft, DraftUpdate } from './agent-draft.js'
import { CodeRunNodeDownload } from './runtime-download.js'
import styles from './agents.module.css'

type Grant = AgentDraft['capabilities']['commandAccounts'][number]

/**
 * The linked accounts one agent's commands act as, one per platform. Granting happens here and nowhere else; 设置 →
 * 关联账号 only keeps the accounts. A usage hint is told to the agent and limits nothing: the token's own permissions
 * are the limit (命令账号授权 A1、A2、A7).
 */
export function CommandAccountRows({
  agent,
  caps,
  update,
}: {
  readonly agent: AgentSummary
  readonly caps: AgentDraft['capabilities']
  readonly update: DraftUpdate
}) {
  const { view } = useLinkedAccounts()
  const cli = useProductStore((state) => state.capabilityAvailability.githubCli)
  const go = useGo()
  if (view === undefined) return null
  const platforms = view.platforms.filter(
    (platform) => platform.accounts.length > 0 || caps.commandAccounts.some((grant) => grant.service === platform.id),
  )

  const setGrants = (change: (grants: readonly Grant[]) => Grant[]) =>
    update((current) => ({
      ...current,
      capabilities: { ...current.capabilities, commandAccounts: change(current.capabilities.commandAccounts) },
    }))
  const choose = (service: Grant['service'], accountId: string) =>
    setGrants((grants) => {
      const others = grants.filter((grant) => grant.service !== service)
      if (accountId === '') return others
      const previous = grants.find((grant) => grant.service === service)
      return [...others, { service, accountId, usage: previous?.accountId === accountId ? previous.usage : [] }]
    })
  const toggleUsage = (service: Grant['service'], usage: CommandAccountUsage) =>
    setGrants((grants) =>
      grants.map((grant) =>
        grant.service !== service
          ? grant
          : {
              ...grant,
              usage: ACCOUNT_USAGES.map((item) => item.value).filter((item) =>
                item === usage ? !grant.usage.includes(usage) : grant.usage.includes(item),
              ),
            },
      ),
    )

  return (
    <>
      <PropertyRow depth={1} label="关联账号" description={platforms.length === 0 ? '还没有关联账号' : undefined}>
        <Button size="small" variant="ghost" onClick={() => go('/settings/accounts')}>
          管理关联账号
        </Button>
      </PropertyRow>
      {platforms.map((platform) => {
        const grant = caps.commandAccounts.find((entry) => entry.service === platform.id)
        const account =
          grant === undefined ? undefined : platform.accounts.find((entry) => entry.id === grant.accountId)
        return (
          <Fragment key={platform.id}>
            <PropertyRow
              depth={2}
              label={platform.name}
              width="sm"
              description={account === undefined ? undefined : `权限范围：${accountScopesText(account, platform.name)}`}
              badge={grant !== undefined && account === undefined ? <Chip tone="warn">账号已移除</Chip> : undefined}
            >
              <Select
                aria-label={`${platform.name} 账号`}
                value={account?.id ?? ''}
                options={[
                  { value: '', label: '不使用' },
                  ...platform.accounts.map((entry) => ({ value: entry.id, label: entry.login })),
                ]}
                onValueChange={(accountId) => choose(platform.id, accountId)}
              />
            </PropertyRow>
            {grant !== undefined && account !== undefined ? (
              <PropertyRow
                depth={2}
                label="使用提示"
                description={`告诉${agent.name}这个账号用来做什么，只写进提示词，不限制它能做的事`}
                layout="stacked"
              >
                <div className={styles.usageBar} role="group" aria-label={`${platform.name} 使用提示`}>
                  {ACCOUNT_USAGES.map((item) => (
                    <ToggleChip
                      key={item.value}
                      pressed={grant.usage.includes(item.value)}
                      onPressedChange={() => toggleUsage(platform.id, item.value)}
                    >
                      {item.label}
                    </ToggleChip>
                  ))}
                </div>
              </PropertyRow>
            ) : null}
            {platform.id === 'github' && account !== undefined && cli !== undefined && !cli.available ? (
              <PropertyRow
                depth={2}
                label="GitHub CLI"
                description={
                  cli.download === undefined
                    ? '这台设备没有 gh，命令里只能通过 REST 接口使用这个账号'
                    : '这台设备没有 gh，下载后命令里可以直接使用'
                }
              >
                <CodeRunNodeDownload availability={cli} kind="github-cli" />
              </PropertyRow>
            ) : null}
          </Fragment>
        )
      })}
    </>
  )
}
