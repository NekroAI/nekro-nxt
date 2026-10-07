import { UserRound } from 'lucide-react'
import { useState } from 'react'
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  MainContent,
  ObjectHeader,
  PropertyList,
  Pressable,
  PropertyRow,
  Skeleton,
  toast,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { ENVIRONMENT_LABEL, errorMessage, openExternal, type CommunityState } from './community-model.js'
import styles from './community.module.css'
import { CommunityEndpointDialog } from './endpoint-dialog.js'

/** 本实例登录的社区账号；登录用于发布扩展与查看审查结果，浏览和安装不需要登录。 */
export function AccountView({ community }: { readonly community: CommunityState }) {
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [editingEndpoint, setEditingEndpoint] = useState(false)
  const [busy, setBusy] = useState(false)
  const status = community.status
  const account = status?.account ?? null

  const signIn = async () => {
    setBusy(true)
    try {
      await community.signIn()
    } catch (error) {
      toast(errorMessage(error), { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return (
      <MainContent width="readable">
        {community.error ? <Banner tone="bad">{community.error}</Banner> : <Skeleton height={160} />}
      </MainContent>
    )
  }

  return (
    <MainContent width="readable">
      <ObjectHeader
        visual={
          account?.avatarUrl ? (
            <img src={account.avatarUrl} alt="" className={styles.objectGlyph} />
          ) : (
            <span className={styles.objectGlyph}>
              <UserRound size={22} />
            </span>
          )
        }
        title={account ? account.displayName : '社区账号'}
        status={account ? <Chip tone="ok">已登录</Chip> : <Chip>未登录</Chip>}
        meta={account ? <span>@{account.handle}</span> : <span>登录后可以发布扩展并查看审查结果</span>}
      />
      {community.waiting && !account ? (
        <Banner tone="info">已在浏览器中打开社区授权页。在那里同意授权后，这里会自动更新。</Banner>
      ) : null}
      {account && status.signedInAt !== null ? (
        <PropertyList>
          <PropertyRow label="登录时间">
            <span className={styles.faint}>{relativeTime(status.signedInAt)}</span>
          </PropertyRow>
        </PropertyList>
      ) : null}
      <div className={styles.inline}>
        {account ? (
          <>
            <Button onClick={() => openExternal(`${status.communityUrl}/me`)}>在社区网站打开</Button>
            <Button variant="ghost" onClick={() => setConfirmSignOut(true)}>
              退出登录
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" busy={busy} onClick={() => void signIn()}>
              {community.waiting ? '重新打开授权页' : '登录社区'}
            </Button>
            {community.waiting ? (
              <Button variant="ghost" onClick={community.cancelWaiting}>
                取消
              </Button>
            ) : null}
          </>
        )}
      </div>
      {/* 地址只有少数开发成员需要更改，放在页面最下方的一行小字里。 */}
      <p className={styles.endpointLine}>
        <span>社区地址 {status.communityUrl.replace(/^https:\/\//u, '')}</span>
        {status.environment && status.environment !== 'production' ? (
          <Chip tone="warn">{ENVIRONMENT_LABEL[status.environment]}</Chip>
        ) : null}
        {status.environment === null ? <Chip tone="bad">无法连接</Chip> : null}
        <Pressable type="button" className={styles.quietLink} onClick={() => setEditingEndpoint(true)}>
          更改
        </Pressable>
      </p>
      <CommunityEndpointDialog
        open={editingEndpoint}
        onOpenChange={setEditingEndpoint}
        onChanged={() => void community.refresh()}
      />
      <ConfirmDialog
        open={confirmSignOut}
        onOpenChange={setConfirmSignOut}
        title="退出社区登录？"
        confirmLabel="退出登录"
        onConfirm={async () => {
          setConfirmSignOut(false)
          try {
            await community.signOut()
            toast('已退出社区登录')
          } catch (error) {
            toast(errorMessage(error), { tone: 'bad' })
          }
        }}
      >
        <p>这个实例会删除保存的社区凭据，并在社区撤销授权。已经安装的社区扩展不受影响。</p>
      </ConfirmDialog>
    </MainContent>
  )
}
