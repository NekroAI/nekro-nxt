import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Skeleton,
  SwitchRow,
  toast,
} from '../../ui-kit/index.js'
import { errorMessage, useCommunityStatus } from '../community/community-model.js'
import { feedbackScope, useFeedbackQuery } from '../community/feedback-model.js'
import styles from '../community/feedback.module.css'

export function FeedbackPrivacy() {
  return (
    <div className={styles.stack}>
      <p className={styles.prose}>
        反馈会发送到你登录的社区，包含正文、版本、运行环境和扩展诊断。对话摘录由你选择是否附上。
      </p>
      <p className={styles.prose}>
        反馈默认仅你、管理员和相关扩展作者可见；扩展作者只看到与其扩展有关的诊断，查看摘录需要你另行允许。管理员可以公开展示反馈的标题和处理状态。
      </p>
      <p className={styles.prose}>
        文本长期保留，诊断与摘录在结束处理 180 天后清除。你可以撤回反馈，并选择同时删除文本。
      </p>
    </div>
  )
}

export function FeedbackSettingsSection() {
  const community = useCommunityStatus()
  const scope = feedbackScope(community)
  const currentScope = useRef(scope)
  currentScope.current = scope
  const query = useFeedbackQuery(
    scope,
    (signal) => callHostApi(HostApiContracts.getCommunityFeedbackSettings, {}, undefined, { signal }),
    community.status !== undefined,
  )
  const [confirming, setConfirming] = useState(false)
  const [last, setLast] = useState<HostApiResponse<'getLastSentCommunityFeedbackPayload'>>()
  const [lastOpen, setLastOpen] = useState(false)
  const [lastScope, setLastScope] = useState('')
  const [showPrivacy, setShowPrivacy] = useState(false)
  useEffect(() => {
    setConfirming(false)
    setLastOpen(false)
    setLast(undefined)
  }, [scope])
  const view = query.data
  const update = async (enabled: boolean, consent = false) => {
    const result = await callHostApi(HostApiContracts.updateCommunityFeedbackSettings, {}, { enabled, consent })
    query.replace(result)
  }
  const showLast = async () => {
    try {
      const value = await callHostApi(HostApiContracts.getLastSentCommunityFeedbackPayload, {}, undefined)
      if (currentScope.current !== scope) return
      setLast(value)
      setLastScope(scope)
      setLastOpen(true)
    } catch (error) {
      toast(errorMessage(error), { tone: 'bad' })
    }
  }
  return (
    <div className={styles.stack}>
      <h1 className={styles.title}>社区反馈</h1>
      {community.error || query.error ? (
        <Banner
          tone="bad"
          action={
            <Button size="small" onClick={() => void query.refresh().catch(() => undefined)}>
              重试
            </Button>
          }
        >
          {community.error || query.error}
        </Banner>
      ) : null}
      {!view ? (
        <Skeleton height={88} />
      ) : (
        <>
          <PropertyGroup title="智能体工具">
            <SwitchRow
              title="启用社区反馈工具"
              checked={view.enabled}
              disabled={!view.supported || !view.signedIn}
              tip="开启后，智能体可以起草反馈，默认由你确认后发送。免确认提交需要在智能体的能力中单独开启。"
              onCheckedChange={(enabled) => {
                if (enabled && view.consentedAt === null) {
                  setConfirming(true)
                  return
                }
                return update(enabled).catch((error) => {
                  toast(errorMessage(error), { tone: 'bad' })
                })
              }}
            />
            {!view.supported ? (
              <Banner tone="info">当前社区不支持反馈。</Banner>
            ) : !view.signedIn ? (
              <Banner
                tone="info"
                action={
                  <Button
                    size="small"
                    onClick={() =>
                      void community.signIn().catch((error) => toast(errorMessage(error), { tone: 'bad' }))
                    }
                  >
                    登录社区
                  </Button>
                }
              >
                登录社区后可以开启。
              </Banner>
            ) : null}
          </PropertyGroup>
          <PropertyGroup title="社区账号">
            <PropertyList>
              <PropertyRow label="账号">{community.status?.account?.displayName ?? '未登录'}</PropertyRow>
              <PropertyRow label="社区地址">
                <span className={styles.muted}>{view.communityUrl}</span>
              </PropertyRow>
            </PropertyList>
          </PropertyGroup>
          <div className={styles.actions}>
            <Button onClick={() => void showLast()}>查看最近一次发送的内容</Button>
            <Button variant="ghost" onClick={() => setShowPrivacy((value) => !value)}>
              {showPrivacy ? '收起反馈说明' : '反馈说明'}
            </Button>
            {view.supported ? <Link to="/community/feedback">查看反馈</Link> : null}
          </div>
          {showPrivacy ? <FeedbackPrivacy /> : null}
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title="开启社区反馈工具"
            confirmLabel="同意并开启"
            onConfirm={() => update(true, true)}
          >
            <FeedbackPrivacy />
            <p className={styles.muted}>发送到 {view.communityUrl}</p>
          </ConfirmDialog>
        </>
      )}
      <Dialog
        open={lastOpen && lastScope === scope}
        onOpenChange={setLastOpen}
        title="最近一次发送的内容"
        closeLabel="关闭"
      >
        {last && lastScope === scope ? (
          <div className={styles.stack}>
            <p className={styles.muted}>
              {last.ref} · {new Date(last.sentAt).toLocaleString()}
            </p>
            <pre className={styles.payload}>{JSON.stringify(last.payload, null, 2)}</pre>
          </div>
        ) : (
          <p>还没有发送记录。</p>
        )}
      </Dialog>
    </div>
  )
}
