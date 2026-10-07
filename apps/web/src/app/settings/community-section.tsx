import { useState } from 'react'
import { Banner, Button, ConfirmDialog, PropertyGroup, PropertyList, PropertyRow, toast } from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { openExternal, useCommunityStatus } from '../community/community-model.js'
import styles from './settings.module.css'

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

/** 本实例登录的社区账号：用于发布扩展。浏览与安装社区扩展不需要登录。 */
export function CommunitySection() {
  const community = useCommunityStatus()
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [busy, setBusy] = useState(false)
  const status = community.status
  const account = status?.account ?? null

  const signIn = async () => {
    setBusy(true)
    try {
      await community.signIn()
    } catch (error) {
      failure(error)
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return community.error ? (
      <Banner tone="bad">{community.error}</Banner>
    ) : (
      <p className={styles.notice}>正在读取社区账号…</p>
    )
  }

  return (
    <>
      <PropertyGroup
        title={account ? '已登录' : '未登录'}
        description={
          account
            ? '这个实例可以用你的社区账号发布扩展、查看审查结果。'
            : '登录后可以把扩展发布到社区并查看审查结果。浏览和安装社区扩展不需要登录。'
        }
      >
        <PropertyList>
          {account ? (
            <>
              <PropertyRow label="账号">
                <span>
                  {account.displayName}（@{account.handle}）
                </span>
              </PropertyRow>
              {status.signedInAt !== null ? (
                <PropertyRow label="登录时间">
                  <span className={styles.faint}>{relativeTime(status.signedInAt)}</span>
                </PropertyRow>
              ) : null}
            </>
          ) : null}
          <PropertyRow label="社区地址">
            <span className={styles.faint}>{status.communityUrl}</span>
          </PropertyRow>
        </PropertyList>
      </PropertyGroup>
      {community.waiting && !account ? (
        <Banner tone="info">已在浏览器中打开社区授权页。在那里同意授权后，这里会自动更新。</Banner>
      ) : null}
      <div className={styles.actions}>
        {account ? (
          <>
            <Button onClick={() => openExternal(`${status.communityUrl}/me`)}>在社区查看我的扩展</Button>
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
            failure(error)
          }
        }}
      >
        <p>这个实例会删除保存的社区凭据，并在社区撤销授权。已经安装的社区扩展不受影响。</p>
      </ConfirmDialog>
    </>
  )
}
