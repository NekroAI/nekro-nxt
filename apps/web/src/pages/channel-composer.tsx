import { memo, useLayoutEffect, useRef, type FormEvent } from 'react'
import { Info, Send } from 'lucide-react'
import { EMPTY_CHANNEL_DRAFT } from '../channel-drafts.js'
import {
  useProductRuntime,
  type ChannelSummary,
  type AgentSummary,
  type ConnectionSummary,
} from '../product-runtime.js'
import { useNxtNavigate } from '../shell/nxt-link.js'
import { notify } from '../components/notifications.js'
import { Button, IconButton, Textarea, Tooltip } from '../ui-kit/index.js'
import styles from './product-pages.module.css'

export const ChannelComposer = memo(function ChannelComposer({
  channel,
  agent,
  connection,
  webChannel,
  onResize,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly connection: ConnectionSummary | undefined
  readonly webChannel: ChannelSummary | undefined
  readonly onResize: () => void
}) {
  const runtime = useProductRuntime()
  const state = runtime.uiStore((state) => state.channelDrafts[channel.id] ?? EMPTY_CHANNEL_DRAFT)
  const draft = state.text
  const sendPending = state.pending !== undefined
  const navigate = useNxtNavigate()
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(onResize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [onResize])
  const setDraft = (text: string) => runtime.uiStore.getState().setChannelDraft(channel.id, text)
  const canSendOnWeb = channel.kind === 'internal' && Boolean(agent)
  const canSendAsRobot = channel.kind !== 'internal' && Boolean(agent && connection?.proactiveSend)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!(canSendOnWeb || canSendAsRobot)) return
    const token = runtime.uiStore.getState().beginChannelSend(channel.id)
    if (!token) return
    let success = false
    try {
      await runtime.store.getState().sendMessage(channel.id, token.text)
      success = true
    } catch (error) {
      notify(
        `发送失败：${error instanceof Error ? error.message : String(error)}。草稿已保留。`,
        'error',
        `channel-send:${channel.id}`,
      )
    } finally {
      runtime.uiStore.getState().finishChannelSend(channel.id, token.revision, token.request, success)
    }
  }
  const composerMode =
    channel?.kind === 'internal'
      ? agent
        ? '发给智能体'
        : '请先绑定智能体'
      : !agent
        ? '请先绑定智能体'
        : connection?.proactiveSend
          ? '发到频道'
          : '连接未允许主动发送'
  const composerExplanation =
    channel?.kind === 'internal'
      ? agent
        ? `内容会作为当前内置频道的入站消息交给“${agent.name}”。`
        : '请先绑定智能体，再将输入内容作为当前内置频道的入站消息。'
      : !agent
        ? `此频道来自“${channel?.connectionName ?? '当前连接'}”；请先绑定智能体，再以机器人账号发言。`
        : connection?.proactiveSend
          ? `“${channel?.connectionName ?? '当前连接'}”会向平台频道发出内容，并标记为管理员从客户端发出。`
          : `“${channel?.connectionName ?? '当前连接'}”尚未允许主动发送。`

  return (
    <div
      ref={ref}
      className={styles.composer}
      data-channel-composer
      data-mode={channel.kind === 'internal' ? 'internal' : 'platform'}
    >
      <form onSubmit={(event) => void submit(event)}>
        <Textarea
          className={styles.composerInput}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (draft.trim() && !sendPending) event.currentTarget.form?.requestSubmit()
          }}
          aria-label="消息内容"
          aria-describedby="channel-composer-mode"
          rows={1}
          placeholder={
            channel.kind === 'internal'
              ? agent
                ? '输入消息'
                : '请先绑定智能体'
              : canSendAsRobot
                ? '输入消息'
                : !agent
                  ? '请先绑定智能体'
                  : '当前连接不允许主动发言'
          }
          disabled={sendPending || (channel.kind === 'internal' ? !canSendOnWeb : !canSendAsRobot)}
        />
        <div className={styles.composerModeRow}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <span className={styles.composerInfo} tabIndex={0} role="img" aria-label="发送方式说明">
                <Info size={14} aria-hidden="true" />
              </span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content side="top" align="start" sideOffset={8} collisionPadding={12}>
                {composerExplanation}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          <span className={styles.composerMode}>{composerMode}</span>
          <span className={styles.composerModeSpacer} aria-hidden="true" />
          {channel.kind !== 'internal' && webChannel ? (
            <Button
              variant="ghost"
              size="small"
              className={styles.composerWebAction}
              onClick={() => void navigate(`/work/channels/${webChannel.id}`)}
            >
              去内置频道
            </Button>
          ) : null}
          <IconButton
            label={channel.kind === 'internal' ? '发送给智能体' : '发到频道'}
            className={styles.composerSend}
            type="submit"
            loading={sendPending}
            loadingLabel="发送中…"
            disabled={!draft.trim() || (channel.kind === 'internal' ? !canSendOnWeb : !canSendAsRobot)}
          >
            <Send size={14} aria-hidden="true" />
          </IconButton>
        </div>
        <span className={styles.srOnly} id="channel-composer-mode">
          {composerExplanation}
        </span>
      </form>
    </div>
  )
})
