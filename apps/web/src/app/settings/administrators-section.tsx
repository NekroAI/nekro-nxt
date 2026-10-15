import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { KeyRound, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { callHostApi } from '../../host-api-client.js'
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  MemberAvatar,
  PropertyGroup,
  SearchField,
  Skeleton,
  toast,
  type Column,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import styles from './settings.module.css'

type Administrator = HostApiResponse<'listAdministrators'>['administrators'][number]
type Candidate = HostApiResponse<'listPlatformUsers'>['items'][number]

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

/**
 * NekroNXT administrators: whoever signs in to this console, plus the platform accounts listed here. They may manage
 * extensions and confirm agents' extension requests from chat (`/ext approve`), and hold every channel's management
 * commands. A group's own owners and admins are not administrators unless they are listed.
 */
export function AdministratorsSection() {
  const [administrators, setAdministrators] = useState<readonly Administrator[]>()
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Administrator>()
  const [claim, setClaim] = useState<{ readonly code: string; readonly expiresAt: number }>()
  const load = () =>
    callHostApi(HostApiContracts.listAdministrators, {}, undefined)
      .then((result) => setAdministrators(result.administrators))
      .catch(failure)
  useEffect(() => {
    void load()
  }, [])

  const createClaim = async () => {
    try {
      setClaim(await callHostApi(HostApiContracts.createAdministratorClaimCode, {}, undefined))
    } catch (error) {
      failure(error)
    }
  }

  const columns: readonly Column<Administrator>[] = [
    {
      key: 'name',
      header: '账号',
      width: 'minmax(160px, 2fr)',
      render: (entry) => (
        <span className={styles.deviceName}>
          <MemberAvatar name={entry.displayName} size="sm" />
          {entry.displayName}
        </span>
      ),
    },
    {
      key: 'connection',
      header: '平台连接',
      width: 'minmax(120px, 1.4fr)',
      priority: 2,
      render: (entry) => <span className={styles.faint}>{entry.connectionName}</span>,
    },
    {
      key: 'added',
      header: '添加方式',
      width: 'minmax(110px, 1fr)',
      priority: 3,
      render: (entry) => (
        <span className={styles.faint}>
          {entry.addedVia === 'claim' ? '认领码' : '控制台添加'} · {relativeTime(entry.addedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '80px',
      align: 'end',
      render: (entry) => (
        <Button size="small" variant="ghost" onClick={() => setRemoving(entry)}>
          移除
        </Button>
      ),
    },
  ]

  return (
    <>
      <PropertyGroup
        title="管理员"
        description="管理员可以在聊天里管理扩展、确认智能体的扩展请求（/ext approve 编号），并且在每个频道都有管理命令权限。登录这个控制台的人始终是管理员；群主、群管理员不会自动成为管理员。"
        actions={
          <>
            <Button size="small" icon={<KeyRound size={14} />} onClick={() => void createClaim()}>
              生成认领码
            </Button>
            <Button size="small" variant="primary" icon={<UserPlus size={14} />} onClick={() => setAdding(true)}>
              添加管理员
            </Button>
          </>
        }
      >
        {administrators === undefined ? (
          <Skeleton height={64} />
        ) : administrators.length === 0 ? (
          <EmptyState title="还没有平台账号管理员">
            从用户列表里添加，或生成认领码，在聊天里发送 /admin claim 认领码 把自己的账号设为管理员。
          </EmptyState>
        ) : (
          <DataTable
            label="管理员"
            columns={columns}
            rows={administrators}
            rowKey={(entry) => `${entry.connectionId}:${entry.platformUserId}`}
            empty="还没有平台账号管理员。"
          />
        )}
      </PropertyGroup>
      <AddAdministratorDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={() => {
          setAdding(false)
          void load()
        }}
      />
      <Dialog
        open={claim !== undefined}
        onOpenChange={(open) => !open && setClaim(undefined)}
        title="认领码"
        actions={<Button onClick={() => setClaim(undefined)}>完成</Button>}
      >
        <p className={styles.claimCode}>{claim?.code}</p>
        <p style={{ margin: 0 }}>
          在任意一个接入了 NekroNXT 的频道里，用你自己的账号发送 <code>/admin claim {claim?.code}</code>
          （群聊里先 @机器人）。10 分钟内有效，只能用一次；输错 5 次后作废。
        </p>
      </Dialog>
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={`移除管理员「${removing?.displayName ?? ''}」？`}
        confirmLabel="移除"
        danger
        onConfirm={async () => {
          if (!removing) return
          await callHostApi(
            HostApiContracts.removeAdministrator,
            {},
            { connectionId: removing.connectionId, platformUserId: removing.platformUserId },
          )
          toast('已移除')
          await load()
        }}
      >
        移除后这个账号不能再在聊天里管理扩展和确认请求；它在各频道单独获得的命令授权不受影响。
      </ConfirmDialog>
    </>
  )
}

function AddAdministratorDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onAdded: () => void
}) {
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<readonly Candidate[]>()
  const [busy, setBusy] = useState<string>()
  useEffect(() => {
    if (!open) return
    let live = true
    const timer = setTimeout(() => {
      callHostApi(
        HostApiContracts.listPlatformUsers,
        { ...(query.trim() ? { query: query.trim() } : {}), limit: 30 },
        undefined,
      )
        .then((result) => live && setCandidates(result.items))
        .catch(() => live && setCandidates([]))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, query])

  const add = async (candidate: Candidate) => {
    setBusy(candidate.identityId)
    try {
      await callHostApi(HostApiContracts.addAdministrator, {}, { identityId: candidate.identityId })
      toast(`已把「${candidate.displayName ?? '这个账号'}」设为管理员`)
      onAdded()
    } catch (error) {
      failure(error)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="添加管理员" wide>
      <SearchField value={query} onChange={setQuery} label="查找用户" placeholder="按昵称查找" />
      {candidates === undefined ? (
        <Skeleton height={80} />
      ) : candidates.length === 0 ? (
        <Banner tone="info">没有找到用户。只有在接入的频道里说过话的平台账号才会出现在这里。</Banner>
      ) : (
        <ul className={styles.pickList}>
          {candidates.map((candidate) => (
            <li key={candidate.identityId}>
              <MemberAvatar name={candidate.displayName ?? '?'} size="sm" />
              <span>
                <b>{candidate.displayName ?? '未命名'}</b>
                <small>
                  {candidate.connection.displayName}
                  {candidate.historicalOnly ? ' · 仅历史' : ` · ${candidate.activeChannelCount} 个频道`}
                </small>
              </span>
              {candidate.administrator ? (
                <Chip tone="accent">已是管理员</Chip>
              ) : (
                <Button size="small" busy={busy === candidate.identityId} onClick={() => void add(candidate)}>
                  设为管理员
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
